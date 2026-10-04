# Agents, views and notifications

## Coordinator and strands

The owner talks to a coordinator in a thread. The coordinator is Claude by default, at the model in `HUB_CLAUDE_MODEL` (default `claude-opus-5-5`). It works on the Gofer host with its native tools and delegates work that is long, or that belongs on another machine, to a strand: a native agent session on one registered machine, in one project directory, using that machine's existing agent installation and sign-in. Gofer does not install agents.

The coordinator's delegation tools are `start_agent`, `list_agents`, `read_agent`, `send_agent` and `stop_agent`. `start_agent` takes a provider (`claude`, `codex` or `copilot`), a device ID, an absolute project path and a prompt. Each strand is its own conversation with its own terminals, and its `parent_id` is the thread that started it. Stopping a strand's turn keeps its provider session for the next message. Strands cannot delegate: the server rejects the three write tools (`start_agent`, `send_agent`, `stop_agent`) from any conversation that is itself a native session, and leaves them out of the tool list those sessions see.

The server remembers each strand's provider session ID (`agent.session`) and resumes it on the next message.

- **Claude** uses the Claude Agent SDK over the machine's own Claude Code CLI, with stdio carried over SSH for remote machines. See [Claude implementation](claude-implementation.md). `.env.example` records the minimum Claude Code version for the default model.
- **Codex** uses its [app-server protocol](https://developers.openai.com/codex/app-server) over stdio, started locally or over SSH, with the model in `HUB_MODEL`. Gofer's tools are passed to it as dynamic tools named `gofer_<tool>`.
- **Copilot** uses [ACP over stdio](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server). It needs a CLI release that advertises session loading and HTTP MCP support.

Claude and Copilot strands reach Gofer's tools through an MCP endpoint, `POST /api/agent-mcp/{chat}`. For a remote machine the worker adds an SSH reverse forward from a loopback port on that machine to the server. The endpoint accepts only a bearer token that is created for that conversation's turn and revoked when the turn ends; the server's own `HUB_TOKEN` is never sent to a remote machine.

Sessions that already exist on a machine can be loaded into a thread. The client lists a machine's recent Claude Code and Codex sessions, and loading one copies its turns into a new strand that resumes the same session when continued. Copilot sessions cannot be loaded.

Remote machines need a POSIX shell reachable over SSH. On Windows that means WSL with its own SSH server.

## Computer use

Seeing and operating a machine's screen is done by a strand on that machine through cua-driver. When `cua-driver` is installed there, the worker adds its MCP server to Claude and Codex strands. For Codex it also disables Codex's own computer use entries found in `~/.codex/config.toml`, so there is one driver. A Claude strand on a machine without cua-driver is told that it has no computer use tool. On macOS, cua-driver needs Accessibility and Screen Recording switched on for CuaDriver; the setup panel reports when they are missing.

## Tailscale SSH sign-in

When an SSH command made for a conversation meets a [Tailscale SSH check](https://tailscale.com/docs/features/tailscale-ssh#configure-tailscale-ssh-with-check-mode), the server records an input request with the sign-in link and a cancel option, and the client shows it in that conversation. The original connection waits for up to 15 minutes and continues after approval. Cancelling the request, stopping the turn or closing the conversation aborts the attempt. Other conversations remain usable. Background SSH commands that are not made for a conversation do not open a prompt and fail with a message saying a sign-in is required. The setup panel's readiness check shows the link itself.

## Input requests

An agent that needs an answer raises an input request: a title with either a list of options or a list of questions (`agent.requested`). The client shows it in the conversation, and the answer is recorded as `agent.answered`. Claude's `AskUserQuestion` tool, Codex's approval and user-input requests, and Copilot's permission requests all arrive this way. A request lapses when its turn ends.

## Custom views in chat

Any agent can call `show_ui`; the coordinator and all three strand providers share the same contract. A view can be a progress display, comparison, diagram, form, timeline or another task-specific interface. It is stored as a `ui.updated` event in the conversation and restored when you return.

```json
{
  "view_id": "job",
  "title": "Build progress",
  "html": "<strong id='progress'></strong>",
  "css": "strong { color: var(--accent); font-size: 32px; }",
  "script": "tailnet.onData(d => document.getElementById('progress').textContent = d.progress + '%')",
  "data": { "progress": 40 },
  "actions": [
    { "id": "inspect", "label": "Inspect output", "prompt": "Inspect the current build output." }
  ]
}
```

Update the same view with just `{ "view_id": "job", "data": { "progress": 85 } }`. Omitted fields keep their previous values, and every update increments the view's revision. A data-only update is posted to the existing document, which keeps its local state. A change to the HTML, CSS or script replaces the document.

The document receives `window.tailnet`:

- `data`: the latest supplied JSON.
- `onData(callback)`: calls back immediately with the current data, then on each update; returns an unsubscribe function.
- `action(id, data)`: asks the host to run one of the declared actions. The host shows a **Run action** control outside the generated document. Clicking it sends the action's declared prompt and the selected data to this conversation's agent as a new turn. Requests for a stale revision or an unknown action are rejected.

Views run in an iframe with `sandbox="allow-scripts"`: scripts are enabled, without same-origin access, popups, forms or top-level navigation. The document's Content Security Policy allows inline scripts and styles and `data:` or `blob:` images and media, and blocks all network requests. A view cannot access the parent's DOM, cookies or authenticated API. This is an application isolation boundary, not a promise that generated JavaScript can never consume excessive resources.

Views are instruments inside the app, not separately branded websites. The host injects a theme and a small UI kit (`web/src/theme.css`, `web/src/view-kit.css`) ahead of the view's own CSS. Buttons, fields, headings, tables and progress bars are styled automatically. Do not reset `body` or `:root`, invent a palette, or add a wordmark, navigation, landing-page hero, gradients or large decorative padding. Custom CSS should describe the task's layout and graphics.

The kit supplies these classes:

| Class | Purpose |
| --- | --- |
| `tn-stack` | Vertical layout with a 16px gap |
| `tn-row`, `tn-toolbar` | Wrapping rows; row distributes items, toolbar groups controls |
| `tn-grid` | Responsive columns that collapse on narrow screens |
| `tn-panel` | Flat surface with a fine border |
| `tn-label`, `tn-muted`, `tn-mono` | Technical label, secondary text, monospace text |
| `tn-readout` | Numeric readout with tabular figures |
| `tn-primary` | Accented button |
| `tn-status` | Compact status; `data-state="working"` or `"done"` selects semantic colour |

Theme variables are `--background`, `--surface`, `--raised`, `--border`, `--text`, `--muted`, `--accent` and `--green`; `--display` and `--mono` are font stacks. Use the same tokens for SVG and canvas colours (read them with `getComputedStyle(document.documentElement)` when drawing). Start with useful content and controls, typically within 200 to 400px of height, and check phone widths. Animate with `requestAnimationFrame`, stop when idle or hidden, and respect reduced motion. See [the asset-pipeline example](examples/job-view.json) for a complete view.

Limits: HTML 128 KB, CSS and JavaScript 64 KB each, data 128 KB, up to 12 actions. Action data is limited to 16 KB and is passed to the agent marked as untrusted content.

## Memory

All agents can search shared memory with `search_memory` and open the source of a result with `read_memory_run`, using a returned run ID. Tool activity, input requests, answers, views and actions are part of the same event history. Push subscriptions and MCP tokens are kept out of it. See [memory](memory.md).

## Notifications

The server implements Web Push. A finished turn, a failed turn and an input request each queue a notification for every subscribed browser, except one that has reported itself as watching that conversation within the last minute. Notifications carry a generic status line, never messages or command output. The service worker in `web/public/sw.js` displays them.

The endpoints are `GET /api/push/config` (the VAPID public key), `POST /api/push/subscribe`, `POST /api/push/unsubscribe`, `POST /api/push/presence` and `POST /api/push/test`. Subscriptions are accepted only for Google FCM, Mozilla, Apple and Windows push service endpoints, and the server needs outbound HTTPS to them. VAPID keys, subscriptions and a bounded retry queue live in `data/push.json`, readable only by the owner. Expired subscriptions are removed; transient delivery failures are retried with backoff. Notification tags replace the previous notification for the same conversation.

The current client registers the service worker but has no control for subscribing a browser, so notifications are not yet reachable from the interface.

## Validation

`npm run check` includes protocol fixtures for each provider, native session and API lifecycle checks, view isolation and action tests, Web Push encryption and decryption, and `scripts/agent-features-smoke.py`, which runs against an isolated server with fixture agents.

Two opt-in runs of that script use real accounts. `HUB_LIVE_CODEX_TEST=1 agent/.venv/bin/python scripts/agent-features-smoke.py` additionally runs a disposable native Codex session, has it create a view, and verifies that its context survives a resume. `HUB_UI_REVIEW_DIR=<directory> agent/.venv/bin/python scripts/agent-features-smoke.py` asks a real coordinator for a focus timer without styling hints and saves the resulting view as `focus-timer.json` in that directory for inspection in a browser.
