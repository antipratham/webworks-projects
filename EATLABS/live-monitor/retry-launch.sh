#!/usr/bin/env bash
# Waits for g6e (L40S) capacity in Mumbai and launches the moment it appears.
#
# Every launch carries userdata.sh, which installs the auto-stop timer BEFORE anything else and then holds
# the box for 2 hours. So a box that comes up while nobody is watching terminates itself rather than
# billing all night: shutdown-behavior=terminate means the OS shutdown deletes it and billing ends.
#
# Stops on the first success, or after MAX_HOURS.

set -u
cd "$(dirname "$0")"

REGION=ap-south-1
AMI=ami-0ddca4a2288869748           # Deep Learning OSS Nvidia Driver AMI GPU PyTorch 2.13 (Ubuntu 26.04)
KEY=eatlabs-gpu
SG=sg-0b3d3c52d6c541523
SUBNET_A=subnet-0dff5dfe1e4cf32be   # ap-south-1a
SUBNET_B=subnet-06142733626586b9b   # ap-south-1b
EVERY=180                           # seconds between sweeps
MAX_HOURS=12
LOG=retry-launch.log

# Largest first. Both are 1x L40S 48 GB; the 2xlarge has 4 physical cores against the xlarge's 2, which
# matters because Parler's per-token loop is bound to one core (D-131). 8 vCPU is the whole quota, so
# nothing bigger can be asked for, and g6e is offered in 1a and 1b only - not 1c - so these are every pool
# there is on demand.
#
# Spot comes last, and only g6e.xlarge: the spot G quota is 4 vCPU, which is exactly that instance. Spot is
# a SEPARATE capacity pool, so it is worth asking when on-demand has none - it was about 40% cheaper when
# last checked. The cost of taking it: AWS can reclaim the box at two minutes' notice, and since it is
# launched to terminate, the 45 GB of weights go with it. Fine for a test box, so long as nobody is
# mid-call. Set SPOT=0 to stick to on-demand.
TRIES="g6e.2xlarge:$SUBNET_A:od g6e.2xlarge:$SUBNET_B:od g6e.xlarge:$SUBNET_A:od g6e.xlarge:$SUBNET_B:od"
if [ "${SPOT:-1}" = "1" ]; then
    TRIES="$TRIES g6e.xlarge:$SUBNET_A:spot g6e.xlarge:$SUBNET_B:spot"
fi

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

say "waiting for g6e capacity in $REGION (sweep every ${EVERY}s, giving up after ${MAX_HOURS}h)"

deadline=$(( $(date +%s) + MAX_HOURS * 3600 ))
sweep=0

while [ "$(date +%s)" -lt "$deadline" ]; do
    sweep=$(( sweep + 1 ))
    for try in $TRIES; do
        type=${try%%:*}
        rest=${try#*:}
        subnet=${rest%%:*}
        market=${rest##*:}
        spot_opts=""
        if [ "$market" = "spot" ]; then
            spot_opts="--instance-market-options MarketType=spot,SpotOptions={SpotInstanceType=one-time,InstanceInterruptionBehavior=terminate}"
        fi
        # shellcheck disable=SC2086
        out=$(aws ec2 run-instances --region "$REGION" \
            --image-id "$AMI" --instance-type "$type" --subnet-id "$subnet" \
            --key-name "$KEY" --security-group-ids "$SG" --associate-public-ip-address \
            --instance-initiated-shutdown-behavior terminate \
            $spot_opts \
            --metadata-options "HttpTokens=required,HttpEndpoint=enabled" \
            --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":200,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
            --user-data "file://userdata.sh" \
            --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=eatlabs-gpu},{Key=Purpose,Value=voice-agent-latency-test},{Key=Market,Value=$market}]" \
            --query 'Instances[0].InstanceId' --output text 2>&1)

        if printf '%s' "$out" | grep -q '^i-'; then
            printf '%s' "$out" > instance.txt
            printf '%s' "$type" > itype.txt
            say "LAUNCHED $out  ($type $market in ${subnet##*-})"
            ip=""
            for _ in $(seq 1 40); do
                ip=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$out" \
                     --query 'Reservations[0].Instances[0].PublicIpAddress' --output text 2>/dev/null)
                [ -n "$ip" ] && [ "$ip" != "None" ] && break
                sleep 5
            done
            printf '%s' "$ip" > ip.txt
            say "public IP $ip"
            say "ssh -i ~/.ssh/eatlabs-gpu.pem ubuntu@$ip"
            say "auto-stop is installed and held for 2 hours; after that, 30 min idle terminates it."
            exit 0
        fi

        case "$out" in
            *InsufficientInstanceCapacity*) : ;;                       # expected, keep sweeping
            *VcpuLimitExceeded*|*InstanceLimitExceeded*)
                say "QUOTA: $type refused - $(printf '%s' "$out" | tail -c 160)"; exit 2 ;;
            *UnauthorizedOperation*)
                say "PERMISSION denied - stopping"; exit 3 ;;
            *) say "unexpected: $(printf '%s' "$out" | tail -c 220)" ;;
        esac
    done
    [ $(( sweep % 10 )) -eq 1 ] && say "sweep $sweep: still no capacity"
    sleep "$EVERY"
done

say "gave up after ${MAX_HOURS}h with no capacity"
exit 1
