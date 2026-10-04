# Self-hosting Gofer

Run Gofer as the user whose Claude and Codex sign-ins, SSH configuration and
machine access it should use. Build on the target machine:

```sh
./scripts/setup.sh     # once: checks prerequisites, installs dependencies
npm run build          # WASM module, production client, release server
./scripts/start.sh     # loads .env and runs target/release/hub-server
```

`scripts/setup.sh` expects `cargo`, `rustup`, `node`, `npm`, `uv`, `tmux` and
`codex` on PATH. Copy [.env.example](../.env.example) to `.env` for settings.
The server reads its configuration from `HUB_*` environment variables and its
binary is named `hub-server`; those names predate the project's current name.

## Private HTTPS with Tailscale

Keep the server on loopback and let Tailscale Serve handle HTTPS. Replace the
example hostname with this server's HTTPS name from your tailnet:

```dotenv
HUB_BIND=127.0.0.1
HUB_PORT=4318
HUB_PUBLIC_ORIGIN=https://your-server.your-tailnet.ts.net
```

Enable HTTPS in the tailnet if needed, start Gofer, then configure Serve:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:4318
```

Open that HTTPS address from a device connected to Tailscale. Serve's
background configuration persists independently of Gofer. Keep Funnel disabled;
tailnet access rules determine which devices can reach the server. To remove
the listener, run `tailscale serve --https=443 off`.

You can also use another reverse proxy. Preserve the original Host header,
forward WebSocket upgrades, and set `HUB_PUBLIC_ORIGIN` to the exact browser
origin. Restart Gofer after changing its environment.

## Authentication and hostnames

Set `HUB_TOKEN` in `.env` to a random value of at least 32 characters to
require a sign-in. The browser receives an HttpOnly, SameSite=Strict cookie,
which is also marked Secure when `HUB_PUBLIC_ORIGIN` is an HTTPS origin. Keep
the token out of URLs and source control.

A loopback server behind private Tailscale Serve can rely on tailnet access
without a token. In that configuration, anyone permitted to reach the service
can use it. Binding to anything other than `127.0.0.1` requires a token of at
least 32 characters; the server refuses to start without one. Gofer is a
single-user system with access to its host and to every machine that host can
reach over SSH.

Gofer validates the Host and Origin headers of every request. Loopback names
on `HUB_PORT` are always accepted. `HUB_PUBLIC_ORIGIN` adds its host, and
`HUB_ALLOWED_HOSTS` adds exact comma-separated `hostname:port` values.
Wildcards are not supported.

## Short HTTP addresses

To use an address such as `http://your-server:4318`, keep Gofer on loopback and
add a private HTTP listener:

```sh
tailscale serve --bg --http=4318 http://127.0.0.1:4318
```

Add the short and full hostname, each with `:4318`, to `HUB_ALLOWED_HOSTS`. Use
the hostname instead of a raw IP because Serve routes requests by hostname.
Remove the listener with `tailscale serve --http=4318 off`.

Installing the app to a home screen and Web Push require HTTPS. If a token is
set and `HUB_PUBLIC_ORIGIN` is HTTPS, sign in over HTTPS: the Secure cookie is
not sent over HTTP.

## Machines

Tailscale discovery runs at startup and every 30 seconds. It reads the local
network map and SSH host-key advertisements, and checks for an SSH banner on
port 22 of other online peers. It does not authenticate or run remote commands.
Set `HUB_DISCOVERY=off` to disable it, or `HUB_TAILSCALE_BIN` to select a
particular Tailscale CLI executable. A machine that is not on the tailnet can
be added in the client as an SSH alias or `user@host`.

Discovered machines are addressed by their MagicDNS short name, so SSH applies
the same configuration and known-hosts entry as a normal connection from the
Gofer host. Connections use batch mode and SSH's normal host-key verification.
Tailscale reachability alone does not grant SSH access: establish a working SSH
connection as the Gofer user first.

The client's setup panel checks each machine and says what is missing:

| Item         | Needed for                    | Notes                                                                 |
| ------------ | ----------------------------- | --------------------------------------------------------------------- |
| SSH          | Everything                    | The panel shows the command that authorises the host's public key     |
| tmux         | Terminals                     | Installed by the owner                                                |
| Claude Code  | Claude strands                | Signed in with `claude auth login`                                    |
| Codex        | Codex strands                 | Signed in with `codex login`                                          |
| cua-driver   | Computer use, screen stills   | macOS needs Accessibility and Screen Recording switched on            |
| cua-spacesd  | Screen view as video          | macOS; Gofer can install it with `scripts/setup-spaces.sh` over SSH   |

A Mac reached over SSH cannot read the login Keychain, so Claude Code there is
signed in with a token: run `claude setup-token` on the Mac and export the
result as `CLAUDE_CODE_OAUTH_TOKEN` in `~/.zshenv`. Remote machines need a
POSIX shell; on Windows that means WSL with its own SSH server.

`scripts/setup-spaces.sh` downloads a pinned cua-spacesd release, verifies its
checksum and signature, installs it as a login item listening on
`127.0.0.1:3211`, and asks macOS for Screen Recording. Run it with `--dry-run`
to see what it would do, or `--remove` to uninstall.

## Semantic memory

Set `OPENROUTER_API_KEY` in `.env` and restart Gofer. The server embeds stored
text and search queries with `google/gemini-embedding-2` at 768 dimensions;
`HUB_EMBEDDING_MODEL` and `HUB_EMBEDDING_DIMENSIONS` change that. Conversation,
tool and terminal text and search queries are sent to OpenRouter. The key stays
on the server; never place it in a `VITE_*` variable.

Without a key, or when the provider is unavailable, search and recall use text
matching only. Set the key and restart to begin indexing.

Changing the model, dimensions or endpoint writes a backup named
`history.vg.pre-embedding-<id>.vg` beside the database, removes the old
vectors, and reindexes in the background, resuming after a restart. Events, IDs
and graph links are preserved. Keep the backup until you are satisfied with the
change.

`HUB_EMBEDDING_URL` selects another compatible endpoint; the default is
OpenRouter's `/api/v1/embeddings`. HTTPS is required except for loopback
addresses.

## Mobile installation

The client ships a web app manifest and a service worker. Over HTTPS, use the
browser's own install action: **Install app** or **Add to Home Screen** in
Chrome's menu, or **Share → Add to Home Screen** on iPhone and iPad. The
service worker caches only an offline page. It does not cache API responses,
terminal history, images or frontend builds, so live work needs Tailscale
connectivity and a running Gofer host.

## Run as a service

On Linux, `scripts/install-service.sh` installs two system units that run as
your user: `gofer` (the server, through `scripts/start.sh`) and
`gofer-terminals` (the tmux server on the `gofer` socket, so shells survive a
restart of the server unit). Set `HUB_PORT` and `HUB_PUBLIC_ORIGIN` in `.env`,
build a release, then:

```sh
sudo ./scripts/install-service.sh
```

The script also configures Tailscale Serve for `http://<host>:HUB_PORT` and,
when `HUB_PUBLIC_ORIGIN` names an explicit HTTPS port, for HTTPS on that port.
For an origin on the default port, add the 443 listener yourself as shown
above. It is safe to run again. Logs are in `journalctl -u gofer`.

`scripts/deploy.sh <ssh host>` copies a checkout to `~/apps/gofer` on a machine
that already runs Gofer there, rebuilds, and restarts onto the new build. It
leaves `.env` and `data/` on that machine alone.

On macOS there is no installer script; run `scripts/start.sh` from the checkout
in a terminal or from your own LaunchAgent.

Restart the server when no agent turn is running. tmux shells survive a
restart; an in-flight turn does not and is marked as stopped.

## Data and backups

The default data directory is `data/`; set `HUB_DATA_DIR` to move it. Back up
the whole directory with Gofer stopped. It contains `history.vg`
(conversations, command output, machine details, claims and vectors),
`artifacts/` (images), `push.json` (notification keys and subscriptions) and
the coordinator's `workspace/`.

Each machine with a terminal also keeps
`~/.local/state/gofer/terminals/<session-id>.log` for reconnection and
catch-up. These logs may contain anything printed in a terminal. Automatic
retention, log rotation and encryption at rest are not implemented. Do not
truncate a live log; recorded offsets refer to its existing bytes. See
[persistence](architecture.md#persistence).

`.env`, its local variants, `data/`, database files, logs and common key files
are excluded from Git by `.gitignore`. Keep exports and copies of private data
out of source directories too.
