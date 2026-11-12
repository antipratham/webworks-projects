# WHAT: starts the normal LiveKit worker with the monitor attached.
# ROLE: a convenience wrapper. It sets two environment variables and then REPLACES itself with the ordinary
#       worker command, so the process LiveKit sees is exactly `python -m agent.lk.worker <args>` - the same
#       thing infra/aws/bootstrap_live.sh runs.
#
#       The replacing matters. An earlier version of this file imported the shim and then called
#       runpy.run_module("agent.lk.worker", run_name="__main__"). That broke every call: LiveKit hands its
#       `entrypoint` function to a forkserver child by pickling it as module+name, and under runpy the
#       module was "__main__", which the child cannot look up -
#       `PicklingError: attribute lookup entrypoint on __main__ failed`. It also patched only the parent,
#       while CallSession actually lives in the job subprocess. sitecustomize.py fixes both: it rides in on
#       PYTHONPATH and attaches in every process, parent and child.
#
#   cd /root/voice-agent
#   /root/.venv-app/bin/python /root/live-monitor/run_worker.py start
#
# Equivalent, if you would rather not use this wrapper at all:
#
#   PYTHONPATH=/root/live-monitor MONITOR_URL=http://127.0.0.1:9800/api/event \
#     /root/.venv-app/bin/python -m agent.lk.worker start

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.abspath(os.environ.get("REPO_DIR", os.path.join(HERE, "..", "VOICE AGENT")))
MONITOR_URL = os.environ.get("MONITOR_URL", "http://127.0.0.1:9800/api/event")

# sitecustomize.py must be importable by this process AND by every child LiveKit forks, so it goes on
# PYTHONPATH rather than being imported here.
path = [p for p in (os.environ.get("PYTHONPATH") or "").split(os.pathsep) if p]
if HERE not in path:
    path.insert(0, HERE)

os.environ["PYTHONPATH"] = os.pathsep.join(path)
os.environ["MONITOR_URL"] = MONITOR_URL
os.environ["REPO_DIR"] = REPO_DIR

if __name__ == "__main__":
    print("monitor: attaching in every worker process; events -> %s" % MONITOR_URL, flush=True)
    # execv, not import: the worker must own this process so that `entrypoint` belongs to
    # agent.lk.worker and pickles correctly for the forkserver children.
    os.execv(sys.executable, [sys.executable, "-m", "agent.lk.worker"] + sys.argv[1:])
