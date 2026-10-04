# Claude implementation

How Gofer runs Claude, both as the coordinator of a thread and as a strand on a
machine. The code is `agent/claude_backend.py`, called from `agent/worker.py`;
the memory writer in `agent/consolidate.py` reuses the same transport.

## Roles

- A coordinator conversation stores `coordinator_provider` (`claude` or
  `codex`, default `claude`). A strand stores `agent.provider` with its device
  and directory. The two are validated separately, and a request that sets both
  is rejected.
- Both roles use the model in `HUB_CLAUDE_MODEL` (default `claude-opus-5-5`) at
  `medium` effort. `HUB_MODEL` applies to Codex only.
- The coordinator runs on the Gofer host in `data/workspace/`. A strand runs on
  its device in its project directory.

## Transport

Gofer uses the official Claude Agent SDK, pinned in `agent/pyproject.toml`,
with the Claude Code CLI already installed on the execution device. It does not
bundle or patch a CLI.

`DeviceTransport` subclasses the SDK's subprocess transport. It takes the
command line the SDK builds and wraps it: for the host it runs it directly, and
for a remote device it runs it through `ssh -T` with batch mode, so the SDK's
stdio protocol travels over SSH. Because the adapter depends on the SDK's
internal transport class, the SDK version is pinned exactly. The SDK's local
CLI version check is skipped, since the CLI that matters is on the device; an
incompatible CLI fails at protocol initialization instead. The minimum Claude
Code version for the default model is recorded in `.env.example`.

A strand's Gofer tools are served over MCP at `/api/agent-mcp/{chat}` on the
server. For a remote device the SSH command adds a reverse forward from a
random loopback port on the device to the server's port, with
`ExitOnForwardFailure`. The MCP endpoint accepts only the bearer token created
for that conversation's current turn. When cua-driver is installed on the
device, its MCP server is added too.

The remote device needs a registered SSH destination, an absolute project path,
the CLI on its PATH (or in `~/.local/bin`, `~/.npm-global/bin`,
`/opt/homebrew/bin` or `/usr/local/bin`), and permission for the reverse
forward. It does not need Python or the SDK.

## Authentication

Claude runs on the device's Claude subscription sign-in. Before each turn the
adapter runs `claude auth status` on the device and requires a signed-in
`claude.ai` or OAuth-token method. If that fails, the turn ends with a message
saying to run `claude auth login` on that device.

API and alternate-provider settings are removed from the CLI's environment
(`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, the
Bedrock, Vertex and Foundry switches), along with Gofer's own `HUB_TOKEN`,
`HUB_MCP_TOKEN` and `OPENROUTER_API_KEY`. The session is started with
`forceLoginMethod: "claudeai"` and an empty `apiKeyHelper`, so there is no API
fallback. `CLAUDE_CODE_OAUTH_TOKEN` is left in place: it is a subscription
token from `claude setup-token`, and it is the only sign-in available on a Mac
reached over SSH, where the login Keychain is locked. The adapter never reads
credential files.

Authenticate on each execution device as the OS user that runs the CLI.
Subscription limits and billing are Anthropic's.

For a remote Claude strand the server first makes a plain SSH connection to the
device, so a Tailscale SSH identity check appears as a sign-in request in the
conversation before the CLI starts.

## Options

Sessions use Claude Code's own system prompt with Gofer's instructions
appended, load user, project and local settings, and run with
`permission_mode="bypassPermissions"`. `WebSearch` and `WebFetch` are allowed
explicitly. A `can_use_tool` callback allows every tool, with one exception:
`AskUserQuestion` becomes an input request in the conversation, and the
owner's answers are returned to the tool. The pinned SDK sets
`permission_prompt_tool_name="stdio"` on a copy of the options that custom
transports never receive, so `DeviceTransport` mirrors that setting on its own
copy.

## Coordinator turns

The coordinator is given a JSON schema as its output format: `text`, `title`
and a list of Gofer tool requests. Each round:

1. The adapter sends the prompt and streams the response. The `text` field is
   decoded from the partial structured output as it arrives and emitted as
   `message.delta`.
2. The final decision is validated against the schema. Its text is emitted as
   the message under the same message ID as the stream, and its title is used
   once if the conversation needs one.
3. Each requested tool is executed by the server through `POST /api/tools`.
   The receipts are sent back as the next prompt.

A turn ends when a decision requests no tools, or after 50 rounds.

The coordinator is one Claude session. Its session ID is recorded as
`agent.session` and resumed on every turn, so the first turn carries the last
100 conversation events and later turns carry only the new message. If the CLI
reports that it has no saved conversation for that ID, the worker records
`agent.restarted` and starts a new session with the last 100 events replayed.
No other failure restarts a session.

## Strand turns

A strand has no output schema. Its text is streamed as it is written. The
strand's session ID is stored on the conversation and resumed for every
follow-up, on the original device.

## Receipts and ordering

Every native tool call is emitted as `tool.started` with its name and input,
and `tool.result` when its result block arrives. Adjacent text blocks are
finalized once per run of text, under the ID the stream used. Text that follows
a tool call is held until that call's receipt has been emitted, so text and
tools keep their order. Text written inside a subagent is not shown as the
conversation's own reply.

## Stopping and errors

When a turn is stopped, the server sends the worker `SIGUSR1`. The adapter
interrupts the session through the SDK and disconnects; the server terminates
the worker's process group three seconds later.

The CLI's stderr is never shown in a conversation. Errors raised to the
conversation are fixed messages or the error type's name. The one exception is
an error message returned by the API itself (for example a model the CLI is too
old for, or a limit reached), which is shown clipped to 400 characters.

## Tests

`agent/test_claude.py` drives the adapter against SDK protocol fixtures: the
command line locally and over SSH, the subscription check, streaming and
message identity, structured decisions and tool rounds, resume, a missing
session, questions, interrupt and credential-safe errors.
`crates/hub-server/tests/native_sessions.rs` covers how the role, provider and
session ID are persisted.
