#!/usr/bin/env bash
# WHAT: the last mile, run ON THE BOX as root once bootstrap_live.sh has the two secret files.
# ROLE: the three things that were box-only on 2 Nov and were therefore lost when the box terminated. Two
#       of them failed silently rather than loudly, which is why they are a script now and not a checklist:
#
#       1. The number map. bootstrap_live.sh picks the restaurant AT RANDOM ("blind", so a scripted caller
#          cannot know who answers). Left alone, the line lands on whichever of the twenty came up. This
#          pins it to one.
#       2. The monitor UI, served from the box so the event path never crosses the network.
#       3. The worker, restarted with the monitor attached. bootstrap_live.sh and its own --restart-worker
#          both start the PLAIN worker, so this has to run after either of them or the UI shows nothing.
#
#       The voice is no longer here: every outlet in the dataset is WARM_FEMALE in the repo, including
#       amber-fig's manager setting, so it arrives correct and cannot drift.
#
#   sudo bash /root/live-monitor/make-live.sh                 # amber-fig, the default
#   sudo OUTLET=kodava-hearth bash /root/live-monitor/make-live.sh
#
# Safe to re-run.

set -uo pipefail
REPO=/root/voice-agent
LIVE=/root/live
OUTLET=${OUTLET:-amber-fig}
PORT=${PORT:-9800}
DIALLED=${DIALLED:-+918035341522}

say() { printf '\n== %s\n' "$*"; }

[ -d "$REPO" ] || { echo "no $REPO - run provision.sh first"; exit 1; }

say "number map: $DIALLED -> $OUTLET"
VIRTUAL=$(cd "$REPO" && python3 - "$OUTLET" <<'PY'
import json, sys
outlet = sys.argv[1]
for row in json.load(open("data/numbers.json"))["numbers"]:
    if row["outlet_id"] == outlet and row["source"] == "CALL_AI":
        print(row["number"]); break
else:
    raise SystemExit("no CALL_AI number for %s" % outlet)
PY
)
[ -n "$VIRTUAL" ] || { echo "could not resolve $OUTLET"; exit 1; }
printf 'NUMBER_MAP=%s=%s\n' "$DIALLED" "$VIRTUAL" > "$LIVE/number_map.env"
chmod 600 "$LIVE/number_map.env"
echo "  $DIALLED -> $VIRTUAL ($OUTLET)"

say "the voice the platform will actually serve"
curl -sf "http://127.0.0.1:8080/outlets/$OUTLET/voice-config" -H "Authorization: Bearer dev-service-token" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("  %s | voice %s | status %s | %s" % (d.get("outlet_name"),d.get("voice"),d.get("status"),d.get("languages")))' \
  || echo "  (platform not up yet - check after the bootstrap finishes)"

say "monitor UI on 127.0.0.1:$PORT"
pkill -f "server.py --port $PORT" || true
sleep 2
cd /root/live-monitor && REPO_DIR=$REPO NUMBER_MAP_FILE=$LIVE/number_map.env \
  setsid nohup python3 server.py --port "$PORT" --host 127.0.0.1 > "$LIVE/monitor-ui.log" 2>&1 < /dev/null &
disown
sleep 3
curl -sf "http://127.0.0.1:$PORT/api/mapped" >/dev/null && echo "  up" || echo "  FAILED - see $LIVE/monitor-ui.log"

say "worker, with the monitor attached"
pkill -f 'agent.lk.worke[r]' || true
pkill -f 'run_worker.p[y]' || true
sleep 3
set -a; . /root/livekit_cloud.env; . "$LIVE/number_map.env"; set +a
cd "$REPO" || exit 1
PLATFORM_URL=http://127.0.0.1:8080 \
HF_HOME=/mnt/models/hf \
NOISE_CANCELLATION=telephony \
VOICE_RECORD_DIR="$LIVE/calls" \
NUMBER_MAP="$NUMBER_MAP" \
LIVEKIT_URL="$LIVEKIT_URL" LIVEKIT_API_KEY="$LIVEKIT_API_KEY" LIVEKIT_API_SECRET="$LIVEKIT_API_SECRET" \
PYTHONPATH=/root/live-monitor REPO_DIR="$REPO" \
MONITOR_URL="http://127.0.0.1:$PORT/api/event" \
  setsid nohup /root/.venv-app/bin/python -m agent.lk.worker start > "$LIVE/worker.log" 2>&1 < /dev/null &
disown

for _ in $(seq 1 24); do grep -q "registered worker" "$LIVE/worker.log" 2>/dev/null && break; sleep 5; done

say "state"
# --status greps for agent.lk.worker, which this does run, so its worker line is honest.
bash "$REPO/infra/aws/bootstrap_live.sh" --status 2>&1 | tail -8
printf '  registered   %s\n' "$(grep -c 'registered worker' "$LIVE/worker.log" 2>/dev/null)"
printf '  PicklingError %s   (must be 0: if not, the worker is not running as -m agent.lk.worker)\n' \
       "$(grep -c PicklingError "$LIVE/worker.log" 2>/dev/null)"
printf '  monitor attach events %s   (parent + job subprocesses)\n' \
       "$(curl -sf "http://127.0.0.1:$PORT/api/state" | python3 -c 'import sys,json;print(sum(1 for e in json.load(sys.stdin)["events"] if e.get("kind")=="monitor"))' 2>/dev/null)"

cat <<EOF

To see it from the laptop, forward the port and open http://127.0.0.1:$PORT
  ssh -i ~/.ssh/eatlabs-gpu.pem -L $PORT:127.0.0.1:$PORT -N ubuntu@<ip>
EOF
