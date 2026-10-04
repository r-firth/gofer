# Development

Install the prerequisites listed in the [README](README.md), then run
`./scripts/setup.sh`. It installs dependencies from the npm and uv lockfiles,
adds the WASM target, installs the pinned wasm-bindgen CLI and builds the
graphics module. Rust is pinned in `rust-toolchain.toml`. The script expects
`tmux` and `codex` on PATH.

## Layout

| Path                   | Contents                                                        |
| ---------------------- | --------------------------------------------------------------- |
| `crates/hub-server/`   | Rust/Axum server: API, events, terminals, memory, discovery     |
| `crates/hub-graphics/` | Rust/wgpu module compiled to WASM for the client                |
| `agent/`               | Python worker: Claude, Codex and Copilot adapters, memory writer |
| `web/src/gofer/`       | The React client; entry is `web/index.html` → `src/gofer/main.tsx` |
| `web/src/`             | Modules shared with the client: API types, terminal, views      |
| `scripts/`             | Build, service, smoke-test and benchmark scripts                |
| `vendor/vecgra/`       | Vendored graph and vector store                                 |

## Local workflow

```sh
npm run dev
```

The Vite dev server listens on `127.0.0.1:4317` and proxies `/api`, including
WebSockets, to the Rust server on `127.0.0.1:4318`. The launcher loads `.env`
and builds the graphics module first. Stop any other instance on port 4318
before starting it.

```sh
npm run build     # WASM, production client, release server
npm run check     # formatting, lints, tests, builds, integration checks
npm run format    # Rust, frontend and Python formatting
```

`npm run check` runs `cargo fmt --check`, Clippy with warnings denied, Ruff
lint and format checks, and Prettier. It then runs the Rust tests, the frontend
tests (Vitest), the service worker tests, the Python tests, a production client
build, and the integration scripts: API and terminal behaviour
(`scripts/smoke.py`), image delivery, agent features, Ghostty output and
scrollback, discovery and terminal history.

The suite clears `OPENROUTER_API_KEY` and uses a local embedding fixture, so it
never makes paid embedding requests. The integration scripts start isolated
servers on temporary data directories and clean up after themselves. They
require tmux and do not use real agent accounts. GitHub Actions runs the same
suite on Linux and macOS.

Checks that use real accounts are opt-in and are not part of the suite:

- `HUB_LIVE_CODEX_TEST=1` or `HUB_UI_REVIEW_DIR=<directory>` with
  `scripts/agent-features-smoke.py`; see
  [agents and views](docs/agents-and-views.md#validation).
- `scripts/memory-live-smoke.py`; see [memory](docs/memory.md#checks).

## Logo and icons

The logo, the PWA icons under `web/public/icons/` and `web/src/assets/mark.svg`
are generated:

```sh
uv run --project agent --group dev python scripts/build-logo.py
```

Keep screenshots or recordings used in documentation synthetic. Real captures
may reveal conversation content, terminal output, hostnames or local paths.

## Memory performance

Create an isolated synthetic archive; the fixture refuses to overwrite one:

```sh
cargo run -p hub-server --example memory_fixture -- /tmp/hub-memory-fixture 10000
HUB_DATA_DIR=/tmp/hub-memory-fixture HUB_PORT=4323 HUB_DISCOVERY=off ./target/debug/hub-server
```

In another shell:

```sh
python3 scripts/memory-bench.py http://127.0.0.1:4323
python3 scripts/memory-smoke.py http://127.0.0.1:4323
node scripts/memory-layout-bench.mjs http://127.0.0.1:4323
```

The retrieval benchmark reports local HTTP timings including JSON parsing; it
does not measure model inference. The layout benchmark measures solver CPU
time, not browser frame rate.

## Before publishing changes

Review `git status --short` and the staged diff. `.env` variants, `data/`,
databases, logs, build output, dependencies and common key files are ignored by
Git. That does not cover private material copied into arbitrary source files.
Never force-add runtime data, credentials, terminal exports or real
screenshots.

Run `npm run check` before a release. Keep the dependency lockfiles and the
bundled third-party licenses (`vendor/vecgra/LICENSE`,
`web/public/fonts/NERD-FONTS-LICENSE`) with the source.

## License

Gofer is licensed under [Apache-2.0](LICENSE).
