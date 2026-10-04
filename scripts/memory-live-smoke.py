"""Live memory check on an isolated server: real Claude thread turns, consolidation,
recall, supersession and the wrong endpoint. Spends Claude usage and OpenRouter credit.

    set -a; . ./.env; set +a
    agent/.venv/bin/python scripts/memory-live-smoke.py [report.json]
"""

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PORT = 4610
BASE = f"http://127.0.0.1:{PORT}"
OUTPUT = Path(sys.argv[1] if len(sys.argv) > 1 else "memory-live.json")
KEEP = {
    "message.user",
    "memory.recalled",
    "agent.started",
    "agent.session",
    "agent.restarted",
    "tool.result",
    "message.assistant",
    "agent.error",
    "agent.finished",
    "memory.written",
    "memory.retracted",
    "memory.restored",
    "memory.error",
}


def api(path, payload=None):
    request = urllib.request.Request(
        BASE + "/api" + path,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def wait(fn, seconds, what):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        try:
            result = fn()
            if result:
                return result
        except OSError:
            pass
        time.sleep(0.5)
    raise AssertionError("Timed out waiting for " + what)


def events(after=0):
    return [
        e
        for e in api("/state")["events"]
        if e["scope"] == thread and e["id"] > after and e["kind"] in KEEP
    ]


def turn(text):
    """Send one thread message; return the turn's events up to agent.finished."""
    start = max(e["id"] for e in api("/state")["events"])
    api(f"/chats/{thread}/messages", {"text": text})

    def finished():
        recorded = events(start)
        return (
            recorded
            if recorded[-1:] and recorded[-1]["kind"] == "agent.finished"
            else None
        )

    recorded = wait(finished, 300, "agent.finished")
    errors = [e["payload"] for e in recorded if e["kind"] == "agent.error"]
    assert not errors, errors
    kinds = [e["kind"] for e in recorded]
    if "memory.recalled" in kinds:
        assert kinds.index("memory.recalled") < kinds.index("agent.started"), kinds
    log.append({"step": text, "events": recorded})
    return recorded


def written(after, test):
    """Wait for consolidation of the turn that started after `after`."""

    def find():
        for e in events(after):
            if e["kind"] == "memory.error":
                raise AssertionError(e["payload"])
            if e["kind"] == "memory.written" and any(map(test, e["payload"]["claims"])):
                return e
        return None

    event = wait(find, 60, "memory.written")
    log[-1]["events"].append(event)
    return next(c for c in event["payload"]["claims"] if test(c))


def recalled(recorded):
    return next(
        (e["payload"] for e in recorded if e["kind"] == "memory.recalled"), None
    )


def recalled_ids(recorded):
    payload = recalled(recorded)
    return (
        [i["id"] for i in payload["items"] if i["kind"] == "claim"] if payload else []
    )


def reply(recorded):
    return [e for e in recorded if e["kind"] == "message.assistant"][-1]["payload"][
        "text"
    ]


def indexed(claim):
    wait(
        lambda: api(f"/memory/element/node/{claim}")["vectors"] == 1,
        60,
        f"claim {claim} to be embedded",
    )


log = []
with tempfile.TemporaryDirectory(prefix="gofer-live-") as data:
    server = subprocess.Popen(
        [str(ROOT / "target/debug/hub-server")],
        cwd=ROOT,
        env={
            **os.environ,
            "HUB_PORT": str(PORT),
            "HUB_BIND": "127.0.0.1",
            "HUB_DATA_DIR": data,
            "HUB_DISCOVERY": "off",
            "HUB_TOKEN": "",
        },
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        state = wait(lambda: api("/state"), 30, "the server")
        thread = state["thread_id"]
        assert thread, "No thread in /api/state"
        wait(lambda: api("/state")["embedding_status"] == "ready", 60, "embeddings")

        a = turn("Remember this about me: I use uv for Python, never pip.")
        uv = written(a[0]["id"] - 1, lambda c: "uv" in c["text"].lower())
        indexed(uv["id"])

        b = turn("What do I use to install Python packages? One line.")
        assert uv["id"] in recalled_ids(b), recalled(b)
        assert "uv" in reply(b).lower(), reply(b)

        c = turn("Correction: I switched to pixi instead of uv for new projects.")
        pixi = written(
            c[0]["id"] - 1, lambda c: uv["id"] in [s["id"] for s in c["supersedes"]]
        )
        assert api(f"/memory/element/node/{uv['id']}")["state"] == "superseded"
        graph = api(f"/memory/graph?node={pixi['id']}")
        supersedes = [
            e
            for e in graph["edges"]
            if e["label"] == "SUPERSEDES"
            and (e["source"], e["target"]) == (pixi["id"], uv["id"])
        ]
        assert supersedes, graph["edges"]
        indexed(pixi["id"])

        c2 = turn("Which tool do I use for new Python projects? One line.")
        assert pixi["id"] in recalled_ids(c2) and uv["id"] not in recalled_ids(c2), (
            recalled(c2)
        )

        retracted = api(f"/memory/claims/{pixi['id']}/wrong", {})
        assert retracted["state"] == "retracted"
        d = turn("Which tool do I use for new Python projects? One line.")
        assert pixi["id"] not in recalled_ids(d), recalled(d)
        log[-1]["events"][:0] = [
            e for e in events(c2[-1]["id"]) if e["kind"] == "memory.retracted"
        ]

        sessions = {
            e["payload"]["native_id"]
            for step in log
            for e in step["events"]
            if e["kind"] == "agent.session"
        }
        assert len(sessions) == 1, f"The thread session changed: {sessions}"
        assert not any(
            e["kind"] == "agent.restarted" for step in log for e in step["events"]
        )
        final = api("/state")
        result = {
            "thread_id": thread,
            "model": final["model"],
            "embedding_model": final["embedding_model"],
            "embedding_dimensions": final["embedding_dimensions"],
            "thread_session": sessions.pop(),
            "claims": {
                "uv": api(f"/memory/element/node/{uv['id']}"),
                "pixi": api(f"/memory/element/node/{pixi['id']}"),
            },
            "supersedes_edges": supersedes,
            "steps": log,
            "memory_events": [e for e in events() if e["kind"].startswith("memory.")],
        }
        for claim in result["claims"].values():
            claim.pop("vector")
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_text(json.dumps(result, indent=1) + "\n")
    finally:
        server.send_signal(signal.SIGINT)
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
print(
    "PASS: claims written after thread turns, recalled before them, superseded, "
    f"retracted, one resumed Claude session. Evidence: {OUTPUT}"
)
