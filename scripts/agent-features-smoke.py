"""Native-session, scoped MCP, view and approval checks against an isolated server.
Set HUB_LIVE_CODEX_TEST=1 to also exercise the installed Codex runtime.
Set HUB_UI_REVIEW_DIR to save a real coordinator-generated view for browser review.
"""

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

ROOT = Path(__file__).resolve().parents[1]
PORT = 4336
TOKEN = "agent-feature-integration-only-token"
BASE = f"http://127.0.0.1:{PORT}"


def api(path, payload=None, token=TOKEN):
    request = urllib.request.Request(
        BASE + "/api" + path,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as error:
        error.add_note(error.read().decode())
        raise


def wait(fn, seconds=20):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        try:
            result = fn()
            if result:
                return result
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.15)
    raise AssertionError("Timed out waiting for expected server state")


def rejected(path, payload=None, token=TOKEN):
    try:
        api(path, payload, token)
    except urllib.error.HTTPError as e:
        assert e.code in (400, 401)
        return
    raise AssertionError("Unexpectedly accepted " + path)


FIXTURE = """import json,sys,os,time,urllib.request
from pathlib import Path
task=json.load(sys.stdin);chat=task['chat_id'];text=task['history'][-1]['payload']['text']
Path(os.environ['FIXTURE_TASKS'],chat+'.json').write_text(json.dumps(task))
def emit(**p):print(json.dumps(p),flush=True)
emit(type='session',native_id=(task['conversation'].get('agent')or{}).get('native_id')or'provider-session-1')
if text=='hold':time.sleep(120)
else:emit(type='message',text='Native fixture completed',message_id='m')
"""


SSH_FIXTURE = """#!/usr/bin/env python3
import os,sys,time
from pathlib import Path
if '--' not in sys.argv or not sys.argv[sys.argv.index('--')+1].startswith('auth-fixture'):
    os.execv('/usr/bin/ssh', ['ssh', *sys.argv[1:]])
host=sys.argv[sys.argv.index('--')+1]
root=Path(os.environ['SSH_FIXTURE_DIR'])
if not (root/(host+'.approved')).exists():
    print('# Tailscale SSH requires an additional check.', file=sys.stderr, flush=True)
    print('# To authenticate, visit: https://login.tailscale.com/a/fixture-only', file=sys.stderr, flush=True)
    while not (root/(host+'.approved')).exists(): time.sleep(.05)
    print('# Authentication checked with Tailscale SSH.', file=sys.stderr, flush=True)
(root/(host+'.ran')).touch()
os.execvp('sh', ['sh', '-lc', sys.argv[-1]])
"""


def check_ssh_auth(temp):
    def events(chat, kind):
        return [
            e
            for e in api("/state")["events"]
            if e["scope"] == chat and e["kind"] == kind
        ]

    for mode in ("approve", "cancel", "stop", "close"):
        target = "auth-fixture-" + mode
        api("/devices", {"name": target, "target": target})
        device = next(d for d in api("/state")["devices"] if d["target"] == target)
        chat = api("/chats", {})["id"]
        api("/chats/" + chat + "/messages", {"text": "hold"})
        wait(lambda: (temp / "tasks" / f"{chat}.json").exists())
        with ThreadPoolExecutor(max_workers=1) as pool:
            opening = pool.submit(
                api,
                "/tools",
                {
                    "chat_id": chat,
                    "name": "open_terminal",
                    "arguments": {"device_id": device["id"], "name": "Auth fixture"},
                },
            )
            request = wait(lambda: events(chat, "agent.requested"))[-1]["payload"]
            assert request["kind"] == "tailscale_auth"
            assert request["auth_url"] == "https://login.tailscale.com/a/fixture-only"
            assert not opening.done(), "SSH returned instead of waiting for the user"
            # Allocating and closing a different session must not wait on this SSH check.
            other = api("/chats", {})["id"]
            started = time.monotonic()
            local = api(
                "/sessions",
                {"chat_id": other, "name": "Unaffected", "device_id": "local"},
            )
            assert time.monotonic() - started < 5
            api("/chats/" + other + "/close", {})
            assert any(
                s["id"] == local["id"] and s["closed"]
                for s in api("/state")["sessions"]
            )
            if mode == "approve":
                (temp / (target + ".approved")).touch()
            elif mode == "cancel":
                api(
                    f"/chats/{chat}/requests/{request['request_id']}",
                    {"choice": "cancel"},
                )
            else:
                api("/chats/" + chat + "/" + mode, {})
            result = opening.result(timeout=10)
            if mode == "approve":
                assert result["ok"], result
                assert (
                    events(chat, "agent.answered")[-1]["payload"]["answer"]["choice"]
                    == "connected"
                )
                assert (temp / (target + ".ran")).exists()
            else:
                assert not result["ok"], result
                assert "cancelled" in result["error"], result
                assert not (temp / (target + ".ran")).exists()
            if mode != "close":
                api("/chats/" + chat + "/close", {})
            assert next(c for c in api("/state")["chats"] if c["id"] == chat)["closed"]
    print(
        "PASS SSH reauthentication: inline prompt, original command resumes, cancel/stop/close terminate it, other terminals stay usable",
        flush=True,
    )


def launch(root, data, embedding, extra=None):
    process = subprocess.Popen(
        [str(ROOT / "target/debug/hub-server")],
        cwd=ROOT,
        env={
            **os.environ,
            "HUB_ROOT": str(root),
            "HUB_DATA_DIR": str(data),
            "HUB_DISCOVERY": "off",
            "HUB_PORT": str(PORT),
            "HUB_TOKEN": TOKEN,
            "OPENROUTER_API_KEY": "local-fixture",
            "HUB_EMBEDDING_URL": embedding,
            **(extra or {}),
        },
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    wait(lambda: api("/state"))
    return process


def stop(p):
    p.send_signal(signal.SIGINT)
    try:
        p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()
    p.stderr.close()


def check_claude_sessions(temp):
    parent = api("/chats", {"coordinator_provider": "claude"})["id"]
    api(f"/chats/{parent}/messages", {"text": "hold"})
    task = wait(lambda: json.loads((temp / "tasks" / f"{parent}.json").read_text()))
    assert task["conversation"]["coordinator_provider"] == "claude"
    assert task["conversation"]["agent"] is None
    for mode in ("approve", "cancel"):
        target = "auth-fixture-claude-" + mode
        api("/devices", {"name": target, "target": target})
        device = next(d for d in api("/state")["devices"] if d["target"] == target)
        child = api(
            "/tools",
            {
                "chat_id": parent,
                "name": "start_agent",
                "arguments": {
                    "provider": "claude",
                    "device_id": device["id"],
                    "cwd": "/tmp",
                    "prompt": "hold",
                },
            },
        )
        assert child["ok"], child
        chat = child["result"]["chat"]["id"]
        request = wait(
            lambda: next(
                (
                    e["payload"]
                    for e in api("/state")["events"]
                    if e["scope"] == chat and e["kind"] == "agent.requested"
                ),
                None,
            )
        )
        assert request["kind"] == "tailscale_auth"
        assert not (temp / "tasks" / f"{chat}.json").exists()
        if mode == "cancel":
            api(f"/chats/{chat}/requests/{request['request_id']}", {"choice": "cancel"})
            wait(lambda: chat not in api("/state")["running"])
            assert not (temp / "tasks" / f"{chat}.json").exists()
            continue
        (temp / (target + ".approved")).touch()
        task = wait(lambda: json.loads((temp / "tasks" / f"{chat}.json").read_text()))
        assert task["execution"]["target"] == target
        assert task["conversation"]["agent"]["provider"] == "claude"
        scoped = task["execution"]["mcp_token"]
        listing = api(f"/agent-mcp/{chat}", {"id": 1, "method": "tools/list"}, scoped)
        assert not {"start_agent", "send_agent", "stop_agent"}.intersection(
            tool["name"] for tool in listing["result"]["tools"]
        )
        for name in ("start_agent", "send_agent", "stop_agent"):
            denied = api("/tools", {"chat_id": chat, "name": name, "arguments": {}})
            assert not denied["ok"], denied
        api(f"/chats/{chat}/stop", {})
        followup = api(
            "/tools",
            {
                "chat_id": parent,
                "name": "send_agent",
                "arguments": {"chat_id": chat, "text": "continue"},
            },
        )
        assert followup["ok"], followup
        wait(lambda: chat not in api("/state")["running"])
        task = json.loads((temp / "tasks" / f"{chat}.json").read_text())
        assert task["conversation"]["agent"]["native_id"] == "provider-session-1"
    api(f"/chats/{parent}/stop", {})
    print(
        "PASS Claude coordinator delegation, remote auth/cancellation, native resume and role restrictions",
        flush=True,
    )


with (
    tempfile.TemporaryDirectory(prefix="gofer-check-") as directory,
    embedding_provider() as embedding,
):
    temp = Path(directory)
    (temp / "agent").mkdir()
    (temp / "agent/.venv").symlink_to(ROOT / "agent/.venv", target_is_directory=True)
    (temp / "tasks").mkdir()
    (temp / "agent/worker.py").write_text(FIXTURE)
    (temp / "agent/consolidate.py").write_text("print('{\"claims\": []}')\n")
    (temp / "agent/push.py").symlink_to(ROOT / "agent/push.py")
    (temp / "bin").mkdir()
    shim = temp / "bin/ssh"
    shim.write_text(SSH_FIXTURE)
    shim.chmod(0o755)
    p = launch(
        temp,
        temp / "data",
        embedding,
        {
            "FIXTURE_TASKS": str(temp / "tasks"),
            "SSH_FIXTURE_DIR": str(temp),
            "PATH": str(temp / "bin") + os.pathsep + os.environ["PATH"],
        },
    )
    try:
        api("/devices", {"name": "Desktop", "target": "desktop", "id": "desktop"})
        device = next(d for d in api("/state")["devices"] if d["target"] == "desktop")
        chat = api(
            "/chats",
            {
                "agent": {
                    "provider": "codex",
                    "device_id": device["id"],
                    "cwd": "/work/game",
                }
            },
        )["id"]
        api("/chats/" + chat + "/messages", {"text": "hold"})
        task = wait(lambda: json.loads((temp / "tasks" / f"{chat}.json").read_text()))
        assert task["execution"]["target"] == "desktop"
        scoped = task["execution"]["mcp_token"]
        req = api(
            "/chats/" + chat + "/requests",
            {
                "title": "Continue?",
                "options": [
                    {"id": "yes", "label": "Continue"},
                    {"id": "no", "label": "Decline"},
                ],
            },
        )["request_id"]
        rejected(f"/chats/{chat}/requests/{req}", {"choice": "forged"})
        api(f"/chats/{chat}/requests/{req}", {"choice": "no"})
        assert api(f"/chats/{chat}/requests/{req}")["answer"]["choice"] == "no"
        rejected(f"/chats/{chat}/requests/{req}", {"choice": "yes"})

        def mcp(name, args):
            return api(
                "/agent-mcp/" + chat,
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {"name": name, "arguments": args},
                },
                scoped,
            )

        assert "result" in mcp(
            "show_ui",
            {
                "view_id": "progress",
                "title": "Progress",
                "html": '<p id="status">Ready</p>',
                "script": "tailnet.onData(d=>document.getElementById('status').textContent=d.status)",
                "data": {"status": "Working"},
                "actions": [
                    {"id": "retry", "label": "Retry", "prompt": "Retry this task"}
                ],
            },
        )
        assert "error" in mcp("start_agent", {})
        rejected("/state", token=scoped)
        rejected("/agent-mcp/another", {"id": 1, "method": "ping"}, scoped)
        api("/chats/" + chat + "/stop", {})
        wait(lambda: chat not in api("/state")["running"])
        rejected("/agent-mcp/" + chat, {"id": 1, "method": "ping"}, scoped)
        api("/chats/" + chat + "/messages", {"text": "continue"})
        wait(lambda: chat not in api("/state")["running"])
        task = json.loads((temp / "tasks" / f"{chat}.json").read_text())
        assert task["conversation"]["agent"]["native_id"] == "provider-session-1"
        rejected(
            f"/chats/{chat}/views/progress/actions",
            {"request_id": "invalid", "revision": 1, "action_id": "retry"},
        )
        import uuid

        action = {
            "request_id": str(uuid.uuid4()),
            "revision": 1,
            "action_id": "retry",
            "data": {"quality": "high"},
        }
        api(f"/chats/{chat}/views/progress/actions", action)
        wait(lambda: chat not in api("/state")["running"])
        before = len(api("/state")["events"])
        api(f"/chats/{chat}/views/progress/actions", action)
        assert len(api("/state")["events"]) == before
        key = api("/push/config")["public_key"]
        assert len(key) > 80
        assert (temp / "data/push.json").stat().st_mode & 0o777 == 0o600
        parent = api("/chats", {})["id"]
        api("/chats/" + parent + "/messages", {"text": "hold"})
        wait(lambda: (temp / "tasks" / f"{parent}.json").exists())
        child = api(
            "/tools",
            {
                "chat_id": parent,
                "name": "start_agent",
                "arguments": {
                    "provider": "codex",
                    "device_id": device["id"],
                    "cwd": "/work/game",
                    "prompt": "hello",
                },
            },
        )
        assert child["ok"], child
        child_id = child["result"]["chat"]["id"]
        assert child["result"]["chat"]["parent_id"] == parent
        wait(lambda: child_id not in api("/state")["running"])
        result = api(
            "/tools",
            {
                "chat_id": parent,
                "name": "read_agent",
                "arguments": {"chat_id": child_id},
            },
        )
        assert result["ok"], result
        api("/chats/" + parent + "/stop", {})
        check_ssh_auth(temp)
        check_claude_sessions(temp)
        print(
            "PASS native identity/resume, scoped MCP/revocation, inline requests/views/actions, delegation and private push keys",
            flush=True,
        )
    finally:
        stop(p)
    if os.environ.get("HUB_LIVE_CODEX_TEST") == "1":
        project = temp / "project"
        project.mkdir()
        p = launch(ROOT, temp / "live", embedding)
        try:
            chat = api(
                "/chats",
                {
                    "agent": {
                        "provider": "codex",
                        "device_id": "local",
                        "cwd": str(project),
                    }
                },
            )["id"]
            api(
                "/chats/" + chat + "/messages",
                {
                    "text": "Remember the marker copper-otter-731. Use gofer_show_ui to display a tiny card with view_id demo, title Native session, html <p>Native Codex connected</p>, no actions. Then reply in one sentence."
                },
            )
            wait(lambda: chat not in api("/state")["running"], 180)
            state = api("/state")
            errors = [
                e["payload"]
                for e in state["events"]
                if e["scope"] == chat and e["kind"] == "agent.error"
            ]
            assert not errors, errors
            assert any(
                e["kind"] == "ui.updated" and e["scope"] == chat
                for e in state["events"]
            ), [
                (e["kind"], e["payload"]) for e in state["events"] if e["scope"] == chat
            ]
            native_id = next(c for c in state["chats"] if c["id"] == chat)["agent"][
                "native_id"
            ]
            assert native_id
            api(
                "/chats/" + chat + "/messages",
                {
                    "text": "What marker did I give you? Reply with only the marker. Do not use any tools."
                },
            )
            wait(lambda: chat not in api("/state")["running"], 180)
            state = api("/state")
            answer = [
                e["payload"]["text"]
                for e in state["events"]
                if e["scope"] == chat and e["kind"] == "message.assistant"
            ][-1]
            assert "copper-otter-731" in answer, answer
            print(
                "PASS live Codex dynamic UI tool and native persisted-context resume",
                flush=True,
            )
        finally:
            stop(p)
    if review_dir := os.environ.get("HUB_UI_REVIEW_DIR"):
        p = launch(ROOT, temp / "ui-review", embedding)
        try:
            chat = api("/chats", {})["id"]
            api(
                "/chats/" + chat + "/messages",
                {
                    "text": "Make a small interactive focus timer here in chat. Let me name my task, choose 15, 25 or 45 minutes, and start, pause or reset it."
                },
            )
            wait(lambda: chat not in api("/state")["running"], 240)
            events = [e for e in api("/state")["events"] if e["scope"] == chat]
            errors = [e["payload"] for e in events if e["kind"] == "agent.error"]
            assert not errors, errors
            views = [e["payload"] for e in events if e["kind"] == "ui.updated"]
            assert views, "Coordinator did not publish a view"
            assert views[-1]["script"], "Timer must be interactive"
            output = Path(review_dir)
            output.mkdir(parents=True, exist_ok=True)
            (output / "focus-timer.json").write_text(json.dumps(views[-1], indent=2))
            print(
                f"PASS real coordinator published an interactive view. Browser review required: {output / 'focus-timer.json'}",
                flush=True,
            )
        finally:
            stop(p)
