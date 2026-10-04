"""Provider contracts at the actual stdio and shell boundaries."""

import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

import native


class NativeTests(unittest.TestCase):
    def test_silent_provider_times_out_instead_of_hanging_the_worker(self):
        client = native.AcpClient(
            [sys.executable, "-c", "import time; time.sleep(0.2)"],
            lambda value: None,
            lambda *args: {},
        )
        try:
            with self.assertRaises(TimeoutError):
                client.request("initialize", {}, timeout=0.03)
        finally:
            client.close()

    def test_remote_command_preserves_paths_and_does_not_expand_shell_input(self):
        command = native.launch("codex", "desktop", "/tmp/game's $(printf bad) folder")
        self.assertEqual(command[:2], ["ssh", "-T"])
        self.assertIn("desktop", command)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cwd = root / "game's $(printf bad) folder"
            cwd.mkdir()
            # Execute the same remote shell string locally with a harmless CLI.
            (root / "codex").write_text("#!/bin/sh\npwd\n")
            (root / "codex").chmod(0o700)
            import os

            env = {**os.environ, "PATH": str(root) + ":" + os.environ["PATH"]}
            actual = native.launch("codex", "desktop", str(cwd))[-1]
            result = subprocess.run(
                ["sh", "-c", actual],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual(result.stdout.strip(), str(cwd))

    def test_cua_driver_becomes_the_computer_use_of_a_strand_where_it_is_installed(
        self,
    ):
        def device(output):
            return unittest.mock.patch.object(native, "on_device", return_value=output)

        with device(None):
            self.assertEqual(native.computer_use("mac"), (None, []))
        with device("CUA=relative/cua-driver\n"):
            self.assertEqual(native.computer_use("mac"), (None, []))
        found = (
            "CUA=/Users/me/.local/bin/cua-driver\n"
            "OFF=mcp_servers.computer-use\n"
            'OFF=plugins."unified-computer-use@openai-bundled"\n'
            "OFF=mcp_servers.anything-else\n"
        )
        with device(found):
            cua, own = native.computer_use("mac")
        self.assertEqual(cua, "/Users/me/.local/bin/cua-driver")
        self.assertEqual(
            own,
            [
                "mcp_servers.computer-use",
                'plugins."unified-computer-use@openai-bundled"',
            ],
        )
        arguments = native.codex_arguments(cua, own)
        self.assertEqual(arguments[-3:], ["app-server", "--listen", "stdio://"])
        for expected in (
            'mcp_servers.cua-driver.command="/Users/me/.local/bin/cua-driver"',
            'mcp_servers.cua-driver.args=["mcp"]',
            "mcp_servers.computer-use.enabled=false",
            "mcp_servers.cua_repl.enabled=false",
        ):
            self.assertIn(expected, arguments)
        # Without cua-driver a Codex strand starts exactly as before.
        self.assertEqual(
            native.codex_arguments(None, []),
            ["codex", "-c", 'web_search="live"', "app-server", "--listen", "stdio://"],
        )

    def test_rejects_ssh_option_injection_and_unknown_providers(self):
        for provider, target in [("codex", "-oProxyCommand=bad"), ("sh", "desktop")]:
            with self.assertRaises(ValueError):
                native.launch(provider, target, "/tmp")

    def test_copilot_resumes_without_replaying_loaded_messages(self):
        fixture = """import json,sys
for line in sys.stdin:
    q=json.loads(line); m=q.get("method")
    if m=="initialize":
        result={"protocolVersion":1,"agentCapabilities":{"loadSession":True,"mcpCapabilities":{"http":True}}}
    elif m=="session/load":
        assert q["params"]["sessionId"]=="existing-session"
        print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"existing-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"old answer"}}}}),flush=True)
        result={}
    elif m=="session/prompt":
        assert q["params"]["sessionId"]=="existing-session"
        for text in ["Fresh ","answer"]:
            print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"existing-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}}}),flush=True)
        print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"existing-session","update":{"sessionUpdate":"tool_call","toolCallId":"read","title":"Read README","kind":"read","status":"in_progress"}}}),flush=True)
        print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"existing-session","update":{"sessionUpdate":"tool_call_update","toolCallId":"read","status":"completed","content":[{"type":"content","content":{"type":"text","text":"File contents"}}]}}}),flush=True)
        result={"stopReason":"end_turn"}
    else: raise AssertionError(m)
    print(json.dumps({"jsonrpc":"2.0","id":q["id"],"result":result}),flush=True)
"""
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "fixture.py"
            script.write_text(fixture)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                native.run_acp(
                    [sys.executable, str(script)],
                    {"native_id": "existing-session", "cwd": "/work/game"},
                    "Continue",
                    [],
                    lambda *a: {},
                )
            frames = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(
                "".join(f["delta"] for f in frames if f["type"] == "message.delta"),
                "Fresh answer",
            )
            self.assertEqual(
                [f["text"] for f in frames if f["type"] == "message"], ["Fresh answer"]
            )
            self.assertNotIn("old answer", output.getvalue())
            tool = next(f for f in frames if f["type"] == "tool.result")
            self.assertEqual(tool["name"], "read")
            self.assertTrue(tool["result"]["ok"])


if __name__ == "__main__":
    unittest.main()
