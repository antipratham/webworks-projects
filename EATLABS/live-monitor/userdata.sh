#!/usr/bin/env bash
# user-data: the cost brake ONLY, installed before anything else - the same ordering and the same script as
# infra/aws/bootstrap_box.sh uses, so an unattended launch can never run up a bill.
exec > /var/log/voice-agent-bootstrap.log 2>&1
set -eux

mkdir -p /usr/local/sbin /var/lib/voice-agent
cat > /usr/local/sbin/voice-agent-autostop <<'AUTOSTOP'
#!/usr/bin/env bash
# WHAT: powers this server off when it has been idle for 30 minutes, and every night at 23:00 IST.
# ROLE: the cost brake for the AWS test environment (D-079, D-080, D-083). Runs every 5 minutes from a
#       systemd timer on each box. Uses nothing AWS-specific: boxes are launched with
#       InstanceInitiatedShutdownBehavior=terminate, so an OS shutdown DELETES the box and its disk and all
#       billing ends. Anything worth keeping must already be on GitHub or copied off.
#
# "Active" means any of: someone logged in over SSH, the GPU busier than 5%, or the 1-minute load average
# above 1.0 (a test run). Hold it on for a long job with:   sudo voice-agent-hold 3     (hours)

set -u

IDLE_MINUTES=30
NIGHT_START_HOUR=23        # IST
NIGHT_END_HOUR=7           # IST
STATE=${VOICE_AGENT_STATE:-/var/lib/voice-agent}   # overridable only so the logic can be tested off-box
LAST=$STATE/last_activity
HOLD=$STATE/hold_until
mkdir -p "$STATE"

now=$(date +%s)
[ -f "$LAST" ] || echo "$now" > "$LAST"

# A hold (set by voice-agent-hold) suspends both rules until it expires.
if [ -f "$HOLD" ] && [ "$(cat "$HOLD")" -gt "$now" ]; then
    echo "$now" > "$LAST"
    exit 0
fi

active=no
ssh_sessions=$(who | wc -l)
[ "$ssh_sessions" -gt 0 ] && active=yes

if command -v nvidia-smi >/dev/null 2>&1; then
    gpu=$(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null | sort -n | tail -1)
    [ -n "$gpu" ] && [ "$gpu" -gt 5 ] && active=yes
fi

load=$(cut -d' ' -f1 /proc/loadavg)
awk -v l="$load" 'BEGIN { exit !(l > 1.0) }' && active=yes

[ "$active" = yes ] && echo "$now" > "$LAST"

# Night stop - regardless of activity, unless a hold is set.
hour=$(TZ=Asia/Kolkata date +%H | sed 's/^0//')
if [ "$hour" -ge "$NIGHT_START_HOUR" ] || [ "$hour" -lt "$NIGHT_END_HOUR" ]; then
    logger -t voice-agent-autostop "night stop at $(TZ=Asia/Kolkata date +%H:%M) IST"
    shutdown -h now "voice-agent autostop: night"
    exit 0
fi

idle_for=$(( (now - $(cat "$LAST")) / 60 ))
if [ "$idle_for" -ge "$IDLE_MINUTES" ]; then
    logger -t voice-agent-autostop "idle for ${idle_for} min, stopping"
    shutdown -h now "voice-agent autostop: idle ${idle_for} min"
fi
AUTOSTOP
chmod 755 /usr/local/sbin/voice-agent-autostop
date +%s > /var/lib/voice-agent/last_activity

cat > /usr/local/sbin/voice-agent-hold <<'HOLD'
#!/usr/bin/env bash
hours=${1:-2}
echo $(( $(date +%s) + hours * 3600 )) > /var/lib/voice-agent/hold_until
echo "auto-stop held for $hours hour(s)"
HOLD
chmod 755 /usr/local/sbin/voice-agent-hold

cat > /etc/systemd/system/voice-agent-autostop.service <<'UNIT'
[Unit]
Description=voice-agent auto-stop check
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/voice-agent-autostop
UNIT
cat > /etc/systemd/system/voice-agent-autostop.timer <<'UNIT'
[Unit]
Description=voice-agent auto-stop check every 5 minutes
[Timer]
OnBootSec=10min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now voice-agent-autostop.timer

# A freshly launched box gets 2 hours whatever the clock says. Without this a launch inside the 23:00-07:00
# night window would shut down ten minutes after boot, and an unattended retry would loop on that.
/usr/local/sbin/voice-agent-hold 2
