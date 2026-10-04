#!/usr/bin/env bash
# One-time root setup to run this checkout as a service on a Linux machine: systemd units for
# Gofer and its tmux server, and tailnet-only addresses through Tailscale Serve
# (http://<host>:HUB_PORT, and HTTPS on HUB_PUBLIC_ORIGIN's port). Safe to run again.
#
#   sudo ./scripts/install-service.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run it with sudo: sudo $0"; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)
user=${SUDO_USER:?Run it with sudo from your own account}
group=$(id -gn "$user")
home=$(getent passwd "$user" | cut -d: -f6)
shell=$(getent passwd "$user" | cut -d: -f7)
port=$(sed -n 's/^HUB_PORT=//p' "$root/.env" | tail -1)
origin=$(sed -n 's/^HUB_PUBLIC_ORIGIN=//p' "$root/.env" | tail -1)
[ -n "$port" ] && [ -n "$origin" ] || { echo "Set HUB_PORT and HUB_PUBLIC_ORIGIN in $root/.env"; exit 1; }
[ -x "$root/target/release/hub-server" ] || { echo "Build first: cargo build --release -p hub-server"; exit 1; }

# Keep a copy of what happened where the owner (and the agent that set this up) can read it.
log="$root/install-service.log"
exec > >(tee "$log") 2>&1
trap 'chown "$user:$group" "$log"' EXIT
echo "Installing Gofer from $root for $user on port $port"

cat > /etc/systemd/system/gofer-terminals.service <<EOF
[Unit]
Description=Gofer persistent terminal server
[Service]
Type=simple
User=$user
Group=$group
Environment=HOME=$home
Environment=SHELL=$shell
ExecStart=/usr/bin/tmux -D -L gofer -f /dev/null
Restart=on-failure
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/gofer.service <<EOF
[Unit]
Description=Gofer
After=network-online.target tailscaled.service gofer-terminals.service
Wants=network-online.target gofer-terminals.service
[Service]
Type=simple
User=$user
Group=$group
WorkingDirectory=$root
Environment=HOME=$home
Environment=PATH=$home/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$root/scripts/start.sh
# Always, so scripts/deploy.sh can restart it onto a new build without root.
Restart=always
RestartSec=2
KillSignal=SIGINT
KillMode=mixed
TimeoutStopSec=20
UMask=0077
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload

# A copy started by hand before this script holds the port. Match it by its working directory,
# never by name: another checkout may run the same binary.
for pid in $(pgrep -u "$user" -x hub-server || true); do
  if [ "$(readlink "/proc/$pid/cwd")" = "$root" ]; then
    echo "Stopping the hand-started Gofer (pid $pid)"
    kill -INT "$pid"
    for _ in $(seq 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  fi
done
# A tmux server already on the gofer socket keeps running; the unit only starts one when none is up.
if sudo -u "$user" tmux -L gofer list-sessions >/dev/null 2>&1; then
  echo "A tmux server is already running on the gofer socket; leaving it in place"
  systemctl enable gofer-terminals.service
else
  systemctl enable --now gofer-terminals.service
fi
systemctl enable --now gofer.service
for _ in $(seq 30); do curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$port/api/state" && break; sleep 1; done
systemctl --no-pager --lines=0 status gofer.service | head -3 || true

# The short address (http://<host>:HUB_PORT), plus HTTPS on the public origin's port for the
# installable app, which browsers only allow over HTTPS.
short="http://$(hostname -s):$port"
tailscale serve --bg --http="$port" "http://127.0.0.1:$port"
https_port=$(printf '%s' "$origin" | sed -n 's|^https://[^/:]*:\([0-9][0-9]*\).*|\1|p')
if [ -n "$https_port" ] && [ "$https_port" != "$port" ]; then
  tailscale serve --bg --https="$https_port" "http://127.0.0.1:$port"
fi
echo "Tailnet addresses: $short and $origin"
