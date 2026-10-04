#!/usr/bin/env bash
# Sets this Mac up to stream its desktop to Gofer as video.
#
# Installs cua-spacesd (Cua Spaces' daemon: https://github.com/trycua/cua/tree/main/libs/cua-spacesd)
# as the signed app "Cua Spacesd.app", so its Screen Recording grant survives updates, and
# runs it as a login item. It listens on this machine only (127.0.0.1:3211): Gofer reaches it
# through the SSH access it already has, so nothing new is exposed on the network and nothing
# goes through cua's relay. No sudo.
#
#   scripts/setup-spaces.sh              install or update, then ask for Screen Recording
#   scripts/setup-spaces.sh --dry-run    say what would be done
#   scripts/setup-spaces.sh --remove     stop it and take it off this Mac
set -euo pipefail

version=${CUA_SPACESD_VERSION:-0.5.0}
asset=cua-spacesd-macos-universal.app.zip
url="https://github.com/trycua/cua/releases/download/cua-spacesd-v$version/$asset"
app="/Applications/Cua Spacesd.app"
label=com.trycua.spacesd
plist="$HOME/Library/LaunchAgents/$label.plist"
state="$HOME/.cua/spacesd"
port=3211
mode=${1:-install}

[ "$(uname -s)" = Darwin ] || { echo "This script is for a Mac." >&2; exit 1; }

if [ "$mode" = --remove ]; then
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$plist"
  rm -rf "$app"
  echo "cua-spacesd stopped and removed. Its token is still in $state; delete that folder too if you like."
  echo "Its Screen Recording entry stays in System Settings until you remove it there."
  exit 0
fi

if [ "$mode" = --dry-run ]; then
  cat <<EOF
Would download  $url (about 54 MB) and check it against its published SHA-256
Would install   $app
Would write     $state/token (a random token, mode 600), kept if it already exists
Would write     $plist (runs it at login, listening on 127.0.0.1:$port only)
Would start it and ask macOS for Screen Recording
EOF
  exit 0
fi
[ "$mode" = install ] || { sed -n '2,13p' "$0"; exit 2; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fetch() { curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL "$@"; }

echo "Downloading cua-spacesd $version ..."
fetch "$url" -o "$tmp/$asset"
expected=$(fetch "$url.sha256" | awk '{print $1; exit}')
actual=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "Checksum mismatch for $asset (expected ${expected:-none}, got $actual). Nothing installed." >&2
  exit 1
fi
ditto -x -k "$tmp/$asset" "$tmp/unpacked"
found=$(find "$tmp/unpacked" -maxdepth 2 -name '*.app' | head -1)
[ -n "$found" ] || { echo "No app inside $asset. Nothing installed." >&2; exit 1; }
codesign --verify --deep --strict "$found"
[ -x "$found/Contents/MacOS/cua-spacesd" ] || { echo "The app has no cua-spacesd binary. Nothing installed." >&2; exit 1; }

launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
rm -rf "$app"
ditto "$found" "$app"

mkdir -p "$state" "$HOME/Library/LaunchAgents"
if [ ! -s "$state/token" ]; then
  (umask 077; openssl rand -hex 32 >"$state/token")
fi
chmod 600 "$state/token"

cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$app/Contents/MacOS/cua-spacesd</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CUA_ENV_TOKEN_FILE</key>
    <string>$state/token</string>
    <key>CUA_ENV_LISTEN</key>
    <string>127.0.0.1:$port</string>
    <key>CUA_ENV_QUIC_PORT</key>
    <string>0</string>
    <key>CUA_ENV_LOG</key>
    <string>info</string>
  </dict>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/cua-spacesd.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/cua-spacesd.log</string>
</dict>
</plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$plist"

up=""
for _ in $(seq 20); do
  if [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/health" || true)" = 204 ]; then
    up=1
    break
  fi
  sleep 0.5
done
if [ -z "$up" ]; then
  echo "cua-spacesd was installed but is not answering on 127.0.0.1:$port." >&2
  echo "Its log is $HOME/Library/Logs/cua-spacesd.log" >&2
  exit 1
fi

# Open a view of the screen once (StreamService.OpenMedia over gRPC-Web, primary display,
# view only), so that macOS asks for Screen Recording and lists the app in System Settings.
printf '\x00\x00\x00\x00\x15\x0a\x09\x0a\x07primary\x12\x01\x01\x18\x1e\x20\xc0\x0c\x30\x01' |
  curl -s -m 10 -o /dev/null -X POST --data-binary @- \
    -H 'content-type: application/grpc-web+proto' -H 'x-grpc-web: 1' \
    -H "authorization: Bearer $(cat "$state/token")" \
    "http://127.0.0.1:$port/cua.env.v1.StreamService/OpenMedia" || true

open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" || true
cat <<EOF

cua-spacesd $version is installed and running.

One thing left, in the System Settings window that just opened
(Privacy & Security > Screen & System Audio Recording):
  switch on "Cua Spacesd". If it is not in the list, press + and choose
  $app
If macOS offers "Quit & Reopen", accept it.
EOF
