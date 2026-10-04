"""Real API/PTY checks, on an isolated localhost instance. No browser automation."""

import json
import os
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from embedding_fixture import embedding_provider
from websockets.sync.client import connect

ROOT = Path(__file__).resolve().parents[1]
PORT = 4320
TOKEN = "integration-check-only-32-characters"
BASE = f"http://127.0.0.1:{PORT}"


def request(path, payload=None, headers=None, auth=True):
    h = {"Content-Type": "application/json"}
    if auth:
        h["Authorization"] = "Bearer " + TOKEN
    h.update(headers or {})
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers=h,
    )
    return urllib.request.urlopen(req, timeout=30)


def api(path, payload=None):
    with request("/api" + path, payload) as response:
        return json.load(response)


def status(path, code, **kwargs):
    try:
        with request(path, **kwargs) as r:
            assert r.status == code, (r.status, code)
    except urllib.error.HTTPError as e:
        assert e.code == code, (e.code, code)


def wait_for(fn, timeout=20):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        try:
            result = fn()
            if result:
                return result
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.2)
    raise AssertionError("Condition did not become true")


def start(data, embedding_key="local-fixture"):
    child = subprocess.Popen(
        [str(ROOT / "target/debug/hub-server")],
        cwd=ROOT,
        env={
            **os.environ,
            "HUB_PORT": str(PORT),
            "HUB_DISCOVERY": "off",
            "HUB_DATA_DIR": data,
            "HUB_TOKEN": TOKEN,
            "OPENROUTER_API_KEY": embedding_key,
            "HUB_EMBEDDING_URL": embedding_url,
            "HUB_ALLOWED_HOSTS": " hub-host:4320,hub-host.test.ts.net:4320,100.64.0.1:4320 ",
        },
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    wait_for(lambda: api("/state"))
    return child


def stop(child):
    child.send_signal(signal.SIGINT)
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()


with (
    tempfile.TemporaryDirectory(prefix="hub-integration-") as data,
    embedding_provider() as embedding_url,
):
    child = start(data)
    session = None
    closing = []
    try:
        with request("/", auth=False) as response:
            assert response.headers.get("Cache-Control") == "no-store", (
                "App HTML can be cached across deployments"
            )
        with request("/build.json", auth=False) as response:
            assert response.headers.get("Cache-Control") == "no-store", (
                "Build manifest can be cached"
            )
            assert isinstance(json.load(response)["build_id"], str)
        for path in ("/sessions", "/devices", "/activity", "/memory"):
            with request(path, auth=False) as response:
                assert response.status == 200
                assert 'rel="manifest"' in response.read().decode()
        for path in ("/sw.js", "/manifest.webmanifest"):
            with request(path, auth=False) as response:
                assert response.headers.get("Cache-Control") == "no-store"
        with request("/manifest.webmanifest", auth=False) as response:
            manifest = json.load(response)
            assert manifest["display"] == "standalone" and manifest["start_url"] == "/"
        for icon in manifest["icons"]:
            with request(icon["src"], auth=False) as response:
                blob = response.read()
                assert blob[:8] == b"\x89PNG\r\n\x1a\n"
                width, height = int.from_bytes(blob[16:20]), int.from_bytes(blob[20:24])
                assert icon["sizes"] == f"{width}x{height}"
        status("/api/state", 401, auth=False)
        for host in (
            "hub-host:4320",
            "hub-host.test.ts.net:4320",
            "100.64.0.1:4320",
        ):
            status("/", 200, auth=False, headers={"Host": host})
            status("/api/state", 401, auth=False, headers={"Host": host})
            status(
                "/api/state",
                200,
                headers={"Host": host, "Origin": f"http://{host}"},
            )
        status("/api/state", 403, headers={"Host": "evil.example"})
        status("/api/state", 403, headers={"Host": "hub-host:9999"})
        status(
            "/api/state",
            403,
            headers={"Host": "hub-host:4320", "Origin": "https://evil.example"},
        )
        status("/api/state", 403, headers={"Origin": "https://evil.example"})
        status("/api/login", 401, payload={"token": "incorrect"}, auth=False)
        with request("/api/login", {"token": TOKEN}, auth=False) as response:
            cookie = response.headers["Set-Cookie"].split(";")[0]
        status("/api/state", 200, auth=False, headers={"Cookie": cookie})
        status("/api/devices", 400, payload={"target": "-oProxyCommand=bad"})
        chat = api("/chats", {"name": "Close lifecycle verification"})
        with ThreadPoolExecutor(max_workers=2) as pool:
            closing = list(
                pool.map(
                    lambda name: api(
                        "/sessions", {"name": name, "chat_id": chat["id"]}
                    ),
                    ("Build", "Logs"),
                )
            )
        assert closing[0]["id"] == closing[1]["id"], (
            "Concurrent opens allocated multiple terminals for one conversation"
        )
        status(
            "/api/sessions",
            400,
            payload={"chat_id": chat["id"], "device_id": "another-device"},
        )
        # A different session must remain live when this conversation closes.
        session = api("/sessions", {"name": "Persistence verification"})
        sid = session["id"]
        assert (
            len([c for c in api("/state")["chats"] if sid in c["session_ids"]]) == 1
        ), "Terminal has no owning conversation"

        def saved_chat():
            return next(c for c in api("/state")["chats"] if c["id"] == chat["id"])

        closing_ids = {s["id"] for s in closing}
        assert set(saved_chat()["session_ids"]) == closing_ids
        other = api("/chats", {"name": "Isolated terminal"})
        status(
            f"/api/chats/{other['id']}/terminals",
            400,
            payload={"session_id": closing[0]["id"]},
        )
        assert not next(c for c in api("/state")["chats"] if c["id"] == other["id"])[
            "session_ids"
        ]
        pid_file = Path(data) / "terminal-process.pid"
        subprocess.run(
            [
                "tmux",
                "-L",
                "gofer",
                "send-keys",
                "-t",
                "hub_" + closing[0]["id"],
                f"sleep 300 & echo $! > '{pid_file}'; wait",
                "Enter",
            ],
            check=True,
        )
        wait_for(lambda: pid_file.exists() and pid_file.read_text().strip())
        process_pid = int(pid_file.read_text())
        api(f"/chats/{chat['id']}/close", {})
        assert saved_chat()["closed"]
        assert all(
            next(t for t in api("/state")["sessions"] if t["id"] == closed_id)["closed"]
            for closed_id in closing_ids
        ), "Closing a conversation left linked terminals open"
        # Conversation close persists cleanup intent immediately; remote/slow
        # terminal shutdown is completed by the background cleanup worker.
        wait_for(
            lambda: all(
                not session.get("cleanup_pending", False)
                for session in api("/state")["sessions"]
                if session["id"] in closing_ids
            )
        )
        for closed_id in closing_ids:
            assert (
                subprocess.run(
                    ["tmux", "-L", "gofer", "has-session", "-t", "hub_" + closed_id],
                    capture_output=True,
                ).returncode
                != 0
            ), "tmux shell is still alive"
            status(
                f"/api/sessions/{closed_id}/input",
                400,
                payload={"text": "Should not execute\n"},
            )

        def process_stopped():
            try:
                os.kill(process_pid, 0)
            except ProcessLookupError:
                return True
            return False

        wait_for(process_stopped)
        assert not next(t for t in api("/state")["sessions"] if t["id"] == sid)[
            "closed"
        ]
        assert (
            subprocess.run(
                ["tmux", "-L", "gofer", "has-session", "-t", "hub_" + sid],
                capture_output=True,
            ).returncode
            == 0
        )
        status(
            f"/api/chats/{chat['id']}/messages",
            400,
            payload={"text": "Should not start"},
        )
        status("/api/sessions", 400, payload={"chat_id": chat["id"]})
        api(f"/chats/{chat['id']}/reopen", {})
        assert not saved_chat()["closed"]
        assert set(saved_chat()["session_ids"]) == closing_ids
        assert all(
            t["closed"] for t in api("/state")["sessions"] if t["id"] in closing_ids
        ), "Reopening history restarted terminals"
        api(f"/chats/{chat['id']}/close", {})
        api(f"/chats/{chat['id']}/close", {})
        api(f"/chats/{other['id']}/close", {})
        print(
            "PASS: session close stops linked shells and processes, preserves unrelated work, and reopening only restores history",
            flush=True,
        )
        status(f"/api/sessions/{sid}/input", 400, payload={"text": "echo disallowed\n"})
        api(f"/sessions/{sid}/control", {"owner": "user"})
        with connect(
            BASE.replace("http:", "ws:") + f"/api/sessions/{sid}/stream",
            additional_headers={"Cookie": cookie},
            open_timeout=10,
        ) as ws:
            ws.send(json.dumps({"type": "resize", "cols": 100, "rows": 28}))
            ws.send(
                json.dumps(
                    {
                        "type": "input",
                        "data": "export HUB_RESTART=retained; printf 'STREAM_%s\\n' verified\n",
                    }
                )
            )
            output = ""
            until = time.monotonic() + 15
            while time.monotonic() < until:
                message = ws.recv(timeout=15)
                output += (
                    message.decode(errors="replace")
                    if isinstance(message, bytes)
                    else message
                )
                if "STREAM_verified" in output:
                    break
            assert "STREAM_verified" in output, "Live PTY output missing"
        print(
            "PASS: auth, origin protection, ownership, and live WebSocket output",
            flush=True,
        )
        with connect(
            BASE.replace("http:", "ws:") + f"/api/sessions/{sid}/stream",
            additional_headers={"Cookie": cookie},
        ) as ws:
            ws.send(
                json.dumps(
                    {
                        "type": "input",
                        "data": "(sleep 2; printf '\\nRECOVERY:%s\\n' survived) & printf 'JOB_%s\\n' started\n",
                    }
                )
            )
            output = ""
            while "JOB_started" not in output:
                message = ws.recv(timeout=15)
                output += (
                    message.decode(errors="replace")
                    if isinstance(message, bytes)
                    else message
                )
        stop(child)
        time.sleep(3)
        child = start(data)
        assert set(saved_chat()["session_ids"]) == closing_ids
        restored = next(c for c in api("/state")["chats"] if c["id"] == other["id"])
        assert restored["closed"] and restored["session_ids"] == []
        assert any(
            s["id"] == sid and s["owner"] == "user" for s in api("/state")["sessions"]
        )
        with connect(
            BASE.replace("http:", "ws:") + f"/api/sessions/{sid}/stream",
            additional_headers={"Cookie": cookie},
        ) as ws:
            ws.send(
                json.dumps(
                    {
                        "type": "input",
                        "data": "printf 'RESTART:%s\\n' \"$HUB_RESTART\"\n",
                    }
                )
            )
            output = ""
            while "RESTART:retained" not in output:
                message = ws.recv(timeout=15)
                output += (
                    message.decode(errors="replace")
                    if isinstance(message, bytes)
                    else message
                )
        print(
            "PASS: session, shell environment, and input ownership survive server restart",
            flush=True,
        )

        def recovered_output():
            result = api("/search?q=RECOVERY%3Asurvived")
            return any(
                e["kind"] == "terminal.output"
                and "RECOVERY:survived" in e["payload"].get("text", "")
                for e in result["results"]
            )

        wait_for(recovered_output, 30)
        print(
            "PASS: output produced while the hub was stopped is recovered into Vecgra",
            flush=True,
        )
        wait_for(lambda: api("/state")["embedding_status"] == "ready", 180)
        api(
            "/devices",
            {"target": "test-memory.invalid", "name": "Automobile repair workstation"},
        )

        def semantic_hit():
            result = api("/search?q=car%20maintenance")
            return result["semantic"] and any(
                "Automobile repair" in json.dumps(e["payload"])
                for e in result["results"]
            )

        wait_for(semantic_hit, 30)
        print(
            "PASS: provider vectors reach Vecgra search without literal query overlap (local fixture)",
            flush=True,
        )
        graph = api("/memory/graph")
        visible = {n["id"] for n in graph["nodes"]}
        assert all(
            e["source"] in visible and e["target"] in visible for e in graph["edges"]
        )
        edge = graph["edges"][0]
        record = api(f"/memory/element/edge/{edge['id']}")
        assert record["source"] == edge["source"] and record["target"] == edge["target"]
        hit = api("/memory/search?q=RECOVERY%3Asurvived&kind=terminal")["hits"][0]
        node = api(f"/memory/element/node/{hit['id']}")
        assert node["id"] == hit["id"] and node["properties"]
        run = api(f"/memory/runs/{hit['run_id']}?anchor={hit['id']}")
        assert any(e["id"] == hit["id"] for e in run["events"])
        hybrid = api("/memory/search?q=car%20maintenance&mode=hybrid")
        assert hybrid["semantic"] and any(
            "Automobile repair" in h["excerpt"] for h in hybrid["hits"]
        )
        assert api("/memory/graph?node=0")["focus"] == 0
        print(
            "PASS: Memory graph identities, vectors, hybrid retrieval, and source-run navigation",
            flush=True,
        )
        assert any(e["kind"] == "terminal.input" for e in api("/state")["events"])
        stop(child)
        child = start(data, embedding_key="")
        wait_for(lambda: api("/state")["embedding_status"] == "unavailable")
        assert api("/state")["embedding_model"] == "google/gemini-embedding-2"
        assert api("/state")["embedding_dimensions"] == 768
        fallback = api("/memory/search?q=Automobile&mode=hybrid")
        assert not fallback["semantic"] and fallback["warning"]
        assert any("Automobile repair" in h["excerpt"] for h in fallback["hits"])
        assert fallback["elapsed_ms"] < 1000, "Missing credentials stalled text search"
        print(
            "PASS: missing OpenRouter key preserves graph/text search and reports semantic fallback",
            flush=True,
        )
        failed_chat = api("/chats", {"name": "Never-connected terminal close check"})
        unreachable = api(
            "/devices",
            {"name": "Unavailable test host", "target": "hub-close-test.invalid"},
        )
        status(
            "/api/sessions",
            400,
            payload={"chat_id": failed_chat["id"], "device_id": unreachable["id"]},
        )
        # The connection failed before any remote command ran. Restoring the
        # server must preserve that fact so closing doesn't require SSH access.
        stop(child)
        child = start(data, embedding_key="")
        api(f"/chats/{failed_chat['id']}/close", {})
        failed_state = next(
            c for c in api("/state")["chats"] if c["id"] == failed_chat["id"]
        )
        assert failed_state["closed"] and not failed_state["closing"]
        assert not failed_state["close_error"]
        assert failed_state["session_ids"]
        assert next(
            t
            for t in api("/state")["sessions"]
            if t["id"] == failed_state["session_ids"][0]
        )["closed"]
        print(
            "PASS: a terminal that never connected can close after restart without SSH access",
            flush=True,
        )
    finally:
        if session:
            try:
                api("/sessions/" + session["id"] + "/close", {})
            except Exception:
                subprocess.run(
                    [
                        "tmux",
                        "-L",
                        "gofer",
                        "kill-session",
                        "-t",
                        "hub_" + session["id"],
                    ],
                    check=False,
                    capture_output=True,
                )
        for terminal in closing:
            subprocess.run(
                ["tmux", "-L", "gofer", "kill-session", "-t", "hub_" + terminal["id"]],
                capture_output=True,
            )
        stop(child)
print("ALL INTEGRATION CHECKS PASSED", flush=True)
