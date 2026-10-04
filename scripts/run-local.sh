#!/usr/bin/env bash
# Run the debug server from this checkout with its own .env and data directory.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi
exec ./target/debug/hub-server
