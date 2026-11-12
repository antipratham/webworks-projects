# WHAT: attaches the monitor shim to EVERY Python process in the worker, including the job subprocesses
#       LiveKit forks for each call.
# ROLE: the replacement for the launcher that used runpy, which was wrong twice over:
#
#       1. It broke the worker outright. LiveKit's process pool pickles the `entrypoint` function by
#          reference (module + name) to hand it to a forkserver child. Running agent.lk.worker through
#          runpy makes that function's __module__ be "__main__", so the child's lookup failed with
#          `PicklingError: attribute lookup entrypoint on __main__ failed`, on every incoming call.
#
#       2. It patched the wrong process. CallSession is built inside the job subprocess, not the parent,
#          so a patch applied only in the parent would never have seen a single line of dialogue.
#
#       Python imports `sitecustomize` automatically at interpreter start-up for any process whose
#       PYTHONPATH contains this directory - parent and forked children alike. So the worker runs exactly
#       as the repo intends (`python -m agent.lk.worker start`), and the patch rides along.
#
#   PYTHONPATH=/root/live-monitor MONITOR_URL=http://127.0.0.1:9800/api/event \
#     /root/.venv-app/bin/python -m agent.lk.worker start
#
# Nothing here may raise. This file runs before the interpreter is fully up, in every process that sees it,
# so an exception would not break the monitor - it would break Python.

import os
import sys

# Opt-in: without MONITOR_URL this file does nothing at all, so the directory can stay on PYTHONPATH
# harmlessly and a normal worker is completely unaffected.
if os.environ.get("MONITOR_URL"):
    try:
        # agent/ has to be importable before live_shim can patch it. The worker is started from the repo
        # root, but site-packages initialisation runs before the cwd is on sys.path, so put it there.
        _repo = os.environ.get("REPO_DIR") or "/root/voice-agent"
        if os.path.isdir(os.path.join(_repo, "agent")) and _repo not in sys.path:
            sys.path.insert(0, _repo)

        import live_shim

        live_shim.install()
    except Exception:
        # A monitor that cannot attach is a non-event: the call must still go through. Deliberately silent -
        # printing here would land in the middle of the worker's own structured log.
        pass
