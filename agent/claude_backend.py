"""Official Agent SDK over the user's CLI, locally or over registered-device SSH.

The SDK subprocess adapter is pinned: its command builder is reused verbatim,
then wrapped in the existing SSH transport. No CLI patching or credential reads.
"""

import asyncio
import json
import os
import shutil
import signal
import subprocess
import uuid
import warnings
from collections import deque
from dataclasses import replace

import native
from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from claude_agent_sdk._internal.transport.subprocess_cli import SubprocessCLITransport
from claude_agent_sdk.types import StreamEvent
from jsonschema import validate
from pydantic_core import from_json

# Never inherit API/alternate-provider authentication or host workspace secrets.
# CLAUDE_CODE_OAUTH_TOKEN stays: it is a subscription token (claude setup-token), and the only
# sign-in a Mac has over SSH, where the login Keychain is locked.
SCRUB = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_SIMPLE",
    "CLAUDECODE",
    "HUB_TOKEN",
    "HUB_MCP_TOKEN",
    "OPENROUTER_API_KEY",
)


class ClaudeError(RuntimeError):
    """A credential-safe error suitable for the conversation."""


class SessionNotFound(ClaudeError):
    """The CLI has no saved conversation for the session it was asked to resume."""


# The CLI refreshes its sign-in under a lock. A second process that needs the refresh at the same
# moment (another turn, memory being written) is told so instead of being made to wait.
REFRESHING = "Failed to refresh OAuth token"
# Shown when permissions are bypassed and a permission callback is also set, which is how the
# adapter runs. It is not an error and must not reach the conversation as one.
warnings.filterwarnings("ignore", message="can_use_tool will not be invoked")


def said(message):
    """Why a response failed, in the API's own words when it gave any."""
    return " ".join(
        block.text.strip()
        for block in message.content
        if isinstance(block, TextBlock) and block.text.strip()
    )[:400] or str(message.error)


async def patiently(attempt, tries=4, wait=5):
    """Run `attempt`, again after a pause while another process holds the sign-in refresh."""
    for remaining in range(tries - 1, -1, -1):
        try:
            return await attempt()
        except ClaudeError as error:
            if REFRESHING not in str(error) or not remaining:
                raise
            await asyncio.sleep(wait)


async def run(**kwargs):
    try:
        return await patiently(lambda: _run(**kwargs))
    except ClaudeError:
        raise
    except Exception as error:
        raise ClaudeError(
            "Claude session failed ("
            + type(error).__name__
            + "). Check the CLI version, "
            "project directory and subscription sign-in on the execution device."
        ) from None


def subscription_command(arguments):
    return ["env", *[part for key in SCRUB for part in ("-u", key)], *arguments]


def cli_path(target):
    if target:
        return "claude"
    search_path = os.pathsep.join(
        [
            os.environ.get("PATH", ""),
            os.path.expanduser("~/.local/bin"),
            os.path.expanduser("~/.npm-global/bin"),
            "/opt/homebrew/bin",
            "/usr/local/bin",
        ]
    )
    executable = shutil.which("claude", path=search_path)
    if not executable:
        raise ClaudeError("Claude Code is not installed on this device")
    return executable


def check_subscription(target, cwd):
    command = native.launch(
        "claude",
        target,
        cwd,
        arguments=subscription_command([cli_path(target), "auth", "status"]),
    )
    try:
        result = subprocess.run(
            command,
            cwd=None if target else cwd,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        status = json.loads(result.stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        raise ClaudeError(
            "Cannot check Claude sign-in on this device. Install/update Claude Code and run claude auth login there."
        ) from error
    if (
        result.returncode
        or not isinstance(status, dict)
        or not status.get("loggedIn")
        or status.get("authMethod") not in ("claude.ai", "oauth_token")
    ):
        raise ClaudeError(
            "Claude needs a Claude subscription sign-in on this device. Run claude auth login there, "
            "or on a Mac reached over SSH export CLAUDE_CODE_OAUTH_TOKEN (from claude setup-token) in "
            "~/.zshenv; API keys are not used."
        )


class DeviceTransport(SubprocessCLITransport):
    def __init__(self, options, target=None, reverse=None):
        # ClaudeSDKClient configures this on a copy, but does not pass that copy
        # to custom transports. Mirror its stdio routing without modifying the
        # client options (which reject callback + permission_prompt_tool_name).
        transport_options = (
            replace(options, permission_prompt_tool_name="stdio")
            if options.can_use_tool
            else options
        )
        super().__init__(prompt=self.empty_prompt(), options=transport_options)
        self.target = target
        self.reverse = reverse
        self.device_cwd = str(options.cwd)
        if target:
            self._cwd = None

    @staticmethod
    async def empty_prompt():
        if False:
            yield {}

    async def _check_claude_version(self):
        # The SDK's check runs a local executable even for custom transports.
        # Auth preflight checks the actual device; protocol initialization fails
        # explicitly for incompatible versions, without falling back to a bundle.
        return

    def _build_command(self):
        return native.launch(
            "claude",
            self.target,
            self.device_cwd,
            self.reverse,
            arguments=subscription_command(super()._build_command()),
        )


async def permission(name, value, context, request_input):
    if name == "AskUserQuestion":
        questions = value.get("questions", [])
        answer = await asyncio.to_thread(
            request_input,
            {
                "title": "Claude needs your input",
                "questions": [
                    {
                        "id": str(i),
                        "label": q["question"],
                        "options": q.get("options", []),
                    }
                    for i, q in enumerate(questions)
                ],
            },
        )
        answers = answer.get("answers", {})
        if any(str(i) not in answers for i in range(len(questions))):
            return PermissionResultDeny(message="Questions were not answered")
        return PermissionResultAllow(
            updated_input={
                **value,
                "answers": {
                    q["question"]: answers[str(i)] for i, q in enumerate(questions)
                },
            }
        )
    return PermissionResultAllow(updated_input=value)


class Receipts:
    def __init__(self, structured=False):
        self.structured = structured
        self.identity = str(uuid.uuid4())
        self.text = ""
        self.tools = {}
        self.structured_index = None
        self.raw_decision = ""
        self.stream_after_tool = False
        self.decision_identity = None
        self.last_sealed = None

    def emit(self, kind, **payload):
        native.emit(kind, source="claude", **payload)

    def seal(self):
        if self.text:
            self.emit("message", message_id=self.identity, text=self.text)
            self.last_sealed = (self.identity, self.text)
        self.identity = str(uuid.uuid4())
        self.text = ""

    def finish_decision(self, text):
        # Claude may emit another assistant message after StructuredOutput before
        # the result envelope arrives. Keep the output's identity across that seal.
        identity = self.decision_identity or self.identity
        if text and self.last_sealed != (identity, text):
            self.emit("message", message_id=identity, text=text)

    def accept(self, message):
        if isinstance(message, SystemMessage) and message.subtype == "init":
            native.emit(
                "session",
                native_id=message.data["session_id"],
                model=message.data.get("model"),
            )
        elif isinstance(message, StreamEvent) and not message.parent_tool_use_id:
            event = message.event
            delta = ""
            kind = event.get("type")
            if kind in {
                "message_start",
                "message_stop",
                "content_block_start",
                "content_block_stop",
            }:
                self.structured_index = None
                self.raw_decision = ""
            if kind == "message_start":
                self.seal()
                self.stream_after_tool = False
            if self.structured:
                if (
                    event.get("type") == "content_block_start"
                    and event.get("content_block", {}).get("name") == "StructuredOutput"
                ):
                    # A new output attempt must not append to an earlier JSON buffer.
                    self.seal()
                    self.decision_identity = self.identity
                    self.structured_index = event.get("index")
                elif (
                    event.get("type") == "content_block_delta"
                    and self.structured_index is not None
                    and event.get("index") == self.structured_index
                    and event.get("delta", {}).get("type") == "input_json_delta"
                ):
                    self.raw_decision += event["delta"]["partial_json"]
                    try:
                        partial = from_json(
                            self.raw_decision, allow_partial="trailing-strings"
                        )
                    except ValueError:
                        return
                    text = partial.get("text", "") if isinstance(partial, dict) else ""
                    if isinstance(text, str) and text.startswith(self.text):
                        delta = text[len(self.text) :]
            elif (
                kind == "content_block_start"
                and event.get("content_block", {}).get("type") == "tool_use"
            ):
                # The completed assistant message supplies authoritative tool inputs.
                # Hold later text until that receipt can be placed before it.
                self.stream_after_tool = True
            elif (
                kind == "content_block_delta"
                and not self.stream_after_tool
                and event.get("delta", {}).get("type") == "text_delta"
            ):
                delta = event["delta"]["text"]
            if delta:
                if not self.text:
                    self.emit("message.started", message_id=self.identity, text="")
                self.text += delta
                self.emit("message.delta", message_id=self.identity, delta=delta)
        elif isinstance(message, AssistantMessage):
            if message.error:
                raise ClaudeError(
                    "Claude authentication failed. Run claude auth login on the execution device."
                    if message.error == "authentication_failed"
                    # The API's own words say what to do (a model this CLI is too old for, a
                    # limit reached); the error kind alone does not.
                    else "Claude response failed: " + said(message)
                )
            text = ""

            def flush_text():
                nonlocal text
                if text:
                    # Reconcile the whole adjacent text run, not each block against
                    # the accumulated stream. Reuse its streamed message identity.
                    self.text = text
                    self.seal()
                    text = ""

            for block in message.content:
                if (
                    isinstance(block, TextBlock)
                    and not self.structured
                    and not message.parent_tool_use_id
                ):
                    text += block.text
                elif isinstance(block, ToolUseBlock):
                    flush_text()
                    if self.structured and block.name == "StructuredOutput":
                        continue
                    self.seal()
                    receipt = {
                        "name": block.name,
                        "item_id": block.id,
                        "arguments": block.input,
                    }
                    self.tools[block.id] = receipt
                    self.emit("tool.started", **receipt)
            flush_text()
            self.stream_after_tool = False
            self.structured_index = None
            self.raw_decision = ""
        elif isinstance(message, UserMessage) and isinstance(message.content, list):
            for block in message.content:
                if (
                    isinstance(block, ToolResultBlock)
                    and block.tool_use_id in self.tools
                ):
                    self.emit(
                        "tool.result",
                        **self.tools.pop(block.tool_use_id),
                        result={
                            "ok": not block.is_error,
                            "result": {"output": block.content},
                        },
                    )


async def _run(
    *,
    prompt,
    base,
    cwd,
    resume,
    target,
    reverse,
    servers,
    schema,
    request_input,
    call_tool,
    needs_title=False,
):
    await asyncio.to_thread(check_subscription, target, cwd)
    cli = cli_path(target)
    # CLI stderr stays private; it is only matched for a missing session.
    errors = deque(maxlen=50)
    options = ClaudeAgentOptions(
        cli_path=cli,
        cwd=cwd,
        resume=resume,
        system_prompt={"type": "preset", "preset": "claude_code", "append": base},
        model=os.environ.get("HUB_CLAUDE_MODEL") or "claude-opus-5-5",
        effort="medium",
        permission_mode="bypassPermissions",
        allowed_tools=["WebSearch", "WebFetch"],
        include_partial_messages=True,
        settings=json.dumps({"forceLoginMethod": "claudeai", "apiKeyHelper": ""}),
        setting_sources=["user", "project", "local"],
        mcp_servers=servers,
        output_format={"type": "json_schema", "schema": schema} if schema else None,
        can_use_tool=lambda name, value, context: permission(
            name, value, context, request_input
        ),
        stderr=errors.append,  # Never expose CLI stderr/config/credentials in chat.
    )
    client = ClaudeSDKClient(
        options=options, transport=DeviceTransport(options, target, reverse)
    )
    current = asyncio.current_task()
    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGUSR1, current.cancel)
    failure = None
    try:
        await client.connect()
        for _ in range(50):
            native.emit("status", text="Thinking")
            await client.query(prompt)
            receipts = Receipts(structured=bool(schema))
            result = None
            async for message in client.receive_response():
                receipts.accept(message)
                if isinstance(message, ResultMessage):
                    result = message
            if not schema:
                receipts.seal()
            if result is None or result.is_error or result.subtype != "success":
                raise ClaudeError(
                    "Claude turn failed"
                    + (": " + result.subtype if result else ": no completion received")
                )
            if not schema:
                return
            decision = result.structured_output
            validate(decision, schema)
            receipts.finish_decision(decision["text"])
            title = " ".join(decision["title"].split()).strip('"')[:80]
            if needs_title and title:
                native.emit("title", name=title)
                needs_title = False
            if not decision["tools"]:
                return
            results = []
            for call in decision["tools"]:
                args = json.loads(call["arguments_json"])
                if not isinstance(args, dict):
                    raise ValueError("Tool arguments must be an object")
                try:
                    result = await asyncio.to_thread(call_tool, call["name"], args)
                except Exception as error:
                    result = {
                        "ok": False,
                        "error": "Workspace tool request failed ("
                        + type(error).__name__
                        + ")",
                    }
                results.append({"name": call["name"], "result": result})
            prompt = json.dumps({"tool_receipts": results})
        raise ClaudeError(
            "Reached the turn's tool-round limit. Send another message to continue."
        )
    except asyncio.CancelledError:
        try:
            await asyncio.wait_for(client.interrupt(), timeout=1)
        except Exception:
            pass
    except Exception as error:
        failure = error
    finally:
        await client.disconnect()
        loop.remove_signal_handler(signal.SIGUSR1)
    if failure:
        if resume and any(
            line.startswith("No conversation found with session ID") for line in errors
        ):
            raise SessionNotFound(
                f"Claude has no saved conversation {resume} on this host to resume."
            ) from None
        raise failure
