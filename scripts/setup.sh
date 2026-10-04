#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for tool in cargo rustup node npm uv tmux; do
  command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool (see README.md)"; exit 1; }
done
rustup target add wasm32-unknown-unknown
if ! command -v wasm-bindgen >/dev/null || ! [[ $(wasm-bindgen --version) == 'wasm-bindgen 0.2.128' ]]; then
  cargo install wasm-bindgen-cli --version 0.2.128 --locked
fi
npm ci
npm ci --prefix web
uv sync --project agent --frozen
./scripts/build-gpu.sh
printf '\nReady. Sign in with claude auth login (and codex login for Codex sessions), then npm run dev.\n'
