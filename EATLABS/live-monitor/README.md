# Call monitor — a live window on one phone call

A development page for watching a call as it happens: the dialogue on the right, the knowledge base of the
restaurant whose number was dialled on the left, and the gap before each reply so you can see the silence
the caller actually sits through.

**This is not part of the voice agent.** It lives outside the repo, nothing in `agent/` imports it, and the
repo needs no edits to use it. Delete this folder and the agent is unchanged.

```
live-monitor/
  server.py       the page and its API            stdlib only, no pip install
  live_shim.py    patches the call session to post each line as it lands
  run_worker.py   starts the normal worker with the shim attached
  index.html      the page
```

## Run it

Two terminals.

**1. the monitor**

```bash
cd "E:/WEBWORKS CO/EATLABS/live-monitor"
python server.py                      # http://127.0.0.1:3100
```

It reads the restaurants straight off disk from `../VOICE AGENT/data/restaurants/`. If the repo is
somewhere else:

```bash
REPO_DIR="/path/to/VOICE AGENT" python server.py --port 3100
```

**2. the worker, with the monitor attached**

Where you would normally run `python -m agent.lk.worker dev`, run this instead — same arguments, same
LiveKit CLI:

```bash
cd "E:/WEBWORKS CO/EATLABS/VOICE AGENT"
./.venv/Scripts/python.exe ../live-monitor/run_worker.py dev
```

Then open <http://127.0.0.1:3100> and place a call.

If the monitor is not running, the worker is unaffected — the posts fail silently and the call goes on.

## What you see

| Row | Meaning |
|---|---|
| **CALLER** | what speech-to-text heard — the agent's actual input, not what was said |
| **AGENT** | a catalogue line, spoken word for word from `agent/strings/*.json` |
| **MODEL** | worded by the language model (`source="model"` on the transcript) |
| **TOOL** | what the platform was asked to do, with how long it took |
| **SYS** | the language being adopted, and the call ending |

The figure on the right of each row is the gap since the line before it. It turns red past 1.5 s. Measured
from the caller's line, that is the dead air before the agent answers — the number to watch when tuning
latency (see D-131: TTS pacing alone is 1.2 s on a short reply and 3–4 s on a long one).

`Follow call` keeps the left pane on whichever outlet the live call dialled. Picking a restaurant by hand
turns following off.

## How it gets the lines

`live_shim.py` patches four things in the worker's own process, on import:

| Patched | Gives |
|---|---|
| `CallSession.said()` | every GUEST and AGENT line, as it is appended to the transcript |
| `CallSession.set_language()` | the language the call settled on |
| `tools.run()` | every platform call and its duration — it is the single door all tools go through |
| `CallSession.finish()` / `.hang_up()` | the call ending and why |

Two things it is careful about, both from the repo's own history:

- **It never blocks the event loop.** D-120 found a 122 ms stall audible on a live call, and D-129 moved
  every platform call off the loop for that reason. Events go on a queue; one daemon thread posts them.
- **It never raises into the call path.** Every patch is wrapped and every exception swallowed. A dropped
  line on a dev page costs nothing; an exception would end a real phone call.

No full phone numbers are sent — only the last four digits of the caller, the same way the repo masks them
everywhere else (D-121, brief 1.5).

## Not to be confused with

`tools/transcript_ui/` **in the repo** does a different job: it reads the finished JSON records that
`write_voice_record()` leaves behind *after* a call, so it is for reviewing a session afterwards. This one
is live, and adds the knowledge-base pane.
