"""Claude protocol, device execution, role, and authentication regressions."""

import asyncio
import contextlib
import io
import json
import os
import shlex
import signal
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import claude_backend as claude
import worker
from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    PermissionResultAllow,
    PermissionResultDeny,
    TextBlock,
    ToolUseBlock,
)
from claude_agent_sdk.types import StreamEvent
from worker import SCHEMA

FIXTURE = """#!/usr/bin/env python3
import json,sys,os
from pathlib import Path
# Newer SDKs pass some options as --name=value.
sys.argv=[p for a in sys.argv for p in (a.split('=',1) if a.startswith('--') and '=' in a else [a])]
assert sys.argv[sys.argv.index('--permission-prompt-tool')+1]=='stdio'
assert sys.argv[sys.argv.index('--allowedTools')+1]=='WebSearch,WebFetch'
assert '--bare' not in sys.argv
assert sys.argv[sys.argv.index('--permission-mode')+1]=='bypassPermissions'
assert sys.argv[sys.argv.index('--model')+1]=='claude-opus-5-5'
assert sys.argv[sys.argv.index('--effort')+1]=='medium'
def send(v): print(json.dumps(v),flush=True)
rounds=0
for line in sys.stdin:
 q=json.loads(line)
 if q['type']=='control_request':
  if q['request']['subtype']=='interrupt': Path(os.environ['FIXTURE_INTERRUPT']).write_text('interrupted')
  send({'type':'control_response','response':{'subtype':'success','request_id':q['request_id'],'response':{}}})
 elif q['type']=='user':
  rounds+=1
  if isinstance(q['message']['content'],list): Path(os.environ['FIXTURE_PROMPT']).write_text(json.dumps(q['message']['content']))
  send({'type':'system','subtype':'init','session_id':'native-session'})
  if q['message']['content']=='CANCEL': continue
  if '--json-schema' in sys.argv:
   decision={'text':'Working' if rounds==1 else 'Done','title':'Fixture title','tools':[{'name':'list_devices','arguments_json':'{}'}] if rounds==1 else []}
   send({'type':'stream_event','uuid':'start','session_id':'native-session','event':{'type':'content_block_start','index':0,'content_block':{'type':'tool_use','name':'StructuredOutput'}}})
   raw=json.dumps(decision)
   for part in [raw[:12],raw[12:]]:
    send({'type':'stream_event','uuid':'delta','session_id':'native-session','event':{'type':'content_block_delta','index':0,'delta':{'type':'input_json_delta','partial_json':part}}})
   send({'type':'stream_event','uuid':'next','session_id':'native-session','event':{'type':'message_start'}})
   send({'type':'assistant','message':{'role':'assistant','model':'fixture','content':[{'type':'text','text':''}]}})
   send({'type':'result','subtype':'success','is_error':False,'duration_ms':1,'duration_api_ms':1,'num_turns':1,'session_id':'native-session','structured_output':decision})
  else:
   assert sys.argv[sys.argv.index('--resume')+1]=='existing-session'
   send({'type':'control_request','request_id':'permission-1','request':{'subtype':'can_use_tool','tool_name':'Bash','input':{'command':'echo fixture'},'tool_use_id':'t'}})
   reply=json.loads(sys.stdin.readline())
   assert reply['response']['response']['behavior']=='allow',reply
   send({'type':'stream_event','uuid':'e','session_id':'native-session','event':{'type':'content_block_delta','delta':{'type':'text_delta','text':'Fresh answer'}}})
   send({'type':'assistant','message':{'role':'assistant','model':'fixture','content':[{'type':'text','text':'Fresh answer'},{'type':'tool_use','id':'t','name':'Read','input':{'file_path':'README'}}]}})
   send({'type':'user','message':{'role':'user','content':[{'type':'tool_result','tool_use_id':'t','content':'contents'}]}})
   send({'type':'result','subtype':'success','is_error':False,'duration_ms':1,'duration_api_ms':1,'num_turns':1,'session_id':'native-session'})
"""


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.frames = []
        patched = patch.object(
            claude.native,
            "emit",
            side_effect=lambda kind, **payload: self.frames.append(
                {"type": kind, **payload}
            ),
        )
        patched.start()
        self.addCleanup(patched.stop)

    def stream(self, receipts, kind, **payload):
        receipts.accept(
            StreamEvent(
                uuid="event", session_id="session", event={"type": kind, **payload}
            )
        )

    def texts(self):
        return [f["text"] for f in self.frames if f["type"] == "message"]

    def test_accumulated_stream_reconciles_adjacent_blocks_once(self):
        receipts = claude.Receipts()
        identity = receipts.identity
        receipts.text = "FirstSecond"
        receipts.accept(
            AssistantMessage(
                content=[TextBlock(text="First"), TextBlock(text="Second")],
                model="fixture",
            )
        )
        receipts.seal()
        self.assertEqual(self.texts(), ["FirstSecond"])
        self.assertEqual(self.frames[0]["message_id"], identity)

    def multi_block_message(self):
        return AssistantMessage(
            content=[
                TextBlock(text="First"),
                TextBlock(text="Second"),
                ToolUseBlock(id="tool", name="Read", input={"file_path": "README"}),
                TextBlock(text="Third"),
                TextBlock(text="Fourth"),
            ],
            model="fixture",
        )

    def assert_text_tool_order(self):
        completed = [f for f in self.frames if f["type"] in {"message", "tool.started"}]
        self.assertEqual(
            [f["type"] for f in completed], ["message", "tool.started", "message"]
        )
        self.assertEqual(self.texts(), ["FirstSecond", "ThirdFourth"])
        self.assertEqual(completed[1]["arguments"], {"file_path": "README"})
        self.assertNotEqual(completed[0]["message_id"], completed[2]["message_id"])

    def test_streamed_multi_block_message_preserves_tool_order_and_identity(self):
        receipts = claude.Receipts()
        self.stream(receipts, "message_start")
        for index, block in enumerate(self.multi_block_message().content):
            self.stream(
                receipts,
                "content_block_start",
                index=index,
                content_block={
                    "type": "text" if isinstance(block, TextBlock) else "tool_use"
                },
            )
            if isinstance(block, TextBlock):
                for part in (block.text[:2], block.text[2:]):
                    self.stream(
                        receipts,
                        "content_block_delta",
                        index=index,
                        delta={"type": "text_delta", "text": part},
                    )
            self.stream(receipts, "content_block_stop", index=index)
        # Text following a tool waits for the authoritative tool receipt.
        self.assertEqual(
            "".join(f["delta"] for f in self.frames if f["type"] == "message.delta"),
            "FirstSecond",
        )
        started = next(
            f["message_id"] for f in self.frames if f["type"] == "message.started"
        )
        receipts.accept(self.multi_block_message())
        self.stream(receipts, "message_stop")
        receipts.seal()
        self.assert_text_tool_order()
        self.assertEqual(
            next(f["message_id"] for f in self.frames if f["type"] == "message"),
            started,
        )
        # Subsequent assistant messages begin with a fresh streaming identity.
        self.stream(receipts, "message_start")
        self.stream(
            receipts,
            "content_block_delta",
            delta={"type": "text_delta", "text": "Next"},
        )
        receipts.accept(
            AssistantMessage(content=[TextBlock(text="Next")], model="fixture")
        )
        self.assertEqual(self.texts(), ["FirstSecond", "ThirdFourth", "Next"])

    def test_nonstreamed_multi_block_message_preserves_all_text_and_tool_order(self):
        receipts = claude.Receipts()
        receipts.accept(self.multi_block_message())
        receipts.seal()
        self.assert_text_tool_order()

    def test_structured_output_resets_between_assistant_messages(self):
        receipts = claude.Receipts(structured=True)
        for text in ("First", "Second"):
            self.stream(receipts, "message_start")
            self.stream(
                receipts,
                "content_block_start",
                index=0,
                content_block={"type": "tool_use", "name": "StructuredOutput"},
            )
            raw = json.dumps({"text": text})
            for part in (raw[:12], raw[12:]):
                self.stream(
                    receipts,
                    "content_block_delta",
                    index=0,
                    delta={"type": "input_json_delta", "partial_json": part},
                )
            self.stream(receipts, "content_block_stop", index=0)
            receipts.accept(
                AssistantMessage(
                    content=[
                        ToolUseBlock(
                            id=text, name="StructuredOutput", input={"text": text}
                        )
                    ],
                    model="fixture",
                )
            )
            self.assertIsNone(receipts.structured_index)
            self.assertEqual(receipts.raw_decision, "")
            self.stream(receipts, "message_stop")
        receipts.seal()
        self.assertEqual(self.texts(), ["First", "Second"])
        self.assertEqual(
            "".join(f["delta"] for f in self.frames if f["type"] == "message.delta"),
            "FirstSecond",
        )

    def test_structured_result_reuses_identity_after_a_following_message(self):
        for final_text in ("Connected", "Connected successfully"):
            with self.subTest(final_text=final_text):
                self.frames.clear()
                receipts = claude.Receipts(structured=True)
                self.stream(
                    receipts,
                    "content_block_start",
                    index=0,
                    content_block={"type": "tool_use", "name": "StructuredOutput"},
                )
                self.stream(
                    receipts,
                    "content_block_delta",
                    index=0,
                    delta={
                        "type": "input_json_delta",
                        "partial_json": '{"text":"Connected"}',
                    },
                )
                identity = receipts.identity
                self.stream(receipts, "content_block_stop", index=0)
                self.stream(receipts, "message_stop")
                self.stream(receipts, "message_start")
                receipts.accept(
                    AssistantMessage(content=[TextBlock(text="")], model="fixture")
                )
                receipts.finish_decision(final_text)
                messages = [f for f in self.frames if f["type"] == "message"]
                self.assertEqual(len(messages), 1 if final_text == "Connected" else 2)
                self.assertEqual({f["message_id"] for f in messages}, {identity})
                self.assertEqual(messages[-1]["text"], final_text)

    def test_structured_block_boundaries_discard_stale_json_and_indices(self):
        for boundary in (
            "message_start",
            "message_stop",
            "content_block_stop",
            "content_block_start",
            "assistant",
        ):
            with self.subTest(boundary=boundary):
                receipts = claude.Receipts(structured=True)
                self.stream(
                    receipts,
                    "content_block_start",
                    index=0,
                    content_block={"type": "tool_use", "name": "StructuredOutput"},
                )
                self.stream(
                    receipts,
                    "content_block_delta",
                    index=0,
                    delta={"type": "input_json_delta", "partial_json": '{"text":'},
                )
                if boundary == "assistant":
                    receipts.accept(AssistantMessage(content=[], model="fixture"))
                else:
                    self.stream(
                        receipts,
                        boundary,
                        index=0,
                        content_block={"type": "tool_use", "name": "Read"},
                    )
                before = len(self.frames)
                self.stream(
                    receipts,
                    "content_block_delta",
                    index=0,
                    delta={"type": "input_json_delta", "partial_json": '"Wrong"}'},
                )
                self.assertEqual(len(self.frames), before)
                self.assertEqual(receipts.raw_decision, "")
                self.assertIsNone(receipts.structured_index)
                # Even without a message-start event, a new output block starts clean.
                self.stream(
                    receipts,
                    "content_block_start",
                    index=0,
                    content_block={"type": "tool_use", "name": "StructuredOutput"},
                )
                self.stream(
                    receipts,
                    "content_block_delta",
                    index=0,
                    delta={
                        "type": "input_json_delta",
                        "partial_json": '{"text":"Fresh"}',
                    },
                )
                self.assertEqual(receipts.text, "Fresh")


class ClaudeTests(unittest.TestCase):
    def run_fixture(self, schema=None, target=None, cancel=False, images=()):
        output = io.StringIO()
        calls = []
        original_emit = claude.native.emit

        def emit(kind, **payload):
            original_emit(kind, **payload)
            if cancel and kind == "session":
                os.kill(os.getpid(), signal.SIGUSR1)

        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "interrupt"
            cli = Path(directory) / "claude"
            cli.write_text(FIXTURE)
            cli.chmod(0o700)
            ssh = Path(directory) / "ssh"
            ssh.write_text(
                '#!/usr/bin/env python3\nimport os,sys\nos.execv("/bin/sh", ["sh", "-c", sys.argv[-1]])\n'
            )
            ssh.chmod(0o700)
            with (
                patch.dict(
                    os.environ,
                    {
                        "PATH": directory + ":" + os.environ["PATH"],
                        "FIXTURE_INTERRUPT": str(marker),
                        "FIXTURE_PROMPT": str(Path(directory) / "prompt"),
                        "HUB_CLAUDE_MODEL": "",
                    },
                ),
                patch.object(claude, "check_subscription"),
                contextlib.redirect_stdout(output),
                patch.object(claude.native, "emit", side_effect=emit),
            ):
                asyncio.run(
                    claude.run(
                        prompt="CANCEL" if cancel else "Continue",
                        base="Test instructions",
                        cwd=directory,
                        resume=None if schema else "existing-session",
                        target=target,
                        reverse=(32123, 4318) if target else None,
                        servers={},
                        schema=schema,
                        request_input=lambda _: self.fail(
                            "Unexpected permission prompt"
                        ),
                        call_tool=lambda name, args: (
                            calls.append((name, args)) or {"ok": True}
                        ),
                        needs_title=True,
                        images=images,
                    )
                )
            if cancel:
                self.assertEqual(marker.read_text(), "interrupted")
            if images:
                self.prompt = json.loads((Path(directory) / "prompt").read_text())
        return [json.loads(line) for line in output.getvalue().splitlines()], calls

    def test_cancellation_interrupts_the_remote_cli_before_closing_transport(self):
        self.run_fixture(target="registered-device", cancel=True)

    def test_native_local_and_remote_stream_receipts_and_resume(self):
        for target in (None, "registered-device"):
            with self.subTest(target=target):
                frames, _ = self.run_fixture(target=target)
                self.assertEqual(
                    [f["text"] for f in frames if f["type"] == "message"],
                    ["Fresh answer"],
                )
                self.assertEqual(
                    [f["delta"] for f in frames if f["type"] == "message.delta"],
                    ["Fresh answer"],
                )
                self.assertEqual(
                    next(f for f in frames if f["type"] == "session")["native_id"],
                    "native-session",
                )
                self.assertTrue(
                    next(f for f in frames if f["type"] == "tool.result")["result"][
                        "ok"
                    ]
                )

    def test_attached_pictures_reach_the_cli_as_image_blocks_with_the_text(self):
        with tempfile.TemporaryDirectory() as directory:
            picture = Path(directory) / "photo.png"
            picture.write_bytes(b"\x89PNG fixture bytes")
            image = {"path": str(picture), "mime_type": "image/png", "name": "a"}
            for target in (None, "registered-device"):
                with self.subTest(target=target):
                    frames, _ = self.run_fixture(target=target, images=[image])
                    self.assertEqual(
                        self.prompt,
                        [
                            {"type": "text", "text": "Continue"},
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/png",
                                    "data": "iVBORyBmaXh0dXJlIGJ5dGVz",
                                },
                            },
                        ],
                    )
                    self.assertEqual(
                        [f["text"] for f in frames if f["type"] == "message"],
                        ["Fresh answer"],
                    )

    def test_coordinator_decisions_execute_workspace_tools_and_return_results(self):
        frames, calls = self.run_fixture(schema=SCHEMA)
        self.assertEqual(calls, [("list_devices", {})])
        self.assertEqual(
            "".join(f["delta"] for f in frames if f["type"] == "message.delta"),
            "WorkingDone",
        )
        started = [f["message_id"] for f in frames if f["type"] == "message.started"]
        self.assertEqual(
            started, [f["message_id"] for f in frames if f["type"] == "message"]
        )
        self.assertEqual(
            [f["text"] for f in frames if f["type"] == "message"], ["Working", "Done"]
        )
        self.assertEqual(
            [f["name"] for f in frames if f["type"] == "title"], ["Fixture title"]
        )

    def test_remote_transport_quotes_project_and_uses_device_cli(self):
        options = ClaudeAgentOptions(
            cli_path="claude", cwd="/work/it's $(bad)", resume="saved-id"
        )
        transport = claude.DeviceTransport(options, "desktop", (32123, 4318))
        command = transport._build_command()
        self.assertIsNone(transport._cwd)
        self.assertIn("127.0.0.1:32123:127.0.0.1:4318", command)
        self.assertIn(shlex.quote(str(options.cwd)), command[-1])
        self.assertRegex(command[-1], r"--resume[ =]saved-id")
        self.assertIn("-u ANTHROPIC_API_KEY", command[-1])
        self.assertNotIn("--bare", command[-1])

    def test_worker_routes_claude_roles_without_starting_codex(self):
        for agent in (
            None,
            {
                "provider": "claude",
                "device_id": "remote",
                "cwd": "/work",
                "native_id": "saved",
            },
        ):
            with tempfile.TemporaryDirectory() as directory:
                task = {
                    "chat_id": "c",
                    "conversation": {"agent": agent, "coordinator_provider": "claude"},
                    "history": [
                        {"kind": "message.user", "payload": {"text": "Continue"}}
                    ],
                    "recall": [],
                    "devices": [],
                    "sessions": [],
                    "execution": {
                        "target": "desktop" if agent else None,
                        "mcp_token": "scoped",
                    },
                }
                with (
                    patch.object(worker.sys, "stdin", io.StringIO(json.dumps(task))),
                    patch.dict(
                        os.environ,
                        {"HUB_DATA_DIR": directory, "HUB_URL": "http://127.0.0.1:4318"},
                    ),
                    patch.object(claude, "run", new_callable=AsyncMock) as run,
                    patch.object(worker, "CodexClient") as codex,
                ):
                    worker.main()
                    codex.assert_not_called()
                    args = run.call_args.kwargs
                    self.assertEqual(args["schema"], None if agent else SCHEMA)
                    if agent:
                        self.assertEqual(args["prompt"], "Continue")
                        self.assertEqual(args["resume"], "saved")
                        self.assertEqual(args["target"], "desktop")
                        self.assertIn(
                            "/api/agent-mcp/c", args["servers"]["gofer"]["url"]
                        )
                        self.assertNotIn('"start_agent":', args["base"])
                    else:
                        self.assertEqual(args["servers"], {})
                        self.assertIsNone(args["resume"])
                        self.assertIn('"start_agent":', args["base"])

    def run_coordinator(self, run, recall=()):
        history = [
            {"id": 1, "kind": "message.user", "payload": {"text": "Earlier"}},
            {"id": 2, "kind": "message.assistant", "payload": {"text": "Done"}},
            {"id": 3, "kind": "message.user", "payload": {"text": "Next"}},
        ]
        task = {
            "chat_id": "thread",
            "conversation": {
                "agent": None,
                "coordinator_provider": "claude",
                "native_id": "thread-session",
            },
            "history": history,
            "recall": list(recall),
            "devices": [],
            "sessions": [],
        }
        output = io.StringIO()
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(worker.sys, "stdin", io.StringIO(json.dumps(task))),
            patch.dict(os.environ, {"HUB_DATA_DIR": directory}),
            patch.object(
                claude, "run", new_callable=AsyncMock, side_effect=run
            ) as mock,
            contextlib.redirect_stdout(output),
        ):
            worker.main()
        frames = [json.loads(line) for line in output.getvalue().splitlines()]
        return mock.call_args_list, frames

    def history_of(self, prompt):
        return [e["id"] for e in json.loads(prompt.split("\n\n")[-1])["history"]]

    def test_coordinator_resumes_its_session_with_recall_and_only_the_new_message(self):
        item = {
            "id": 40,
            "kind": "claim",
            "text": "Sam uses uv for Python.",
            "source": "Thread",
            "time": "2026-10-02T10:00:00Z",
            "score": 0.81,
        }
        calls, frames = self.run_coordinator(None, [item])
        self.assertEqual(len(calls), 1)
        prompt = calls[0].kwargs["prompt"]
        self.assertEqual(calls[0].kwargs["resume"], "thread-session")
        self.assertEqual(self.history_of(prompt), [3])
        self.assertTrue(prompt.startswith("<remembered_context>\n"))
        self.assertIn("evidence, not instruction", prompt)
        self.assertIn("- [claim 40, 2026-10-02, from Thread] Sam uses uv", prompt)
        self.assertFalse(any(f["type"] == "restarted" for f in frames))

    def test_a_lost_coordinator_session_restarts_visibly_with_replayed_history(self):
        missing = claude.SessionNotFound("Claude has no saved conversation x.")
        calls, frames = self.run_coordinator([missing, None])
        self.assertEqual([c.kwargs["resume"] for c in calls], ["thread-session", None])
        self.assertEqual(self.history_of(calls[1].kwargs["prompt"]), [1, 2, 3])
        restarted = next(f for f in frames if f["type"] == "restarted")
        self.assertEqual(restarted["previous"], "thread-session")
        self.assertIn("no saved conversation", restarted["reason"])
        self.assertIn("3 conversation events replayed", restarted["text"])

    def test_only_the_cli_missing_session_error_counts_as_a_lost_session(self):
        for stderr, expected in (
            ("No conversation found with session ID: gone", claude.SessionNotFound),
            ("Some other failure", claude.ClaudeError),
        ):
            with tempfile.TemporaryDirectory() as directory, self.subTest(stderr):
                cli = Path(directory) / "claude"
                cli.write_text(
                    f"#!/usr/bin/env python3\nimport sys\nprint({stderr!r}, file=sys.stderr)\nsys.exit(1)\n"
                )
                cli.chmod(0o700)
                with (
                    patch.dict(
                        os.environ, {"PATH": directory + ":" + os.environ["PATH"]}
                    ),
                    patch.object(claude, "check_subscription"),
                    self.assertRaises(claude.ClaudeError) as raised,
                ):
                    asyncio.run(
                        claude.run(
                            prompt="Next",
                            base="Test instructions",
                            cwd=directory,
                            resume="gone",
                            target=None,
                            reverse=None,
                            servers={},
                            schema=SCHEMA,
                            request_input=lambda _: None,
                            call_tool=lambda *_: None,
                        )
                    )
                self.assertIs(type(raised.exception), expected)

    def test_transport_errors_do_not_publish_credentials_or_raw_protocol(self):
        async def check():
            with patch.object(claude, "_run", side_effect=ValueError("secret bearer")):
                with self.assertRaises(claude.ClaudeError) as error:
                    await claude.run()
                self.assertNotIn("secret", str(error.exception))

        asyncio.run(check())

    def test_a_held_sign_in_refresh_is_waited_out_and_other_failures_are_not(self):
        calls = []

        async def attempt():
            calls.append(1)
            if len(calls) < 3:
                raise claude.ClaudeError(
                    "Claude response failed: Failed to refresh OAuth token: another "
                    "Claude Code process is refreshing it"
                )
            return "answered"

        self.assertEqual(asyncio.run(claude.patiently(attempt, wait=0)), "answered")
        self.assertEqual(len(calls), 3)

        async def broken():
            calls.append(1)
            raise claude.ClaudeError("Claude response failed: rate limited")

        with self.assertRaisesRegex(claude.ClaudeError, "rate limited"):
            asyncio.run(claude.patiently(broken, wait=0))
        self.assertEqual(len(calls), 4)

    def test_auth_preflight_accepts_a_subscription_login_or_token(self):
        for method in ("claude.ai", "oauth_token"):
            with patch.object(
                subprocess,
                "run",
                return_value=subprocess.CompletedProcess(
                    [], 0, json.dumps({"loggedIn": True, "authMethod": method}), ""
                ),
            ) as run:
                # The machine running the tests need not have the CLI installed.
                with patch.object(claude, "cli_path", return_value="claude"):
                    claude.check_subscription(None, "/tmp")
            self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", run.call_args.args[0])
            self.assertIn("ANTHROPIC_API_KEY", run.call_args.args[0])

    def test_auth_preflight_rejects_api_and_never_exposes_status_fields(self):
        for status in (
            {"loggedIn": False},
            {"loggedIn": True, "authMethod": "api_key", "apiKey": "secret"},
        ):
            with patch.object(
                subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 0, json.dumps(status), ""),
            ):
                with (
                    patch.object(claude, "cli_path", return_value="claude"),
                    self.assertRaisesRegex(
                        RuntimeError, "subscription sign-in"
                    ) as error,
                ):
                    claude.check_subscription(None, "/tmp")
                self.assertNotIn("secret", str(error.exception))

    def test_tools_run_without_prompts_and_questions_preserve_answers(self):
        async def check():
            allowed = await claude.permission(
                "Bash",
                {"command": "echo fixture"},
                None,
                lambda _: self.fail("Unexpected permission prompt"),
            )
            self.assertIsInstance(allowed, PermissionResultAllow)
            allowed = await claude.permission(
                "Read", {"file_path": "README"}, None, lambda _: {"choice": "allow"}
            )
            self.assertIsInstance(allowed, PermissionResultAllow)
            self.assertEqual(allowed.updated_input, {"file_path": "README"})
            answer = await claude.permission(
                "AskUserQuestion",
                {"questions": [{"question": "Which branch?", "options": []}]},
                None,
                lambda _: {"answers": {"0": "main"}},
            )
            self.assertEqual(answer.updated_input["answers"], {"Which branch?": "main"})
            unanswered = await claude.permission(
                "AskUserQuestion",
                {"questions": [{"question": "Which branch?", "options": []}]},
                None,
                lambda _: {},
            )
            self.assertIsInstance(unanswered, PermissionResultDeny)

        asyncio.run(check())


if __name__ == "__main__":
    unittest.main()
