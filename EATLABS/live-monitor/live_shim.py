# WHAT: sends every line of a live call to the monitor page, from inside the worker's own process.
# ROLE: the bridge between the voice agent and server.py, and the reason neither file in the repo had to
#       change. It patches three things on import:
#
#         CallSession.said()          every GUEST and AGENT line, as it is appended to the transcript
#         CallSession.set_language()  the language the call settled on
#         tools.run()                 what the platform was actually asked to do, and how long it took
#
#       Two rules it must never break, both learned the hard way in the repo's own history:
#
#       1. It must not block the event loop. D-120 found a 122 ms stall audible on a live call, and D-129
#          moved every platform call off the loop for the same reason. So nothing here does I/O inline: the
#          event goes on a queue and a daemon thread posts it.
#       2. It must not raise into the call path. A monitor that throws would end a real phone call, so every
#          patched function is wrapped and every exception is swallowed. A dropped line on a dev page costs
#          nothing; an exception costs the call.
#
# Used by run_worker.py. Not imported by anything in the repo.

import json
import os
import queue
import threading
import time
import urllib.error
import urllib.request

MONITOR_URL = os.environ.get("MONITOR_URL", "http://127.0.0.1:3100/api/event")
_queue = queue.Queue(maxsize=2000)
_started = False
_installed = False


def _pump():
    """The only thread that talks to the monitor. A monitor that is not running, or has gone away, must not
    slow the call down or fill the log, so a failed post is dropped in silence."""
    while True:
        event = _queue.get()
        try:
            body = json.dumps(event, ensure_ascii=False).encode("utf-8")
            request = urllib.request.Request(MONITOR_URL, data=body, method="POST",
                                             headers={"Content-Type": "application/json"})
            urllib.request.urlopen(request, timeout=2).close()
        except (urllib.error.URLError, OSError, ValueError, TypeError):
            pass
        finally:
            _queue.task_done()


def _send(kind, **fields):
    global _started
    try:
        if not _started:
            _started = True
            threading.Thread(target=_pump, name="monitor-pump", daemon=True).start()
        fields["kind"] = kind
        fields["at"] = time.time()
        _queue.put_nowait(fields)
    except queue.Full:
        pass                                    # the monitor is behind: skip this one, never block the call
    except Exception:
        pass


def _call_facts(call):
    # Only what the page shows. No full phone number: the repo masks those everywhere (D-121, brief 1.5),
    # and a dev page is no reason to start printing them.
    try:
        caller = getattr(call, "caller", None) or ""
        return {
            "call_id": getattr(call, "call_id", None),
            "outlet_id": getattr(call, "outlet_id", None),
            "dialled": getattr(call, "dialled", None),
            "caller_tail": caller[-4:] if caller else None,
            "lang": getattr(call, "lang", None),
        }
    except Exception:
        return {}


def install():
    """Patch the session and the tool door. Safe to call twice; does nothing the second time."""
    global _installed
    if _installed:
        return
    _installed = True

    from agent import tools
    from agent.session import CallSession

    # ---- every line of the dialogue, as it lands on the transcript ----
    original_said = CallSession.said

    def said(self, role, text, source=None):
        original_said(self, role, text, source)
        try:
            if text:
                _send("line", role=role, text=text, source=source,
                      turn=getattr(self, "turn_index", None), **_call_facts(self))
        except Exception:
            pass

    CallSession.said = said

    # ---- the language the call settled on ----
    original_set_language = CallSession.set_language

    def set_language(self, lang):
        original_set_language(self, lang)
        try:
            _send("language", lang=lang, **_call_facts(self))
        except Exception:
            pass

    CallSession.set_language = set_language

    # ---- what the platform was asked to do, and how long it took ----
    # agent/tools.py is the single door every tool goes through, so one patch sees them all.
    original_run = tools.run

    def run(session, name, args=None):
        began = time.monotonic()
        try:
            result = original_run(session, name, args)
        except Exception as e:
            try:
                _send("tool", name=name, args=args or {}, error=type(e).__name__,
                      ms=round((time.monotonic() - began) * 1000), **_call_facts(session))
            except Exception:
                pass
            raise
        try:
            keys = sorted(result.keys()) if isinstance(result, dict) else None
            _send("tool", name=name, args=args or {}, result_keys=keys,
                  ms=round((time.monotonic() - began) * 1000),
                  turn=getattr(session, "turn_index", None), **_call_facts(session))
        except Exception:
            pass
        return result

    tools.run = run

    # ---- the call ending, so the page can close the turn off ----
    for ending in ("finish", "hang_up"):
        original_end = getattr(CallSession, ending)

        def make(original, which):
            def end(self, *a, **kw):
                outcome = original(self, *a, **kw)
                try:
                    _send("end", how=which, end_reason=getattr(self, "end_reason", None),
                          **_call_facts(self))
                except Exception:
                    pass
                return outcome
            return end

        setattr(CallSession, ending, make(original_end, ending))

    _send("monitor", note="attached to the worker")
