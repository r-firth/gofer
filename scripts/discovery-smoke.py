"""Exercise automatic discovery and saved SSH logins against an isolated network map."""

import json
import os
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix="hub-discovery-") as temporary:
    directory = Path(temporary)
    fixture = directory / "status.json"
    status = {
        "BackendState": "Running",
        "Self": {"ID": "self", "OS": "linux"},
        "Peer": {
            "a": {
                "ID": "server",
                "HostName": "Home server",
                "DNSName": "server.tail.test.",
                "OS": "linux",
                "Online": True,
                "sshHostKeys": ["key"],
            },
            "b": {
                "ID": "laptop",
                "HostName": "Laptop",
                "DNSName": "laptop.tail.test.",
                "OS": "macOS",
                "Online": False,
                "sshHostKeys": ["key"],
            },
            "c": {
                "ID": "vpn",
                "DNSName": "relay.mullvad.ts.net.",
                "Online": True,
                "sshHostKeys": ["key"],
            },
            "d": {
                "ID": "phone",
                "DNSName": "phone.tail.test.",
                "Online": False,
                "CapMap": {"https://tailscale.com/cap/ssh": None},
            },
        },
    }
    fixture.write_text(json.dumps(status))
    cli = directory / "tailscale"
    cli.write_text(
        "#!/usr/bin/env python3\nfrom pathlib import Path\nprint(Path("
        + repr(str(fixture))
        + ").read_text())\n"
    )
    cli.chmod(0o700)
    with socket.socket() as port_socket:
        port_socket.bind(("127.0.0.1", 0))
        port = port_socket.getsockname()[1]
    process = subprocess.Popen(
        [str(ROOT / "target/debug/hub-server")],
        cwd=ROOT,
        env={
            **os.environ,
            "HUB_PORT": str(port),
            "HUB_DATA_DIR": str(directory / "data"),
            "HUB_TOKEN": "",
            "HUB_DISCOVERY": "on",
            "HUB_TAILSCALE_BIN": str(cli),
        },
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    def api(path, payload=None):
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/api{path}",
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    try:
        for _ in range(100):
            try:
                state = api("/state")
                if state["discovery"]["status"] == "connected":
                    break
            except OSError:
                pass
            assert process.poll() is None, "Discovery server exited"
            time.sleep(0.05)
        assert len(state["devices"]) == 3, state["devices"]
        server = next(d for d in state["devices"] if d["tailscale_id"] == "server")
        assert server["status"] == "online"
        assert server["target"] == "server", server
        assert (
            next(d for d in state["devices"] if d["tailscale_id"] == "laptop")["target"]
            == "laptop"
        )
        assert (
            next(d for d in state["devices"] if d["tailscale_id"] == "laptop")["status"]
            == "offline"
        )
        saved_count = sum(e["kind"] == "device.saved" for e in state["events"])
        assert api("/devices/discover", {})["added"] == 0
        assert (
            sum(e["kind"] == "device.saved" for e in api("/state")["events"])
            == saved_count
        )
        edited = api(
            "/devices",
            {
                "id": server["id"],
                "name": "My server",
                "target": "operator@server.tail.test",
            },
        )
        assert edited["tailscale_id"] == "server", (
            "Editing a login discarded the Tailscale identity"
        )
        status["Peer"]["a"].update(
            HostName="Renamed", DNSName="renamed.tail.test.", Online=False
        )
        fixture.write_text(json.dumps(status))
        api("/devices/discover", {})
        state = api("/state")
        assert len(state["devices"]) == 3
        server = next(d for d in state["devices"] if d["tailscale_id"] == "server")
        assert (server["name"], server["target"], server["status"]) == (
            "My server",
            "operator@server.tail.test",
            "offline",
        )
        status["BackendState"] = "NeedsLogin"
        fixture.write_text(json.dumps(status))
        try:
            api("/devices/discover", {})
            raise AssertionError(
                "Disconnected Tailscale was reported as a successful sync"
            )
        except urllib.error.HTTPError:
            pass
        assert len(api("/state")["devices"]) == 3
        print(
            "PASS: startup discovery, SSH filtering, offline hosts, idempotent sync, persistent custom logins, and failed-sync preservation"
        )
    finally:
        process.send_signal(signal.SIGINT)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
