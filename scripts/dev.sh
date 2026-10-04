#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi
if [ ! -x agent/.venv/bin/python ]; then uv sync --project agent --frozen; fi
if [ ! -d web/node_modules ]; then npm ci --prefix web; fi
./scripts/build-gpu.sh
cargo build -p hub-server --locked
cargo run -p hub-server --locked &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT INT TERM
npm --prefix web run dev
