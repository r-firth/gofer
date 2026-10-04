#!/usr/bin/env bash
# Ship this checkout to a machine that already runs Gofer from ~/apps/gofer, rebuild there and
# restart onto the new build. Data and .env on the machine are left alone.
#
#   ./scripts/deploy.sh your-server
set -euo pipefail
cd "$(dirname "$0")/.."
host=${1:?usage: scripts/deploy.sh <ssh host>}
npm --prefix web run build >/dev/null
rsync -az --delete --exclude /target/ --exclude node_modules/ --exclude /agent/.venv/ --exclude /data/ \
  --exclude .env --exclude /.git/ --exclude __pycache__/ --exclude .ruff_cache/ --exclude '*.log' \
  ./ "$host:apps/gofer/"
# shellcheck disable=SC2016 # expanded on the remote host
ssh -o BatchMode=yes "$host" 'set -euo pipefail
  export PATH=$HOME/.cargo/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
  cd ~/apps/gofer
  uv sync --project agent --frozen -q
  cargo build --release -p hub-server --locked -q
  pid=""
  for p in $(pgrep -u "$USER" -x hub-server || true); do
    [ "$(readlink /proc/$p/cwd)" = "$PWD" ] && pid=$p
  done
  if systemctl is-active -q gofer.service; then
    # The unit restarts it (Restart=always) onto the new binary.
    [ -n "$pid" ] && kill -INT "$pid"
  else
    [ -n "$pid" ] && { kill -INT "$pid"; while kill -0 "$pid" 2>/dev/null; do sleep 0.5; done; }
    umask 077
    setsid nohup ./scripts/start.sh >>~/.local/share/gofer/gofer.log 2>&1 </dev/null &
  fi
  port=$(sed -n "s/^HUB_PORT=//p" .env | tail -1)
  for _ in $(seq 30); do curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$port/api/state" 2>/dev/null && break; sleep 1; done
  curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$port/api/state" && echo "Gofer is up on $(hostname):$port"'
