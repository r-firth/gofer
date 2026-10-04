"""Read terminal history as a watcher without sending input or entering tmux copy mode."""

import json
import os
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="hub-scrollback-") as data:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = subprocess.Popen(
        [str(root / "target/debug/hub-server")],
        cwd=root,
        env={
            **os.environ,
            "HUB_PORT": str(port),
            "HUB_DATA_DIR": data,
            "HUB_DISCOVERY": "off",
            "HUB_TOKEN": "",
        },
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    session = None

    def api(path, body=None):
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/api{path}",
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.load(response)

    def tmux(*args):
        return subprocess.check_output(
            ["tmux", "-L", "gofer", *args], text=True
        ).strip()

    try:
        for attempt in range(60):
            try:
                api("/state")
                break
            except OSError:
                time.sleep(0.1)
        session = api("/sessions", {"name": "Watcher scrollback verification"})
        sid = session["id"]
        pane = "hub_" + sid
        api(f"/sessions/{sid}/control", {"owner": "user"})
        api(
            f"/sessions/{sid}/input",
            {
                "text": "printf '\\033[32mHISTORY_%04d\\033[0m\\n' {1..250}; printf 'HISTORY_READY\\n'\n"
            },
        )
        for attempt in range(100):
            if "HISTORY_0250" in tmux("capture-pane", "-p", "-t", pane):
                break
            time.sleep(0.1)
        else:
            raise AssertionError("Test terminal did not finish its output")
        api(f"/sessions/{sid}/control", {"owner": "agent"})
        assert "HISTORY_0001" not in tmux("capture-pane", "-p", "-t", pane)
        before = max(e["id"] for e in api("/state")["events"])
        history = api(f"/sessions/{sid}/history")
        assert (
            "HISTORY_0001" in history["text"] and "HISTORY_0250" in history["text"]
        ), history
        assert "\x1b[" in history["text"], "ANSI styling was discarded"
        assert history["cols"] > 0 and history["rows"] > 0
        assert tmux("display-message", "-p", "-t", pane, "#{pane_in_mode}") == "0", (
            "Reading history changed the shared pane mode"
        )
        assert (
            next(s for s in api("/state")["sessions"] if s["id"] == sid)["owner"]
            == "agent"
        )
        # A second viewer receives an independent snapshot, without consuming history.
        assert api(f"/sessions/{sid}/history") == history
        assert not any(
            e["kind"] == "session.control" and e["id"] > before
            for e in api("/state")["events"]
        )
        print(
            "PASS: agent-owned history includes offscreen ANSI output; reads preserve ownership and shared terminal mode"
        )
    finally:
        if session:
            try:
                api("/sessions/" + session["id"] + "/close", {})
            except OSError:
                pass
        server.send_signal(signal.SIGINT)
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
