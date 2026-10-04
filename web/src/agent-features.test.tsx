// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AgentView, InputRequest } from "./AgentFeatures";
import { chatEntries } from "./ToolActivity";
import type { Event } from "./api";
let root: Root;
const event = (id: number, kind: string, payload: Event["payload"]): Event => ({
  id,
  kind,
  payload,
  scope: "chat",
  time: "2026-09-24T01:00:00Z",
});
afterEach(async () => {
  if (root) await act(() => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
async function mount(node: React.ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = '<div id="test"></div>';
  root = createRoot(document.getElementById("test")!);
  await act(() => root.render(node));
}
it("shows a Tailscale sign-in link while waiting and sends cancellation separately", async () => {
  const fetch = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  await mount(
    <InputRequest
      running
      event={event(1, "agent.requested", {
        request_id: "auth",
        kind: "tailscale_auth",
        title: "Sign in to connect to server",
        auth_url: "https://login.tailscale.com/a/test",
        options: [{ id: "cancel", label: "Cancel connection" }],
      })}
    />,
  );
  const link = document.querySelector("a")!;
  expect(link?.href).toBe("https://login.tailscale.com/a/test");
  expect(link.rel).toContain("noreferrer");
  expect(fetch).not.toHaveBeenCalled();
  await act(() =>
    document
      .querySelector<HTMLButtonElement>(".request-options button")!
      .click(),
  );
  expect(fetch).toHaveBeenCalledWith(
    "/api/chats/chat/requests/auth",
    expect.objectContaining({ body: JSON.stringify({ choice: "cancel" }) }),
  );
  expect(document.querySelector("a")).toBeNull();
});
it("does not expose an untrusted or already-resolved sign-in link", async () => {
  const payload = {
    request_id: "auth",
    kind: "tailscale_auth",
    title: "Sign in",
    auth_url: "https://login.tailscale.com.evil.test/a/test",
  };
  await mount(
    <InputRequest running event={event(1, "agent.requested", payload)} />,
  );
  expect(document.querySelector("a")).toBeNull();
  await act(() =>
    root.render(
      <InputRequest
        running
        event={event(1, "agent.requested", {
          ...payload,
          auth_url: "https://login.tailscale.com/a/test",
          answer: { choice: "connected" },
        })}
      />,
    ),
  );
  expect(document.querySelector("a")).toBeNull();
  expect(document.body.textContent).toContain("Connected");
});
it("updates a view in place and keeps resolved input at its original position", () => {
  const entries = chatEntries([
    event(1, "ui.updated", { view_id: "v", revision: 1 }),
    event(2, "agent.requested", { request_id: "r", title: "Continue?" }),
    event(3, "message.assistant", { text: "working" }),
    event(4, "ui.updated", { view_id: "v", revision: 2 }),
    event(5, "agent.answered", { request_id: "r", answer: { choice: "deny" } }),
  ]);
  expect(entries).toHaveLength(3);
  expect(entries[0].event.payload.revision).toBe(2);
  expect(entries[1].event.payload.answer.choice).toBe("deny");
});
it("isolates generated code and requires a host click before an iframe action runs", async () => {
  const fetch = vi.fn(async (_url: string, _options?: RequestInit) =>
    Response.json({ ok: true }),
  );
  vi.stubGlobal("fetch", fetch);
  await mount(
    <AgentView
      chatId="chat"
      running={false}
      view={{
        view_id: "v",
        title: "Job progress",
        revision: 1,
        html: "<p>Working</p>",
        css: "",
        script: "",
        data: {},
        actions: [{ id: "retry", label: "Retry job", prompt: "Retry" }],
      }}
    />,
  );
  const frame = document.querySelector("iframe")!;
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.srcdoc).toContain("connect-src 'none'");
  const nonce = frame.dataset.channel;
  await act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: {
          type: "tailnet.action",
          channel: nonce,
          id: "retry",
          data: { quality: "high" },
        },
      }),
    ),
  );
  expect(fetch).not.toHaveBeenCalled();
  await act(() =>
    document.querySelector<HTMLButtonElement>(".view-confirm")!.click(),
  );
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/chats/chat/views/v/actions");
});
it("answered permissions remain readable and cannot be submitted again", async () => {
  await mount(
    <InputRequest
      event={event(1, "agent.requested", {
        request_id: "r",
        title: "Run command?",
        options: [{ id: "deny", label: "Decline" }],
        answer: { choice: "deny" },
      })}
      running={true}
    />,
  );
  expect(document.body.textContent).toContain("Decline");
  expect(document.querySelector("button")).toBeNull();
});

it("keeps the same embedded document when expanding and receiving fresh data", async () => {
  const view = {
    view_id: "stable",
    title: "Stateful UI",
    revision: 1,
    html: '<input value="Draft">',
    css: "",
    script: "",
    data: { count: 1 },
    actions: [],
  };
  await mount(<AgentView chatId="chat" running={false} view={view} />);
  const original = document.querySelector("iframe")!;
  const source = original.srcdoc;
  await act(() =>
    document
      .querySelector<HTMLButtonElement>('[aria-label="Expand view"]')!
      .click(),
  );
  expect(document.querySelector("iframe")).toBe(original);
  await act(() =>
    root.render(
      <AgentView
        chatId="chat"
        running={false}
        view={{ ...view, revision: 2, data: { count: 2 } }}
      />,
    ),
  );
  expect(document.querySelector("iframe")).toBe(original);
  expect(original.srcdoc).toBe(source);
});
it("retries an uncertain action with the same idempotency key", async () => {
  const fetch = vi
    .fn<(url: string, options?: RequestInit) => Promise<Response>>()
    .mockRejectedValueOnce(new Error("Connection lost"))
    .mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  await mount(
    <AgentView
      chatId="chat"
      running={false}
      view={{
        view_id: "v",
        title: "Retry",
        revision: 1,
        html: "<p>Result</p>",
        css: "",
        script: "",
        data: {},
        actions: [{ id: "run", label: "Run", prompt: "Run task" }],
      }}
    />,
  );
  await act(() =>
    document.querySelector<HTMLButtonElement>("footer button")!.click(),
  );
  await act(() =>
    document.querySelector<HTMLButtonElement>(".view-confirm")!.click(),
  );
  expect(document.body.textContent).toContain("Connection lost");
  await act(() =>
    document.querySelector<HTMLButtonElement>(".view-confirm")!.click(),
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  const bodies = fetch.mock.calls.map((call) =>
    JSON.parse(String(call[1]?.body)),
  );
  expect(bodies[0].request_id).toBe(bodies[1].request_id);
});

it("keeps the Claude coordinator backend separate from a device-bound Claude session", async () => {
  const { NewSession } = await import("./AgentFeatures");
  const fetch = vi.fn(async (url: string, _options?: RequestInit) =>
    Response.json(
      url.includes("/agents")
        ? { available: ["claude"], home: "/work" }
        : { id: "new" },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  await mount(
    <NewSession
      devices={[
        { id: "remote", name: "Remote", target: "remote", status: "online" },
      ]}
      onCreated={() => {}}
      close={() => {}}
    />,
  );
  const backend = document.querySelector<HTMLSelectElement>("select")!;
  await act(() => {
    backend.value = "claude";
    backend.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(() =>
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(JSON.parse(fetch.mock.calls.at(-1)![1]!.body as string)).toEqual({
    coordinator_provider: "claude",
  });
  await act(() =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>(".provider-picker button"),
    )
      .find((b) => b.textContent?.startsWith("Claude"))!
      .click(),
  );
  await act(() =>
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(JSON.parse(fetch.mock.calls.at(-1)![1]!.body as string)).toEqual({
    agent: { provider: "claude", device_id: "remote", cwd: "/work" },
  });
});
