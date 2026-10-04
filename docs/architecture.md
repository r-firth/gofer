# Architecture

Gofer runs on one host and reaches other machines over SSH. The browser is a
viewer and controller; persistent work belongs to the server, the agent CLIs
and tmux.

| Layer                             | Role                                                             |
| --------------------------------- | ---------------------------------------------------------------- |
| React + TypeScript + Vite         | The client in `web/src/gofer/`: threads, machines, memory, setup |
| TanStack Router / Query           | Navigation and browser state                                     |
| Rust + Axum (`crates/hub-server`) | HTTP API, WebSockets, tool execution, terminal ownership         |
| Python worker (`agent/`)          | Hosts the Claude Agent SDK, the Codex SDK and Copilot's ACP      |
| Vecgra (`vendor/vecgra`)          | Durable event graph, claims, and embedding vectors               |
| tmux + SSH                        | Persistent shells on the host and on remote machines             |
| ghostty-web                       | Terminal emulation (Ghostty's core as WASM, Canvas 2D rendering) |
| cua-driver, cua-spacesd           | Optional, per machine: computer use and live screen video        |

Names from before the rename remain in the code: environment variables are
`HUB_*`, the server binary is `hub-server`, and tmux sessions are named
`hub_<session-id>`.

## Conversations

Everything the server stores is an event with a kind, a scope and a JSON
payload. A conversation (`Chat`) is a projection of the events in its scope.
There are three sorts:

- A **thread** is a coordinator conversation the owner talks to. The first one
  is created on startup, is named "Thread", and cannot be closed. More are
  opened with `POST /api/threads`.
- A **strand** is a native Claude, Codex or Copilot session on one machine in
  one directory. The coordinator starts one with `start_agent`; its
  `parent_id` is the thread that started it.
- A **loaded session** is a Claude Code or Codex session that already existed
  on a machine. `GET /api/devices/{id}/sessions` lists them from the tools' own
  session files, and `POST /api/chats/{thread}/load` copies the last 300 turns
  into a new strand under that thread (`strand.loaded`). Continuing it resumes
  the original session by its id.

A **project** is a named collection of threads. `POST /api/projects` creates
one with a first thread called "general"; `POST /api/projects/{id}/close` puts
it away. The project is passed to the coordinator as context and does not fix a
machine or a directory.

## Agent and event flow

A message is recorded as `message.user`. The server then recalls memory for it
(see [memory](memory.md)), records `agent.started`, and spawns
`agent/worker.py` with the conversation, its recent events, the recalled items,
the device list and the conversation's terminals as one JSON line on stdin. The
worker prints one JSON frame per line. The server records each as an event
(`message.started`, `message.delta`, `message.assistant`, `tool.started`,
`tool.output`, `tool.result`, `agent.status`, `agent.session`,
`agent.restarted`, `agent.error`) and broadcasts it on the `/api/events`
WebSocket. `agent.finished` ends the turn.

The coordinator is Claude by default (`coordinator_provider: "claude"`, model
from `HUB_CLAUDE_MODEL`, default `claude-opus-5-5`, medium effort). It runs
through the Claude Agent SDK with Claude Code's own system prompt and tools,
plus Gofer's instructions, and works in `data/workspace/` on the Gofer host.
It is one Claude session resumed every turn, so after the first turn it
receives only the new message. A conversation can instead be created with
`coordinator_provider: "codex"`, which uses the Codex SDK with the model in
`HUB_MODEL`.

The coordinator's final output each round is a structured decision: text for
the user, an optional title, and zero or more Gofer tool requests. Only the
text field is streamed into the visible reply. The worker posts each tool
request to `POST /api/tools`; the server executes it, records `tool.started`
and `tool.result`, and the worker hands the results back for the next round.
A turn is limited to 50 rounds. The Gofer tools are defined in
`agent/tools.json`: `list_devices`, `list_terminals`, `open_terminal`,
`terminal_send`, `terminal_read`, `terminal_interrupt`, `wait`, `show_image`,
`show_ui`, `search_memory`, `read_memory_run`, `start_agent`, `list_agents`,
`read_agent`, `send_agent` and `stop_agent`.

Strands and their transports are described in
[agents and views](agents-and-views.md), and the Claude adapter in
[Claude implementation](claude-implementation.md).

Claude runs with `bypassPermissions` and Codex with approval policy `never` and
the `danger-full-access` sandbox, so agents act without asking. Use an account
and a host appropriate for that access. Stopping a turn aborts the worker:
a Claude worker is signalled to interrupt the CLI and its process group is
terminated three seconds later, other workers are terminated at once. Terminal
processes belong to tmux and keep running. Turns interrupted by a server
restart are marked `agent.stopped` on startup and are not replayed.

## Terminals

A conversation owns at most one open terminal per machine. `open_terminal` for
a machine where it already has one returns that terminal. The terminal tools
only accept terminals owned by the calling conversation.

Each terminal is a tmux session on the machine, on Gofer's own tmux socket
(`tmux -L gofer`), so it never touches the user's own tmux sessions. The server
attaches through a PTY, locally or over `ssh -tt`, and streams bytes to viewers
on `/api/sessions/{id}/stream`. A terminal is controlled by either the agent or
the user (`session.control`); input from the other side is rejected.

The most recently activated viewer sets the terminal's size. Other viewers
follow that size, and automatic reconnects do not claim it. A viewer can read a
snapshot of up to 10,000 scrollback lines from `/api/sessions/{id}/history`
without entering tmux copy mode.

Closing a conversation stops its agent and marks its terminals for shutdown.
The conversation closes immediately even when a machine is unreachable; the
`tmux kill-session` is retried every 30 seconds and after a restart until it
succeeds. History stays in Vecgra, and reopening a conversation does not
restart its shells.

## Machines

The host is the device `local`. Other devices come from Tailscale discovery or
are added by hand as an SSH alias or `user@host` (`POST /api/devices`).
Discovery runs `tailscale status --json` at startup and every 30 seconds,
keeps peers that advertise Tailscale SSH host keys or answer with an SSH banner
on port 22, and never logs in or runs remote commands. Discovered peers are
addressed by their MagicDNS short name, so SSH uses the same configuration and
known-hosts entry as a manual connection from the host.

`GET /api/devices/{id}/readiness` runs one probe script on the machine and
reports, per item, whether it is ready: SSH, tmux, Claude Code, Codex,
cua-driver and cua-spacesd. Each missing item carries either a command for the
owner to run or a fix the server applies with
`POST /api/devices/{id}/setup/{step}` (`cua-start`, `spaces-start`,
`spaces-install`). The client's setup panel is built on these two endpoints.

## Screen view and computer use

`/api/devices/{id}/screen` is a WebSocket carrying the machine's desktop while
someone is watching. If [cua-spacesd](https://github.com/trycua/cua/tree/main/libs/cua-spacesd)
is running on the machine (installed by `scripts/setup-spaces.sh`, listening on
the machine's loopback only), the server opens a view-only H.264 stream of the
primary display through an SSH port forward and relays the packets unchanged;
the page plays them with jmuxer. Otherwise it falls back to a loop on the
machine that captures stills through cua-driver and sends them as JPEG or PNG
frames.

Computer use is done by strands, not by the coordinator. When cua-driver is
installed on a strand's machine, the worker adds its MCP server to the Claude
or Codex session and, for Codex, switches off Codex's own computer use
entries in its favour.

## Images

Image blocks returned by native tools are extracted from tool results and shown
inline. `show_image` publishes a file by absolute path from the host or, over
SSH, from another machine. Images are validated, copied into
`data/artifacts/` under a content hash, and served from `/api/artifacts/{id}`.
PNG, JPEG, GIF and WebP are supported up to 25 MB and 64 megapixels. Copies
remain available when the source file is removed or its machine disconnects.

## Persistence

- `data/history.vg` holds events, their scope and ordering edges, tool
  receipts, terminal output, claims, entities and embedding vectors.
- `data/artifacts/` holds image originals. Source paths, dimensions, captions
  and device provenance are recorded in their events.
- `data/workspace/` is the coordinator's working directory, and
  `data/consolidation/` is the working directory of the memory writer.
- `data/push.json` holds Web Push keys, subscriptions and the delivery queue.
- Each shell host spools terminal output to
  `~/.local/state/gofer/terminals/<session-id>.log`. An importer records byte
  offsets in Vecgra (`terminal.output`) and catches up after a disconnect.
- `tmux -L gofer` owns shells independently of browsers and server restarts. A
  machine reboot ends those processes; retained logs are not a running shell.

`HUB_DATA_DIR` relocates the data directory. Vecgra commits each event in its
own transaction; embedding is asynchronous. No automatic retention or
encryption at rest is implemented. See [backups](self-hosting.md#data-and-backups).

Vecgra is vendored as source in `vendor/vecgra` under its
[own license](../vendor/vecgra/LICENSE).

## Embeddings

A Rust HTTP client calls OpenRouter's embeddings endpoint. The model is
`HUB_EMBEDDING_MODEL` (default `google/gemini-embedding-2`) at
`HUB_EMBEDDING_DIMENSIONS` (default 768); `HUB_EMBEDDING_URL` selects another
compatible endpoint. Queries and documents are given the prefixes each model
family documents for retrieval.

The endpoint, model, dimensions and prefixes form a profile stored in an
`EmbeddingConfig` node. When the profile changes, the server writes a compact
backup beside `history.vg` (`history.vg.pre-embedding-<id>.vg`), removes the
old vectors and updates the marker. A change of dimension rebuilds the file
with every node ID preserved. Events, edges and claims are kept, and only nodes
without a vector are indexed, so partial work survives a restart.

The indexer embeds claims first, then user and assistant messages, tool
results, terminal text and device and terminal records, in batches of 32 with
duplicate texts sent once. Query embeddings use a separate path with a 64-entry
cache. A browser search waits 150 ms for the query vector, returns text matches
if it is not ready, and reports `semantic_pending` so the client can refresh.
Each distinct query makes one provider request with a 15-second deadline, at
most eight run at once, and failures are cached for ten seconds. The agent's
`search_memory` waits for the vector instead of returning early. Requests are
retried up to three times on transport failures, 408, 429 and 5xx. Response
count, order, model, vector size and values are validated before storage.
Provider error bodies and API keys are not written to logs or events.

`/api/state` exposes `embedding_model`, `embedding_dimensions` and
`embedding_status` (`starting`, `indexing`, `ready` or `unavailable`).
Embeddings require `OPENROUTER_API_KEY`; without it, search and recall are
text only. Indexed text and queries are sent to the embedding provider. The
database and text search stay on the host.

## Memory browser

The memory view (`/memory`) shows Vecgra's nodes and edges: scopes, events,
claims and entities. It has two arrangements, a network layout and a sequence
over time. Without a focus, `/api/memory/graph` returns twelve scopes per page
with up to twelve recent events each, plus recent claims; with `?node=` it
returns that node's neighbourhood. Text search uses an in-memory trigram index
rebuilt at startup, combined with vector matches when a query vector is
available, 40 hits per page. The server keeps every event in memory, so very
large archives would need more bounded projections.

## Client

The only client is `web/src/gofer/`, entered from `web/index.html` through
`src/gofer/main.tsx`. Text is JetBrains Mono, with a self-hosted Nerd Fonts
symbols font for terminal glyphs. The terminal is ghostty-web 0.4.0, loaded
when the first terminal opens. A narrower layout applies below 900 px.

`crates/hub-graphics` is a Rust/wgpu module compiled to WASM by
`scripts/build-gpu.sh` into `web/src/generated/gpu/`. It must be built before
the client is.

The service worker (`web/public/sw.js`) caches only an offline page. It does
not cache API responses or frontend builds, and it displays Web Push
notifications sent by the server.

## Scope

Gofer is a single-user system: one owner, one host, and the machines that host
can reach over SSH. Nothing of Gofer's is installed on the other machines. The
agent CLIs, tmux, cua-driver and cua-spacesd are third-party tools that Gofer
uses when they are present.
