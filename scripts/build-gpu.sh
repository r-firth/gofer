#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build -p hub-graphics --target wasm32-unknown-unknown --release --locked
wasm-bindgen --target web --out-dir web/src/generated/gpu --out-name hub_graphics target/wasm32-unknown-unknown/release/hub_graphics.wasm
