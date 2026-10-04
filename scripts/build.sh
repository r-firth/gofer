#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
uv sync --project agent --frozen
npm ci --prefix web
./scripts/build-gpu.sh
npm --prefix web run build
cargo build -p hub-server --release --locked
