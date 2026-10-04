"""Consolidation output validation and its single retry, without spending usage."""

import asyncio
import unittest
from unittest.mock import patch

import consolidate
from claude_agent_sdk import ResultMessage

TASK = {
    "chat": "Thread",
    "speaker": "ryan",
    "date": "3 Oct 2026",
    "turn": {
        "user": {"id": 11, "text": "I switched to pixi instead of uv."},
        "assistant": {"id": 17, "text": "Noted."},
        "receipts": [{"id": 14, "name": "Bash", "ok": True}],
    },
    "active_claims": [{"id": 5, "text": "Ryan uses uv for Python.", "about": ["uv"]}],
}
VALID = {
    "claims": [
        {
            "text": "Ryan uses pixi instead of uv for new Python projects.",
            "about": ["ryan", "pixi"],
            "supersedes": [5],
            "evidence": [11, 17],
        }
    ]
}


def claims(**change):
    return {"claims": [{**VALID["claims"][0], **change}]}


class FakeClient:
    def __init__(self, outputs):
        self.outputs = outputs
        self.prompts = []

    async def connect(self):
        pass

    async def disconnect(self):
        pass

    async def query(self, prompt):
        self.prompts.append(prompt)

    async def receive_response(self):
        yield ResultMessage(
            subtype="success",
            duration_ms=1,
            duration_api_ms=1,
            is_error=False,
            num_turns=1,
            session_id="consolidation",
            structured_output=self.outputs.pop(0),
        )


class ConsolidateTests(unittest.TestCase):
    def extract(self, outputs):
        client = FakeClient(outputs)
        with (
            patch.object(consolidate.claude_backend, "cli_path", return_value="claude"),
            patch.object(consolidate, "ClaudeSDKClient", lambda **_: client),
        ):
            return asyncio.run(consolidate.extract(TASK, "/tmp")), client

    def test_claims_must_cite_this_turn_and_supersede_only_active_claims(self):
        consolidate.check(VALID, TASK)
        consolidate.check({"claims": []}, TASK)
        for invalid in (
            claims(evidence=[99]),
            claims(evidence=[]),
            claims(supersedes=[6]),
            claims(text="x" * 201),
            {"claims": [{"text": "Missing fields"}]},
            {"facts": []},
        ):
            with self.assertRaises(ValueError):
                consolidate.check(invalid, TASK)

    def test_invalid_output_is_retried_once_with_the_reason(self):
        result, client = self.extract([claims(evidence=[99]), VALID])
        self.assertEqual(result, VALID)
        self.assertEqual(len(client.prompts), 2)
        self.assertIn("not from this turn", client.prompts[1])

    def test_a_second_invalid_output_fails_without_another_attempt(self):
        with self.assertRaisesRegex(ValueError, "Invalid memory claims"):
            self.extract([claims(supersedes=[6]), claims(supersedes=[6])])


if __name__ == "__main__":
    unittest.main()
