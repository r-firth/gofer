import { describe, expect, it } from "vitest";
import type { Chat, Device, Event, HubState } from "../api";
import { machinesOf, sshDevice, threadModel } from "./model";

let id = 0;
const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 2, 9, minute)).toISOString();
const ev = (
  scope: string,
  kind: string,
  payload: Record<string, any>,
  minute = 0,
): Event => ({
  id: ++id,
  kind,
  scope,
  time: at(minute),
  payload,
});
const chat = (over: Partial<Chat>): Chat => ({
  id: "thread",
  name: "Thread",
  created_at: at(0),
  ...over,
});
const devices: Device[] = [
  {
    id: "local",
    name: "This machine",
    target: null,
    status: "online",
    os: "macOS",
  },
  {
    id: "homeserver",
    name: "homeserver",
    target: "homeserver",
    status: "online",
    os: "linux",
  },
  { id: "pi5", name: "pi5", target: "pi5", status: "offline", os: "linux" },
];

function state(
  events: Event[],
  chats: Chat[],
  running: string[] = [],
): HubState {
  return {
    thread_id: "thread",
    devices,
    sessions: [],
    chats,
    events,
    live: [],
    running,
    event_count: events.length,
    embedding_status: "ready",
    model: "claude-opus-5-5",
  };
}

// Shapes copied from a real Claude coordinator turn on the base server.
function turn() {
  id = 0;
  const strand = chat({
    id: "strand",
    name: "Check disk on homeserver",
    parent_id: "thread",
    agent: { provider: "claude", device_id: "homeserver", cwd: "/home/me" },
  });
  const events = [
    ev("thread", "message.user", { text: "how full is homeserver's disk?" }, 1),
    ev(
      "thread",
      "memory.recalled",
      {
        query: "how full is homeserver's disk?",
        mode: "hybrid",
        ms: 40,
        items: [
          {
            id: 901,
            kind: "claim",
            text: "homeserver's media disk is /mnt/media",
            source: "you",
            time: at(0),
            score: 0.8,
          },
        ],
      },
      1,
    ),
    ev("thread", "agent.started", {}, 1),
    ev(
      "thread",
      "tool.started",
      {
        arguments: { command: "uptime", description: "Show load" },
        item_id: "toolu_1",
        name: "Bash",
        source: "claude",
      },
      1,
    ),
    ev(
      "thread",
      "tool.result",
      {
        arguments: { command: "uptime" },
        item_id: "toolu_1",
        name: "Bash",
        source: "claude",
        result: {
          ok: true,
          result: {
            output: " 0:08  up 19 days, load averages: 5.30 5.02 5.05",
          },
        },
      },
      2,
    ),
    ev(
      "thread",
      "tool.started",
      {
        arguments: {
          device_id: "homeserver",
          provider: "claude",
          prompt: "check df",
        },
        item_id: "toolu_2",
        name: "start_agent",
        source: "claude",
      },
      2,
    ),
    ev("strand", "message.user", { text: "check df" }, 2),
    ev("strand", "agent.started", {}, 2),
    ev(
      "strand",
      "tool.started",
      {
        arguments: { command: "df -h /mnt/media" },
        item_id: "toolu_s1",
        name: "Bash",
        source: "claude",
      },
      3,
    ),
    ev(
      "strand",
      "tool.result",
      {
        arguments: { command: "df -h /mnt/media" },
        item_id: "toolu_s1",
        name: "Bash",
        source: "claude",
        result: {
          ok: true,
          result: { output: "/dev/sdb1  7.3T  6.1T  1.2T  84% /mnt/media" },
        },
      },
      3,
    ),
    ev(
      "strand",
      "message.assistant",
      { message_id: "m-s", text: "/mnt/media is 84% full." },
      4,
    ),
    ev("strand", "agent.finished", {}, 4),
    ev(
      "thread",
      "tool.result",
      {
        arguments: { device_id: "homeserver" },
        item_id: "toolu_2",
        name: "start_agent",
        source: "claude",
        result: { ok: true, result: { chat: strand } },
      },
      4,
    ),
    ev("thread", "message.started", { message_id: "m-1", text: "" }, 5),
    ev(
      "thread",
      "message.delta",
      { message_id: "m-1", delta: "homeserver's media disk is 84% full." },
      5,
    ),
    ev(
      "thread",
      "message.assistant",
      {
        message_id: "m-1",
        text: "homeserver's media disk is 84% full (1.2 TB free).",
      },
      5,
    ),
    ev("thread", "agent.finished", {}, 5),
    ev(
      "thread",
      "memory.written",
      {
        claims: [
          {
            id: 902,
            text: "homeserver's /mnt/media was 84% full on 2 Oct",
            about: ["homeserver"],
            supersedes: [],
          },
        ],
      },
      6,
    ),
  ];
  return { events, chats: [chat({}), strand] };
}

describe("threadModel", () => {
  it("orders messages, memory, steps and strands as they happened", () => {
    const { events, chats } = turn();
    const model = threadModel(state(events, chats));
    expect(model.items.map((i) => i.k)).toEqual([
      "day",
      "you",
      "recalled",
      "steps",
      "strand",
      "ha",
      "written",
    ]);
    const strand = model.items.find((i) => i.k === "strand");
    expect(strand?.k === "strand" && strand.strand.status).toBe("done");
    expect(strand?.k === "strand" && strand.strand.result).toBe(
      "/mnt/media is 84% full.",
    );
    expect(model.steps.map((s) => s.tool)).toEqual(["shell", "shell"]);
    expect(model.steps[1].deviceId).toBe("homeserver");
    expect(model.steps[0].detail).toContain("$ uptime");
    expect(model.steps[0].detail).toContain("load averages");
  });

  it("shows a running strand as work on its machine and a pending request as needing him", () => {
    const { events, chats } = turn();
    const live = events.filter(
      (e) =>
        !(
          e.scope === "strand" &&
          ["message.assistant", "agent.finished"].includes(e.kind)
        ),
    );
    live.push(
      ev(
        "strand",
        "agent.requested",
        {
          request_id: "r1",
          title: "Delete the old backups?",
          options: [{ id: "y", label: "Delete" }],
        },
        4,
      ),
    );
    const s = state(live, chats, ["strand"]);
    const model = threadModel(s);
    const machines = machinesOf(s, model.strands, model.steps);
    expect(machines.map((m) => [m.device.id, m.tone])).toEqual([
      ["local", "on"],
      ["homeserver", "need"],
      ["pi5", "off"],
    ]);
  });

  it("treats a finished strand as history, not as what the machine is doing", () => {
    const { events, chats } = turn();
    const terminal = {
      id: "t1",
      name: "strand shell",
      device_id: "homeserver",
      cwd: "",
      owner: "agent" as const,
      closed: false,
      created_at: at(1),
    };
    const withShell = chats.map((c) =>
      c.id === "strand" ? { ...c, session_ids: ["t1"] } : c,
    );
    const done = { ...state(events, withShell), sessions: [terminal] };
    const model = threadModel(done);
    const idle = machinesOf(done, model.strands, model.steps).find(
      (m) => m.device.id === "homeserver",
    )!;
    expect(model.strands.size).toBe(1);
    expect([idle.strand, idle.session, idle.steps.length]).toEqual([
      undefined,
      undefined,
      0,
    ]);
    // The same strand while it is working is the machine's current work, shell and all.
    const busy = { ...done, running: ["strand"] };
    const running = threadModel(busy);
    const working = machinesOf(busy, running.strands, running.steps).find(
      (m) => m.device.id === "homeserver",
    )!;
    expect(working.strand?.chat.id).toBe("strand");
    expect(working.session?.id).toBe("t1");
  });

  it("marks long quiet stretches", () => {
    const { events, chats } = turn();
    events.push(ev("thread", "message.user", { text: "morning" }, 6 * 60 + 40));
    const kinds = threadModel(state(events, chats)).items.map((i) => i.k);
    expect(kinds.slice(-2)).toEqual(["gap", "you"]);
  });
});

describe("moving hosts", () => {
  it("shows work recorded under this host's old tailnet name on this machine", () => {
    const { events, chats } = turn();
    const s = {
      ...state(events, chats),
      device_aliases: { homeserver: "local" },
    };
    s.devices = s.devices.filter((d) => d.id !== "homeserver");
    const model = threadModel(s);
    const strand = model.items.find((i) => i.k === "strand");
    expect(strand?.k === "strand" && strand.strand.deviceId).toBe("local");
    expect(model.steps.map((step) => step.deviceId)).toEqual([
      "local",
      "local",
    ]);
  });
});

describe("computer use steps", () => {
  it("are marked as screen work, named by what they touched, and keep their screenshot", () => {
    id = 0;
    const events = [
      ev("thread", "agent.started", {}),
      ev("thread", "tool.started", {
        name: "mcp__cua-driver__type_text",
        arguments: { pid: 1, text: "hello" },
        item_id: "a",
      }),
      ev("thread", "tool.result", {
        name: "mcp__cua-driver__type_text",
        arguments: { pid: 1, text: "hello" },
        item_id: "a",
        result: { ok: true, result: { output: "done" } },
      }),
      ev("thread", "tool.started", {
        name: "cua-driver.get_window_state",
        arguments: { arguments: { window_id: 7 } },
        item_id: "b",
      }),
      ev("thread", "tool.result", {
        name: "cua-driver.get_window_state",
        arguments: { arguments: { window_id: 7 } },
        item_id: "b",
        images: [{ url: "/api/artifacts/abc123.jpg" }],
        result: { ok: true, result: {} },
      }),
      ev("thread", "tool.started", {
        name: "Bash",
        arguments: { command: "uptime" },
        item_id: "c",
      }),
    ];
    const { steps } = threadModel(state(events, [chat({})], ["thread"]));
    expect(steps.map((s) => [s.screen, s.text, s.image])).toEqual([
      [true, '"hello"', undefined],
      [true, "window 7", "/api/artifacts/abc123.jpg"],
      [false, "uptime", undefined],
    ]);
  });
});

describe("runs", () => {
  it("gives each strand and each turn of the thread its own run", () => {
    const { events, chats } = turn();
    events.push(
      ev("thread", "message.user", { text: "and again" }, 9),
      ev("thread", "agent.started", {}, 9),
      ev(
        "thread",
        "tool.started",
        { name: "Bash", arguments: { command: "uptime" }, item_id: "again" },
        9,
      ),
    );
    const { steps, strands } = threadModel(state(events, chats, ["thread"]));
    const own = steps.filter((s) => s.chat === "thread");
    const strand = steps.filter((s) => s.chat === "strand");
    expect(strands.size).toBe(1);
    expect(new Set(strand.map((s) => s.run))).toEqual(new Set(["strand"]));
    // The first turn's steps share a run; the step of the second turn starts another.
    expect(own.at(-1)!.run).not.toBe(own[0].run);
    expect(new Set(own.slice(0, -1).map((s) => s.run)).size).toBe(1);
  });
});

describe("sshDevice", () => {
  it("finds the machine an ssh command reaches, past options and a user", () => {
    expect(
      sshDevice(
        "ssh -o BatchMode=yes -o ConnectTimeout=8 admin@homeserver 'uptime; free -h' 2>&1",
        devices,
      ),
    ).toBe("homeserver");
    expect(
      sshDevice("cd /tmp && ssh -T homeserver.tail1.ts.net ls", devices),
    ).toBe("homeserver");
  });
  it("leaves commands that reach no known machine on the host", () => {
    expect(sshDevice("df -h /", devices)).toBeUndefined();
    expect(sshDevice("ssh -G nowhere", devices)).toBeUndefined();
  });
});
