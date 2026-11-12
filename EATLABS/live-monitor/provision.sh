#!/usr/bin/env bash
# WHAT: takes a freshly launched g6e box from nothing to a ringing phone line, from the laptop.
# ROLE: everything that was done by hand on 2 Nov, in order, with the mistakes already made and fixed:
#
#       - redirects run INSIDE the root shell. `sudo cmd > /root/...` redirects as the LOGIN user and fails
#         with "Permission denied"; `sudo bash -c "cmd > /root/..."` is what works.
#       - detached processes use `setsid nohup ... < /dev/null & disown`, or ssh holds the channel open and
#         the whole command appears to hang.
#       - the worker is started as `python -m agent.lk.worker`, never through runpy. LiveKit pickles its
#         entrypoint by module+name for the forkserver children, and under runpy the module is "__main__",
#         which the child cannot look up: every call then fails with PicklingError. The monitor attaches
#         through sitecustomize.py on PYTHONPATH instead, which also reaches the job subprocesses, where
#         CallSession actually lives.
#       - python3.12 is installed and shimmed. The Deep Learning AMI is Ubuntu 26.04 / Python 3.14, and
#         vllm, ctranslate2 and parler-tts have no 3.14 wheels. The scripts call bare `python3`, so a
#         symlink on PATH is enough; the system python3 that apt needs is left alone.
#
#   bash provision.sh <ip>
#
# Stops when bootstrap_live.sh reaches the point where it needs the two secret files. Write those, then run
# make-live.sh for the rest.

set -euo pipefail
IP=${1:?usage: bash provision.sh <public-ip>}
KEY=${KEY:-/c/Users/PRATHA~1/.ssh/eatlabs-gpu.pem}
REPO=${REPO:-"E:/WEBWORKS CO/EATLABS/VOICE AGENT"}
HERE=$(cd "$(dirname "$0")" && pwd)
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15)
SCP=(scp -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)

say() { printf '\n== %s\n' "$*"; }

say "waiting for ssh on $IP"
until "${SSH[@]}" -o BatchMode=yes ubuntu@"$IP" true 2>/dev/null; do sleep 10; done

say "waiting for cloud-init (it installs the auto-stop cost brake first)"
until "${SSH[@]}" ubuntu@"$IP" 'sudo cloud-init status 2>/dev/null' | grep -qE 'status: (done|error)'; do sleep 15; done
"${SSH[@]}" ubuntu@"$IP" 'systemctl is-active voice-agent-autostop.timer || echo "WARNING: no auto-stop timer - this box can bill all night"'

say "the GPU"
"${SSH[@]}" ubuntu@"$IP" 'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader'

say "python 3.12 and the PATH shim"
"${SSH[@]}" ubuntu@"$IP" 'set -e
  sudo voice-agent-hold 12 >/dev/null
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update -qq
  sudo apt-get install -y -qq python3.12 python3.12-venv python3.12-dev build-essential ninja-build jq >/dev/null
  sudo mkdir -p /opt/py312 && sudo ln -sf /usr/bin/python3.12 /opt/py312/python3
  PATH=/opt/py312:$PATH python3 -V'

say "the repo (tracked files AS THEY ARE ON DISK: no venv, no .env, no secrets)"
# `git archive HEAD` was wrong here and shipped a box running the last COMMIT: every uncommitted change -
# the crosstalk detector, the all-female voices, the expanded warm list, the new catalogue line - stayed on
# the laptop, while --status cheerfully reported six services up. It was running the right stack and the
# wrong code, which is the hardest kind of wrong to notice.
#
# `git ls-files` gives the same file list (so still no .venv, no .hypothesis, no caches, and no .env -
# it is gitignored) but tar reads each one from the WORKING TREE, so uncommitted edits travel too.
TAR=$(mktemp -u /tmp/repo-XXXX.tar.gz)
( cd "$REPO" && git ls-files -z | tar --null -czf "$TAR" -T - )
"${SCP[@]}" "$TAR" ubuntu@"$IP":/tmp/repo.tar.gz >/dev/null
rm -f "$TAR"
"${SSH[@]}" ubuntu@"$IP" 'sudo mkdir -p /root/voice-agent && sudo tar xzf /tmp/repo.tar.gz -C /root/voice-agent && echo "extracted"'

say "the monitor"
"${SCP[@]}" "$HERE/server.py" "$HERE/index.html" "$HERE/live_shim.py" "$HERE/sitecustomize.py" \
            "$HERE/run_worker.py" "$HERE/make-live.sh" ubuntu@"$IP":/tmp/ >/dev/null
"${SSH[@]}" ubuntu@"$IP" 'sudo mkdir -p /root/live-monitor
  sudo cp /tmp/server.py /tmp/index.html /tmp/live_shim.py /tmp/sitecustomize.py /tmp/run_worker.py /tmp/make-live.sh /root/live-monitor/
  sudo chmod 755 /root/live-monitor/make-live.sh && echo "monitor files in place"'

say "bootstrap_live.sh (about ten minutes: 45 GB of weights)"
"${SSH[@]}" ubuntu@"$IP" 'sudo bash -c "mkdir -p /root/live
  export PATH=/opt/py312:\$PATH
  setsid nohup bash /root/voice-agent/infra/aws/bootstrap_live.sh > /root/live/bootstrap.log 2>&1 < /dev/null & disown
  echo started"'

cat <<EOF

Building. Watch it with:
  ssh -i "$KEY" ubuntu@$IP 'sudo tail -f /root/live/bootstrap.log'

It will stop at "7/7 waiting for the two private files" and poll every five seconds. Write them:

  ssh -i "$KEY" ubuntu@$IP
  read -rs TOKEN && printf '%s' "\$TOKEN" | sudo install -m 600 /dev/stdin /root/.hf_token && unset TOKEN
  sudo install -m 600 /dev/stdin /root/livekit_cloud.env <<'ENV'
  LIVEKIT_URL=wss://<project>.livekit.cloud
  LIVEKIT_API_KEY=...
  LIVEKIT_API_SECRET=...
  ENV

The Hugging Face account must already have accepted the terms on ai4bharat/indic-parler-tts.
Then, for the number map, the UI and the monitored worker:

  ssh -i "$KEY" ubuntu@$IP 'sudo bash /root/live-monitor/make-live.sh'
EOF
