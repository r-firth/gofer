"""Worker protocol checks without spending account usage or running user tools."""

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import worker
from openai_codex.generated.v2_all import (
    AgentMessageDeltaNotification,
    CommandExecutionOutputDeltaNotification,
    ItemCompletedNotification,
    ItemStartedNotification,
    TurnCompletedNotification,
)
from openai_codex.models import Notification, UnknownNotification


def item_event(method, item):
    model = (
        ItemStartedNotification
        if method == "item/started"
        else ItemCompletedNotification
    )
    return Notification(
        method,
        model.model_validate(
            {
                "threadId": "codex-thread",
                "turnId": "turn-1",
                "item": item,
                "startedAtMs" if method == "item/started" else "completedAtMs": 1,
            }
        ),
    )


def completed(status="completed"):
    return Notification(
        "turn/completed",
        TurnCompletedNotification.model_validate(
            {
                "threadId": "codex-thread",
                "turn": {
                    "id": "turn-1",
                    "items": [],
                    "itemsView": "full",
                    "status": status,
                    "error": {"message": "Search service unavailable"}
                    if status == "failed"
                    else None,
                },
            }
        ),
    )


FINAL = {
    "id": "answer",
    "type": "agentMessage",
    "phase": "final_answer",
    "text": json.dumps(
        {"text": "Verified answer [source](https://example.com)", "tools": []}
    ),
}


class WorkerTests(unittest.TestCase):
    def test_native_codex_resumes_the_saved_thread_on_its_device(self):
        output = io.StringIO()
        calls = []

        def request(client, method, params, **kwargs):
            # Keep the SDK's thread_resume method real: its first argument is
            # the ID string, unlike thread_start's options object.
            self.assertEqual(method, "thread/resume")
            self.assertEqual(params["threadId"], "saved-thread")
            calls.append(("launch", client.config.launch_args_override))
            calls.append(("resume", params))
            return SimpleNamespace(thread=SimpleNamespace(id="saved-thread"))

        plain = {**FINAL, "text": "Remembered the previous turn"}
        thread = SimpleNamespace(
            turn=lambda *a, **k: SimpleNamespace(
                stream=lambda: iter([item_event("item/completed", plain), completed()])
            )
        )
        task = {
            "chat_id": "hub-chat",
            "devices": [],
            "sessions": [],
            "history": [{"kind": "message.user", "payload": {"text": "Continue"}}],
            "recall": [],
            "conversation": {
                "agent": {
                    "provider": "codex",
                    "device_id": "desktop",
                    "cwd": "/work/game",
                    "native_id": "saved-thread",
                }
            },
            "execution": {"target": "desktop"},
        }
        with (
            tempfile.TemporaryDirectory() as data,
            patch.dict(os.environ, {"HUB_DATA_DIR": data}),
            patch.object(worker.CodexClient, "start"),
            patch.object(worker.CodexClient, "initialize"),
            patch.object(worker.CodexClient, "request", request),
            patch.object(worker, "Thread", lambda *a: thread),
            patch("sys.stdin", io.StringIO(json.dumps(task))),
            contextlib.redirect_stdout(output),
        ):
            worker.main()
        resume = next(value for kind, value in calls if kind == "resume")
        self.assertEqual(resume["threadId"], "saved-thread")
        self.assertEqual(resume["cwd"], "/work/game")
        self.assertEqual(resume["approvalPolicy"], "never")
        self.assertEqual(resume["sandbox"], "danger-full-access")
        self.assertNotIn("approvalsReviewer", resume)
        self.assertIn("desktop", calls[0][1])
        frames = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(
            next(f["native_id"] for f in frames if f["type"] == "session"),
            "saved-thread",
        )
        self.assertEqual(
            next(f["text"] for f in frames if f["type"] == "message"),
            "Remembered the previous turn",
        )

    def test_native_session_streams_plain_text_without_a_json_envelope(self):
        output = io.StringIO()
        plain = {**FINAL, "text": "Native answer"}

        def events():
            yield item_event("item/started", {**plain, "text": ""})
            yield Notification(
                "item/agentMessage/delta",
                AgentMessageDeltaNotification(
                    thread_id="codex-thread",
                    turn_id="turn-1",
                    item_id="answer",
                    delta="Native answer",
                ),
            )
            frames = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(
                "".join(f["delta"] for f in frames if f["type"] == "message.delta"),
                "Native answer",
            )
            yield item_event("item/completed", plain)
            yield completed()

        thread = SimpleNamespace(turn=lambda *a, **k: SimpleNamespace(stream=events))
        with contextlib.redirect_stdout(output):
            worker.run_decision(thread, "test", "test", structured=False)
        self.assertEqual(
            [
                json.loads(line)["text"]
                for line in output.getvalue().splitlines()
                if json.loads(line)["type"] == "message"
            ],
            ["Native answer"],
        )

    def test_streams_only_user_facing_json_text_before_completion(self):
        text = 'First line\nA "quote", a slash \\ and a rocket 🚀.'
        decision = {"title": "hidden title", "tools": [], "text": text}
        encoded = json.dumps(decision)
        output = io.StringIO()

        def events():
            yield item_event("item/started", {**FINAL, "text": ""})
            # Split every escape, Unicode surrogate, and field boundary.
            for char in encoded:
                yield Notification(
                    "item/agentMessage/delta",
                    AgentMessageDeltaNotification(
                        thread_id="codex-thread",
                        turn_id="turn-1",
                        item_id="answer",
                        delta=char,
                    ),
                )
            frames = [json.loads(line) for line in output.getvalue().splitlines()]
            deltas = [f for f in frames if f["type"] == "message.delta"]
            self.assertTrue(
                deltas, "Text must be emitted before the completed item arrives"
            )
            self.assertEqual("".join(f["delta"] for f in deltas), text)
            self.assertNotIn("hidden title", json.dumps(deltas))
            yield item_event("item/completed", {**FINAL, "text": encoded})
            yield completed()

        thread = SimpleNamespace(turn=lambda *a, **k: SimpleNamespace(stream=events))
        with contextlib.redirect_stdout(output):
            result = worker.run_decision(thread, "test", "test")
        self.assertEqual(result, decision)
        frames = [json.loads(line) for line in output.getvalue().splitlines()]
        finals = [f for f in frames if f["type"] == "message"]
        self.assertEqual(len(finals), 1)
        self.assertEqual(finals[0]["text"], text)
        self.assertEqual(
            len({f["message_id"] for f in frames if f["type"].startswith("message")}), 1
        )

    def test_streams_commentary_and_does_not_repeat_it_on_completion(self):
        note = {
            **FINAL,
            "id": "note",
            "phase": "commentary",
            "text": "Checking the desktop.",
        }
        delta = Notification(
            "item/agentMessage/delta",
            AgentMessageDeltaNotification(
                thread_id="codex-thread",
                turn_id="turn-1",
                item_id="note",
                delta=note["text"],
            ),
        )
        with tempfile.TemporaryDirectory() as data:
            frames = self.run_worker(
                [
                    item_event("item/started", {**note, "text": ""}),
                    delta,
                    item_event("item/completed", note),
                    item_event("item/completed", FINAL),
                    completed(),
                ],
                data,
            )
        streamed = [f for f in frames if f["type"] == "message.delta"]
        self.assertEqual([f["delta"] for f in streamed], [note["text"]])
        self.assertEqual(
            [f["text"] for f in frames if f["type"] == "message"],
            [note["text"], json.loads(FINAL["text"])["text"]],
        )

    def test_raw_tool_receipt_preserves_output_the_model_received(self):
        def raw(item):
            return Notification(
                "rawResponseItem/completed",
                UnknownNotification(
                    params={
                        "threadId": "codex-thread",
                        "turnId": "turn-1",
                        "item": item,
                    }
                ),
            )

        with tempfile.TemporaryDirectory() as data:
            frames = self.run_worker(
                [
                    raw(
                        {
                            "type": "custom_tool_call",
                            "id": "call-item",
                            "call_id": "call-1",
                            "name": "exec",
                            "input": "text(await tools.exec_command({cmd: 'printf early; sleep 2; printf late'}));",
                        }
                    ),
                    raw(
                        {
                            "type": "custom_tool_call_output",
                            "id": "output-item",
                            "call_id": "call-1",
                            "output": [{"type": "input_text", "text": "earlylate"}],
                        }
                    ),
                    raw(
                        {
                            "type": "reasoning",
                            "summary": [],
                            "encrypted_content": "private-reasoning",
                        }
                    ),
                    raw(
                        {
                            "type": "message",
                            "role": "developer",
                            "content": [{"text": "private-instructions"}],
                        }
                    ),
                    item_event("item/completed", FINAL),
                    completed(),
                ],
                data,
            )
        result = next(
            (
                f
                for f in frames
                if f["type"] == "tool.result" and f.get("item_id") == "call-1"
            ),
            None,
        )
        self.assertIsNotNone(
            result,
            "Record the real tool response even when native command events omit early output",
        )
        self.assertEqual(result["result"]["result"]["output"], "earlylate")
        self.assertIsNone(
            result["result"]["ok"],
            "Receiving a tool response alone does not prove success",
        )
        self.assertNotIn("private-reasoning", json.dumps(frames))
        self.assertNotIn("private-instructions", json.dumps(frames))

    def test_native_command_output_is_emitted_before_completion(self):
        command = {
            "type": "commandExecution",
            "id": "cmd-1",
            "command": "printf evidence",
            "cwd": "/tmp",
            "commandActions": [],
            "status": "inProgress",
            "source": "agent",
        }
        delta = Notification(
            "item/commandExecution/outputDelta",
            CommandExecutionOutputDeltaNotification(
                thread_id="codex-thread",
                turn_id="turn-1",
                item_id="cmd-1",
                delta="evidence\n",
            ),
        )
        with tempfile.TemporaryDirectory() as data:
            frames = self.run_worker(
                [
                    item_event("item/started", command),
                    delta,
                    item_event(
                        "item/completed",
                        {
                            **command,
                            "status": "completed",
                            "exitCode": 0,
                            "aggregatedOutput": "evidence\n",
                        },
                    ),
                    item_event("item/completed", FINAL),
                    completed(),
                ],
                data,
            )
        output = next((f for f in frames if f["type"] == "tool.output"), None)
        self.assertIsNotNone(
            output, "Native stdout must reach chat while the command is running"
        )
        self.assertEqual(output["delta"], "evidence\n")
        self.assertEqual(output["item_id"], "cmd-1")
        self.assertEqual(output["thread_id"], "codex-thread")
        self.assertLess(
            frames.index(output),
            next(i for i, f in enumerate(frames) if f["type"] == "tool.result"),
        )

    def run_worker(self, events, data, task_extra=None):
        class FakeThread:
            def run(self, *args, **kwargs):
                return SimpleNamespace(final_response=FINAL["text"])

            def turn(self, *args, **kwargs):
                testcase.turns.append(args[0])
                return SimpleNamespace(stream=lambda: iter(events))

        testcase = self
        self.turns = []

        class FakeCodex:
            def __init__(self, config, **kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def initialize(self):
                pass

            def thread_start(self, params):
                testcase.assertEqual(params["approvalPolicy"], "never")
                testcase.assertEqual(params["sandbox"], "danger-full-access")
                testcase.assertNotIn("approvalsReviewer", params)
                Path(params["cwd"], "artifact.txt").write_text("keep me")
                return SimpleNamespace(thread=SimpleNamespace(id="codex-thread"))

        output = io.StringIO()
        task = {
            "chat_id": "hub-chat",
            "conversation": {"agent": None, "coordinator_provider": "codex"},
            "history": [],
            "recall": [],
            "devices": [],
            "sessions": [],
            **(task_extra or {}),
        }
        with (
            patch.object(worker, "CodexClient", FakeCodex),
            patch.object(worker, "Thread", lambda client, thread_id: FakeThread()),
            patch.dict(os.environ, {"HUB_DATA_DIR": data}),
            patch("sys.stdin", io.StringIO(json.dumps(task))),
            contextlib.redirect_stdout(output),
        ):
            worker.main()
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def test_native_search_is_recorded_with_query_sources_and_identity(self):
        search = {
            "type": "webSearch",
            "id": "search-1",
            "query": "Python docs",
            "action": {"type": "search", "query": "Python docs"},
            "results": [{"url": "https://docs.python.org/3/", "title": "Python docs"}],
        }
        with tempfile.TemporaryDirectory() as data:
            frames = self.run_worker(
                [
                    item_event("item/started", search),
                    item_event("item/completed", search),
                    item_event("item/completed", FINAL),
                    completed(),
                ],
                data,
            )
        receipt = next((f for f in frames if f["type"] == "tool.result"), None)
        self.assertIsNotNone(receipt, "Native web searches must reach Hub history")
        self.assertEqual(receipt["name"], "web_search")
        self.assertEqual(receipt["item_id"], "search-1")
        self.assertTrue(receipt["result"]["ok"])
        self.assertEqual(
            receipt["result"]["result"]["results"][0]["url"],
            "https://docs.python.org/3/",
        )
        self.assertEqual(
            frames[-1]["text"], "Verified answer [source](https://example.com)"
        )

    def test_failed_native_command_is_not_reported_as_success(self):
        command = {
            "type": "commandExecution",
            "id": "cmd-1",
            "command": "false",
            "cwd": "/tmp",
            "commandActions": [],
            "status": "failed",
            "exitCode": 1,
            "source": "agent",
            "aggregatedOutput": "command failed",
        }
        with tempfile.TemporaryDirectory() as data:
            frames = self.run_worker(
                [
                    item_event("item/completed", command),
                    item_event("item/completed", FINAL),
                    completed(),
                ],
                data,
            )
        receipt = next((f for f in frames if f["type"] == "tool.result"), None)
        self.assertIsNotNone(receipt)
        self.assertFalse(receipt["result"]["ok"])
        self.assertEqual(
            receipt["result"]["result"]["aggregatedOutput"], "command failed"
        )

    def test_native_turn_error_is_not_silently_accepted(self):
        with tempfile.TemporaryDirectory() as data:
            with self.assertRaisesRegex(RuntimeError, "Search service unavailable"):
                self.run_worker([completed("failed")], data)

    def test_names_a_conversation_without_an_extra_model_turn(self):
        answer = {
            **FINAL,
            "text": json.dumps(
                {"text": "On it", "title": "Desktop game build", "tools": []}
            ),
        }
        with tempfile.TemporaryDirectory() as data:
            frames = self.run_worker(
                [item_event("item/completed", answer), completed()],
                data,
                {"needs_title": True},
            )
        titles = [f for f in frames if f["type"] == "title"]
        self.assertEqual(titles, [{"type": "title", "name": "Desktop game build"}])
        with tempfile.TemporaryDirectory() as data:
            frames = self.run_worker(
                [item_event("item/completed", answer), completed()],
                data,
                {"needs_title": False},
            )
        self.assertFalse(any(f["type"] == "title" for f in frames))

    def test_attached_pictures_go_to_codex_with_the_message(self):
        with tempfile.TemporaryDirectory() as data:
            picture = Path(data) / "photo.jpg"
            picture.write_bytes(b"\xff\xd8\xff fixture")
            image = {"path": str(picture), "mime_type": "image/jpeg", "name": "a"}
            self.run_worker(
                [item_event("item/completed", FINAL), completed()],
                data,
                {"images": [image]},
            )
            # The coordinator runs on the Gofer host, so Codex reads the file itself.
            self.assertEqual(self.turns[0][1:], [worker.LocalImageInput(str(picture))])
            self.assertIsInstance(self.turns[0][0], worker.TextInput)
            # A Codex on another machine is sent the picture's bytes.
            self.assertEqual(
                worker.image_inputs([image], remote=True),
                [worker.ImageInput("data:image/jpeg;base64,/9j/IGZpeHR1cmU=")],
            )

    def test_native_artifacts_survive_worker_exit(self):
        with tempfile.TemporaryDirectory() as data:
            self.run_worker([item_event("item/completed", FINAL), completed()], data)
            self.assertTrue(
                (Path(data) / "workspace/artifact.txt").exists(),
                "Native artifacts must persist",
            )
            self.assertEqual(
                (Path(data) / "workspace/artifact.txt").read_text(), "keep me"
            )


if __name__ == "__main__":
    unittest.main()
