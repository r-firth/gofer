#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Tests use a local embedding provider; never spend a real API key.
export OPENROUTER_API_KEY=""
unset HUB_EMBEDDING_URL
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
agent/.venv/bin/ruff check agent scripts
agent/.venv/bin/ruff format --check agent scripts
npx --no-install prettier --check web/src web/vite.config.ts
cargo test --workspace --locked
cargo build -p hub-server --locked
./scripts/build-gpu.sh
npm --prefix web test
node --test scripts/pwa.test.mjs
npm --prefix web run build
agent/.venv/bin/python -m py_compile agent/worker.py scripts/smoke.py
agent/.venv/bin/python -m unittest discover -s agent -p 'test_*.py'
agent/.venv/bin/python scripts/smoke.py
agent/.venv/bin/python scripts/images-smoke.py
agent/.venv/bin/python scripts/agent-features-smoke.py
node scripts/ghostty-smoke.mjs
node scripts/ghostty-history-smoke.mjs
agent/.venv/bin/python scripts/discovery-smoke.py
agent/.venv/bin/python scripts/terminal-history-smoke.py
