"""Image publication through the real agent protocol, API, SSH transport and Vecgra.

The worker emits controlled receipts; the SSH fixture runs the real, quoted file
command locally. No account usage, real remote devices, or user sessions involved.
"""

import base64
import json
import os
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII="
TOKEN = "image-check-private-token-32-characters"


def main():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"

    def request(path, payload=None, auth=True, headers=None):
        h = {"Content-Type": "application/json", **(headers or {})}
        if auth:
            h["Authorization"] = "Bearer " + TOKEN
        return urllib.request.urlopen(
            urllib.request.Request(
                base + path,
                data=json.dumps(payload).encode() if payload is not None else None,
                headers=h,
            ),
            timeout=15,
        )

    def api(path, payload=None):
        with request("/api" + path, payload) as response:
            return json.load(response)

    def wait_for(fn):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                if result := fn():
                    return result
            except OSError:
                pass
            time.sleep(0.1)
        raise AssertionError("Image check timed out")

    def status(path, expected, **kwargs):
        try:
            with request(path, **kwargs) as response:
                assert response.status == expected
        except urllib.error.HTTPError as error:
            assert error.code == expected, (error.code, expected)

    def stop(child):
        child.send_signal(signal.SIGINT)
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()

    with tempfile.TemporaryDirectory(prefix="hub-images-") as temporary:
        root = Path(temporary)
        (root / "agent/.venv/bin").mkdir(parents=True)
        (root / "agent/.venv/bin/python").symlink_to(ROOT / "agent/.venv/bin/python")
        source = root / "screen 'literal $(touch SHOULD_NOT_EXIST)'.png"
        source.write_bytes(base64.b64decode(PNG))
        (root / "agent/worker.py").write_text("""import json, os, sys, urllib.request
task = json.loads(sys.stdin.readline())
emit = lambda **frame: print(json.dumps(frame), flush=True)
emit(type="tool.result", name="image_generation", result={"ok":True,"result":{
    "type":"imageGeneration", "result":os.environ["TEST_PNG"], "revisedPrompt":"Synthetic image fixture"}})
for device in ["local", os.environ["TEST_DEVICE"]]:
    request = urllib.request.Request(os.environ["HUB_URL"] + "/api/tools", data=json.dumps({
        "chat_id":task["chat_id"],"name":"show_image","arguments":{
            "path":os.environ["TEST_IMAGE"],"device_id":device,"caption":"Screen from " + device}}).encode(),
        headers={"Content-Type":"application/json","Authorization":"Bearer " + os.environ["HUB_TOKEN"]})
    with urllib.request.urlopen(request) as response:
        assert json.load(response)["ok"]
emit(type="message", text="Images displayed.")
""")
        (root / "bin").mkdir()
        ssh = root / "bin/ssh"
        ssh.write_text(
            '#!/bin/sh\n# The target must stay the short configured alias.\nwhile [ "$1" != \'--\' ]; do shift; done\nshift\n[ "$1" = \'image-test\' ] || exit 72\nshift\nexec /bin/sh -c "$1"\n'
        )
        ssh.chmod(0o755)
        env = {
            **os.environ,
            "HUB_ROOT": str(root),
            "HUB_DATA_DIR": str(root / "data"),
            "HUB_PORT": str(port),
            "HUB_BIND": "127.0.0.1",
            "HUB_DISCOVERY": "off",
            "HUB_TOKEN": TOKEN,
            "PATH": f"{root / 'bin'}:{os.environ['PATH']}",
            "TEST_IMAGE": str(source),
            "TEST_PNG": PNG,
            "TEST_DEVICE": "image-test",
            "HUB_PUBLIC_ORIGIN": base,
            "HUB_ALLOWED_HOSTS": "",
        }

        def start():
            child = subprocess.Popen(
                [str(ROOT / "target/debug/hub-server")],
                cwd=root,
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            wait_for(lambda: api("/state"))
            return child

        child = start()
        try:
            device = api("/devices", {"name": "Image test", "target": "image-test"})
            # Device IDs are generated, so let the fixture use the actual ID.
            stop(child)
            env["TEST_DEVICE"] = device["id"]
            child = start()
            chat = api("/chats", {})["id"]
            api(f"/chats/{chat}/messages", {"text": "Exercise image publication."})
            state = wait_for(
                lambda: (
                    (s if chat not in s["running"] else None)
                    if (s := api("/state"))
                    else None
                )
            )
            events = [e for e in state["events"] if e["scope"] == chat]
            assert not [e for e in events if e["kind"] == "agent.error"], events
            receipts = [e for e in events if e["kind"] == "tool.result"]
            assert len(receipts) == 3 and all(
                e["payload"].get("images") for e in receipts
            ), receipts
            assert receipts[-1]["payload"]["images"][0]["device_id"] == device["id"]
            assert not (root / "SHOULD_NOT_EXIST").exists(), (
                "Image paths must not be shell-expanded"
            )
            assert PNG not in json.dumps(state), (
                "Binary data leaked into state/model context"
            )
            image_url = receipts[0]["payload"]["images"][0]["url"]
            with request(image_url) as response:
                assert response.read() == base64.b64decode(PNG)
                assert response.headers["Content-Type"] == "image/png"
                assert response.headers["X-Content-Type-Options"] == "nosniff"
            status(image_url, 401, auth=False)
            status(image_url, 403, headers={"Origin": "https://other.example"})
            status("/api/artifacts/not-a-file.png", 404)
            status("/api/artifacts/%2Fetc%2Fpasswd", 404)
            # Browser image requests use the same login cookie as the app.
            with request(
                image_url, auth=False, headers={"Cookie": "gofer_token=" + TOKEN}
            ) as response:
                assert response.read() == base64.b64decode(PNG)
            source.unlink()
            ssh.unlink()
            stop(child)
            child = start()
            assert next(
                e for e in api("/state")["events"] if e["id"] == receipts[-1]["id"]
            )["payload"]["images"]
            with request(image_url) as response:
                assert response.read() == base64.b64decode(PNG)
            print(
                "Images: generated + local + SSH; exact binary, path quoting, auth, MIME, persistence and offline replay passed."
            )
        finally:
            stop(child)


if __name__ == "__main__":
    main()
