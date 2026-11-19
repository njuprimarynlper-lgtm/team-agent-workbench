#!/bin/bash
set -euo pipefail
mkdir -p /run/sshd /var/lib/workbench-probe
ssh-keygen -A
count_file=/var/lib/workbench-probe/start-count
count=0
if [[ -f "$count_file" ]]; then count=$(cat "$count_file"); fi
printf '%s\n' "$((count + 1))" > "$count_file"
/usr/bin/supervisord -c /etc/supervisor/supervisord.conf
trap '/usr/bin/supervisorctl -c /etc/supervisor/supervisord.conf shutdown; exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
