// Turns the inherited event stream into Gofer's view of the world: one thread made of messages,
// step lines and strands (work on a machine), and the machines themselves.
import type { Chat, Device, Event, HubState, Session } from "../api";
import { chatEntries, type ToolAction } from "../ToolActivity";
import { activityName } from "../activity-kind";
import { validImages, type ChatImage } from "../ChatImages";

export type Tone = "on" | "work" | "need" | "idle" | "off";

export type Step = {
  id: number;
  chat: string;
  time: string;
  tool: string;
  text: string;
  dur: string;
  detail: string;
  running: boolean;
  failed: boolean;
  deviceId?: string;
  sessionId?: string;
  /** The run the step belongs to: one strand, or one turn of the thread's own work. */
  run: string;
  /** Computer use: the step looked at or operated the machine's screen. */
  screen: boolean;
  /** A picture the step returned (a screenshot), to show when stepping back to it. */
  image?: string;
};

export type RecallItem = {
  id: number;
  kind: string;
  text: string;
  source?: string;
  time?: string;
  score?: number;
};
export type Claim = {
  id: number;
  text: string;
  about?: string[];
  supersedes?: { id: number; text: string }[];
};

export type Strand = {
  chat: Chat;
  deviceId?: string;
  provider: string;
  title: string;
  status: "running" | "ask" | "done" | "error" | "stopped" | "idle";
  steps: Step[];
  result?: string;
  /** What was said in it, both ways, in order. */
  turns: { id: number; you: boolean; text: string; images?: ChatImage[] }[];
  ask?: Event;
  first: number;
  started: string;
  ended?: string;
};

type Base = { key: string; first: number; time: string };
export type Item = Base &
  (
    | { k: "day"; text: string }
    | { k: "gap"; text: string }
    | { k: "you"; text: string; images?: ChatImage[] }
    | { k: "ha"; text: string; streaming: boolean; interrupted: boolean }
    | { k: "error"; text: string }
    | { k: "note"; text: string }
    | { k: "steps"; steps: Step[] }
    | { k: "strand"; strand: Strand }
    /** Gofer saying something more to a strand it started. */
    | { k: "tell"; strand: Strand; text: string }
    /** What a strand said back, where Gofer read it. */
    | { k: "report"; strand: Strand; text: string }
    | { k: "ask"; event: Event }
    | { k: "view"; event: Event }
    | { k: "recalled"; items: RecallItem[]; mode?: string }
    | { k: "written"; claims: Claim[] }
  );

export type Machine = {
  device: Device;
  tone: Tone;
  state: string;
  /** The strand working here now. A finished strand is history, not what the machine is doing. */
  strand?: Strand;
  /** The terminal to show: a working strand's, else Gofer's own here, else one he opened. */
  session?: Session;
  /** What is being done here in the turn that is running; empty when nothing is. */
  steps: Step[];
};

const SHORT: Record<string, string> = {
  command_execution: "shell",
  file_read: "read",
  file_search: "search",
  file_change: "edit",
  web_search: "web",
  terminal_send: "term.send",
  terminal_read: "term.read",
  terminal_interrupt: "term.stop",
  open_terminal: "term.open",
  list_devices: "devices",
  list_terminals: "terminals",
  search_memory: "memory",
  read_memory_run: "memory.read",
  start_agent: "strand",
  list_agents: "strands",
  read_agent: "strand.read",
  send_agent: "strand.send",
  stop_agent: "strand.stop",
  show_ui: "view",
  show_image: "image",
  image_generation: "image",
  wait: "wait",
};

export const plain = (value: unknown) =>
  String(value ?? "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n");

export function duration(ms: number) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.round(ms / 60_000);
  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// Formatting a time builds a locale formatter, which is slow, and the thread asks for the same
// few hundred times on every event. One formatter each, and each answer kept.
const kept = (format: (when: Date) => string) => {
  const answers = new Map<string, string>();
  return (when: string | Date) => {
    if (typeof when !== "string") return format(when);
    let answer = answers.get(when);
    if (answer === undefined) {
      if (answers.size > 4000) answers.clear();
      answers.set(when, (answer = format(new Date(when))));
    }
    return answer;
  };
};
const HM = new Intl.DateTimeFormat([], {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const HMS = new Intl.DateTimeFormat([], {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const DAY = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "2-digit",
  month: "short",
});
export const clock = kept((when) => HM.format(when));
export const clockSeconds = kept((when) => HMS.format(when));
export const dayLabel = kept((when) =>
  DAY.format(when).replace(",", "").toLowerCase(),
);

function toolName(raw: string) {
  const name = activityName(raw.replace(/^mcp__[^_]+(?:_[^_]+)*__/, ""));
  return SHORT[name] ?? name.toLowerCase();
}

function output(action: ToolAction) {
  const result = action.end?.payload.result?.result;
  if (typeof result?.aggregatedOutput === "string")
    return result.aggregatedOutput;
  if (typeof result?.output === "string") return result.output;
  if (Array.isArray(result?.output))
    return result.output
      .map((block: any) =>
        block?.type === "text" ? block.text : JSON.stringify(block),
      )
      .join("\n");
  if (typeof result === "string") return result;
  return action.output;
}

const SSH_ARG = new Set("BbcDEeFIiJLlmOoPpQRSWw".split(""));

/** The machine a shell command reaches over ssh, so the step shows in that machine's view. */
export function sshDevice(command: unknown, devices: Device[]) {
  const words = String(command ?? "")
    .split(/[\s;&|()]+/)
    .filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    if (!/^(?:.*\/)?ssh$/.test(words[i])) continue;
    let j = i + 1;
    while (j < words.length && words[j].startsWith("-"))
      j += words[j].length === 2 && SSH_ARG.has(words[j][1]) ? 2 : 1;
    const host = words[j]?.replace(/^["']|["']$/g, "").replace(/^[^@]*@/, "");
    if (!host) continue;
    const short = (v?: string | null) =>
      v
        ?.replace(/^[^@]*@/, "")
        .split(".")[0]
        .toLowerCase();
    const wanted = short(host);
    const found = devices.find(
      (d) =>
        d.id !== "local" &&
        (short(d.target) === wanted ||
          d.address === host ||
          d.name.toLowerCase() === host.toLowerCase()),
    );
    if (found) return found.id;
  }
  return undefined;
}

// Computer use tools: cua-driver for either provider, and Codex's own before it.
const SCREEN = /(^|_|\b)cua[-_](driver|repl)(__|\.)/i;

/** The first picture in a tool result, in the shapes the providers and Gofer's tools use. */
function pictureOf(result: any): string | undefined {
  const within = (list: unknown) =>
    Array.isArray(list)
      ? list.map((c: any) => c?.attachment?.url ?? c?.url).find(Boolean)
      : undefined;
  const url =
    within(result?.images) ?? within(result?.content) ?? within(result?.output);
  return typeof url === "string" && url.startsWith("/api/artifacts/")
    ? url
    : undefined;
}

/** One step line: what was done, where, how long it took, and the evidence. */
export function stepOf(
  action: ToolAction,
  chat: string,
  running: boolean,
  sessions: Session[],
  fallbackDevice?: string,
): Step {
  const p = (action.end || action.start).payload;
  const args = p.arguments || {};
  const receipt = p.result;
  const result = receipt?.result;
  const raw = String(p.name || "action");
  const name = activityName(raw.replace(/^mcp__[^_]+(?:_[^_]+)*__/, ""));
  const command =
    args.command ||
    result?.command ||
    (name === "terminal_send" ? args.text : undefined);
  const query = args.query || args.url || args.pattern || result?.query;
  const path = args.file_path || args.notebook_path || args.path;
  const sessionId =
    args.session_id ||
    (name === "open_terminal" ? result?.id : undefined) ||
    undefined;
  const session = sessions.find((s) => s.id === sessionId);
  // Strand tools (start/read/steer) return the strand's chat; name the strand, not its id.
  const strand = result?.chat as Chat | undefined;
  const screen = SCREEN.test(raw);
  // A computer use call is named by what it touched, not by its tool's full name.
  const call =
    args.arguments && typeof args.arguments === "object"
      ? args.arguments
      : args;
  const touched = screen
    ? [
        typeof call.text === "string" && JSON.stringify(call.text),
        call.bundle_id,
        call.app_name,
        Array.isArray(call.path) && call.path.join(" › "),
        Array.isArray(call.keys) && call.keys.join("+"),
        call.key,
        typeof call.x === "number" && `at ${call.x}, ${call.y}`,
        call.window_id !== undefined && `window ${call.window_id}`,
      ].find(Boolean) || "the screen"
    : undefined;
  const preview =
    touched ||
    command ||
    query ||
    path ||
    strand?.name ||
    args.description ||
    args.prompt ||
    args.name ||
    args.title ||
    (typeof args.seconds === "number" ? `${args.seconds} s` : "") ||
    (Array.isArray(result?.changes)
      ? result.changes.map((c: any) => c.path).join(", ")
      : "") ||
    raw;
  const ms =
    typeof result?.durationMs === "number"
      ? result.durationMs
      : action.end
        ? Date.parse(action.end.time) - Date.parse(action.start.time)
        : undefined;
  const lines: string[] = [];
  const cwd = args.cwd || result?.cwd;
  if (cwd) lines.push(`# ${cwd}`);
  if (command) lines.push(`$ ${plain(command).trim()}`);
  else if (query) lines.push(`> ${plain(query)}`);
  const changes = Array.isArray(result?.changes)
    ? result.changes
    : name === "file_change" && path
      ? [{ path, diff: args.new_string ?? args.content ?? args.new_source }]
      : [];
  for (const change of changes) {
    lines.push(`@ ${change.path}`);
    if (change.diff) lines.push(plain(change.diff));
  }
  if (strand?.name) {
    lines.push(`strand · ${strand.name}`);
    const said = (Array.isArray(result?.events) ? result.events : [])
      .filter((e: Event) => e.kind === "message.assistant")
      .at(-1)?.payload.text;
    if (said) lines.push(plain(said));
  }
  const text = strand ? "" : plain(output(action)).replace(/\s+$/, "");
  if (text) lines.push(text.length > 12000 ? `…\n${text.slice(-12000)}` : text);
  const error = receipt?.error || result?.error;
  if (error)
    lines.push(
      `! ${plain(typeof error === "string" ? error : JSON.stringify(error))}`,
    );
  if (!lines.length && Object.keys(args).length)
    lines.push(JSON.stringify(args, null, 2));
  return {
    id: action.start.id,
    chat,
    time: action.start.time,
    tool: toolName(raw),
    text: plain(preview).split("\n")[0].trim().slice(0, 240),
    dur: ms === undefined ? "" : duration(ms),
    detail: lines.join("\n"),
    running: !action.end && !action.interrupted && running,
    failed: receipt?.ok === false,
    deviceId: args.device_id || session?.device_id || fallbackDevice,
    sessionId,
    run: chat,
    screen,
    // The server lifts pictures out of a tool result into the event's own `images`.
    image: pictureOf(p) ?? pictureOf(result),
  };
}

function byScope(events: Event[]) {
  const map = new Map<string, Event[]>();
  for (const e of events) {
    const list = map.get(e.scope);
    if (list) list.push(e);
    else map.set(e.scope, [e]);
  }
  return map;
}

/** A device id as it is now: records of this host under its old tailnet name resolve to it. */
export const deviceOf = (state: HubState, id?: string) =>
  (id && state.device_aliases?.[id]) || id;

function strandOf(chat: Chat, events: Event[], state: HubState): Strand {
  const running = state.running.includes(chat.id);
  const entries = chatEntries(events);
  const deviceId = deviceOf(state, chat.agent?.device_id);
  const steps = entries
    .filter((e) => e.action)
    .map((e) => stepOf(e.action!, chat.id, running, state.sessions, deviceId));
  const ask = entries.find(
    (e) =>
      e.event.kind === "agent.requested" &&
      !e.event.payload.answer &&
      !e.event.payload.cancelled &&
      running,
  )?.event;
  const replies = entries.filter(
    (e) => e.event.kind === "message.assistant" && e.event.payload.text,
  );
  const last = [...events]
    .reverse()
    .find((e) =>
      ["agent.finished", "agent.error", "agent.stopped"].includes(e.kind),
    );
  const status: Strand["status"] = ask
    ? "ask"
    : running
      ? "running"
      : last?.kind === "agent.error"
        ? "error"
        : last?.kind === "agent.stopped"
          ? "stopped"
          : steps.length || replies.length
            ? "done"
            : "idle";
  return {
    chat,
    deviceId,
    provider: chat.agent?.provider ?? "claude",
    title: chat.name,
    status,
    steps,
    result: replies.at(-1)?.event.payload.text,
    turns: entries
      .filter(
        (e) =>
          ["message.user", "message.assistant"].includes(e.event.kind) &&
          (e.event.payload.text || e.event.payload.images?.length),
      )
      .map((e) => ({
        id: e.event.id,
        you: e.event.kind === "message.user",
        text: String(e.event.payload.text ?? ""),
        images: validImages(e.event.payload.images),
      })),
    ask,
    first: events[0]?.id ?? 0,
    started: events[0]?.time ?? chat.created_at,
    ended: running ? undefined : last?.time,
  };
}

/** The thread as items in order, the strands it started, and every step line in time order. */
export function threadModel(state: HubState) {
  // `state.thread_id` is the thread being looked at; the caller points it at the one chosen.
  const thread = state.chats.find((c) => c.id === state.thread_id);
  const scopes = byScope(state.events);
  const strands = new Map<string, Strand>();
  // The last thing each strand said that the thread has already shown.
  const heard = new Map<string, number>();
  const items: Item[] = [];
  if (!thread) return { thread, items, strands, steps: [] as Step[] };
  const events = scopes.get(thread.id) ?? [];
  const running = state.running.includes(thread.id);
  const entries = chatEntries(events);
  // Beside what was said: memory being read and written, and sessions loaded in as strands.
  const memory = events.filter(
    (e) => e.kind.startsWith("memory.") || e.kind === "strand.loaded",
  );
  const merged = [
    ...entries.map((entry) => ({ id: entry.event.id, entry })),
    ...memory.map((event) => ({ id: event.id, event })),
  ].sort((a, b) => a.id - b.id);
  const raw: Item[] = [];
  for (const m of merged) {
    if ("event" in m) {
      const e = m.event;
      const base = { key: `m${e.id}`, first: e.id, time: e.time };
      if (e.kind === "memory.recalled" && e.payload.items?.length)
        raw.push({
          ...base,
          k: "recalled",
          items: e.payload.items,
          mode: e.payload.mode,
        });
      else if (e.kind === "memory.written" && e.payload.claims?.length)
        raw.push({ ...base, k: "written", claims: e.payload.claims });
      else if (e.kind === "strand.loaded" && e.payload.chat?.id) {
        const loaded = e.payload.chat as Chat;
        if (!strands.has(loaded.id)) {
          const current = state.chats.find((c) => c.id === loaded.id) ?? loaded;
          const strand = strandOf(current, scopes.get(loaded.id) ?? [], state);
          strands.set(loaded.id, strand);
          raw.push({ ...base, k: "strand", strand });
        }
      } else if (e.kind === "memory.error")
        raw.push({
          ...base,
          k: "error",
          text: `Memory: ${e.payload.error ?? e.payload.message ?? "failed"}`,
        });
      continue;
    }
    const { event, action } = m.entry;
    const base = { key: `e${event.id}`, first: event.id, time: event.time };
    if (action) {
      const tool = String(action.start.payload.name ?? "").replace(
        /^mcp__[^_]+(?:_[^_]+)*__/,
        "",
      );
      const child = action.end?.payload.result?.result?.chat as
        Chat | undefined;
      if (tool === "start_agent" && child?.id && !strands.has(child.id)) {
        const current = state.chats.find((c) => c.id === child.id) ?? child;
        const strand = strandOf(current, scopes.get(child.id) ?? [], state);
        strands.set(child.id, strand);
        raw.push({ ...base, k: "strand", strand });
        continue;
      }
      // Working with a strand reads as a conversation with it: what Gofer said, and what it
      // said back. Waiting and looking to see whether it has finished are not shown at all.
      if (tool === "wait" || tool === "list_agents") continue;
      const about = strands.get(
        String(action.start.payload.arguments?.chat_id ?? ""),
      );
      if (tool === "send_agent" && about) {
        const text = String(action.start.payload.arguments?.text ?? "");
        if (text) raw.push({ ...base, k: "tell", strand: about, text });
        continue;
      }
      if (tool === "read_agent") {
        const upTo = action.end?.id ?? action.start.id;
        const reply = [...(about?.turns ?? [])]
          .reverse()
          .find((t) => !t.you && t.id <= upTo);
        if (about && reply && reply.id > (heard.get(about.chat.id) ?? 0)) {
          heard.set(about.chat.id, reply.id);
          raw.push({ ...base, k: "report", strand: about, text: reply.text });
        }
        continue;
      }
      const step = stepOf(action, thread.id, running, state.sessions, "local");
      if (step.deviceId === "local" && step.tool === "shell")
        step.deviceId =
          sshDevice(action.start.payload.arguments?.command, state.devices) ??
          "local";
      const previous = raw.at(-1);
      if (previous?.k === "steps") previous.steps.push(step);
      else raw.push({ ...base, k: "steps", steps: [step] });
      continue;
    }
    if (event.kind === "message.user")
      raw.push({
        ...base,
        k: "you",
        text: String(event.payload.text ?? ""),
        images: validImages(event.payload.images),
      });
    else if (
      event.kind === "message.assistant" &&
      (event.payload.text || event.payload.streaming)
    )
      raw.push({
        ...base,
        k: "ha",
        text: String(event.payload.text ?? ""),
        streaming: Boolean(event.payload.streaming && running),
        interrupted: Boolean(event.payload.interrupted),
      });
    else if (event.kind === "agent.requested")
      raw.push({ ...base, k: "ask", event });
    else if (event.kind === "ui.updated")
      raw.push({ ...base, k: "view", event });
    else if (event.kind === "agent.error")
      raw.push({
        ...base,
        k: "error",
        text: String(
          event.payload.text ?? event.payload.message ?? "The turn failed.",
        ),
      });
    else if (event.kind === "agent.stopped")
      raw.push({ ...base, k: "note", text: "stopped" });
  }
  let previous: Item | undefined;
  for (const item of raw) {
    if (!previous || dayLabel(previous.time) !== dayLabel(item.time))
      items.push({
        k: "day",
        key: `d${item.first}`,
        first: item.first,
        time: item.time,
        text: dayLabel(item.time),
      });
    else {
      const gap = Date.parse(item.time) - Date.parse(previous.time);
      if (gap > 45 * 60_000)
        items.push({
          k: "gap",
          key: `g${item.first}`,
          first: item.first,
          time: item.time,
          text: `${duration(gap)} · nothing ran`,
        });
    }
    items.push(item);
    previous = item;
  }
  const steps = items
    .flatMap((item) =>
      item.k === "steps"
        ? item.steps
        : item.k === "strand"
          ? item.strand.steps
          : [],
    )
    .sort((a, b) => a.id - b.id);
  // A strand is one run. The thread's own steps are a run for each turn, so the work of one
  // request is not strung onto the work of the last.
  const turns = events
    .filter((e) => e.kind === "agent.started")
    .map((e) => e.id);
  let turn = 0;
  for (const step of steps) {
    step.deviceId = deviceOf(state, step.deviceId);
    if (step.chat !== thread.id) continue;
    while (turn + 1 < turns.length && turns[turn + 1] <= step.id) turn++;
    step.run = `${thread.id}:${turns[turn] ?? 0}`;
  }
  return { thread, items, strands, steps };
}

/** Every machine, in a stable order, with what it is doing now. */
export function machinesOf(
  state: HubState,
  strands: Map<string, Strand>,
  steps: Step[],
): Machine[] {
  const threadRunning = state.running.includes(state.thread_id ?? "");
  const all = [...strands.values()];
  const order = (d: Device) =>
    d.id === "local" ? 0 : d.status === "online" ? 1 : 2;
  const thread = state.chats.find((c) => c.id === state.thread_id);
  // Where the running turn began: its steps are what the thread is doing now.
  let turn = Infinity;
  if (threadRunning)
    for (let i = state.events.length - 1; i >= 0; i--) {
      const e = state.events[i];
      if (e.scope === state.thread_id && e.kind === "agent.started") {
        turn = e.id;
        break;
      }
    }
  // A terminal left by a strand that has finished is not shown as the machine's screen.
  const working = (chatId: string) => state.running.includes(chatId);
  const stale = (session: Session) => {
    const owner = state.chats.find((c) => c.session_ids?.includes(session.id));
    return Boolean(owner?.agent && !working(owner.id));
  };
  return [...state.devices]
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
    .map((device) => {
      const strand = all
        .filter(
          (s) =>
            s.deviceId === device.id &&
            (s.status === "running" || s.status === "ask"),
        )
        .sort((a, b) => b.first - a.first)[0];
      const open = state.sessions.filter(
        (s) => !s.closed && s.device_id === device.id && !stale(s),
      );
      const session =
        open.find((s) => strand?.chat.session_ids?.includes(s.id)) ??
        open.find((s) => thread?.session_ids?.includes(s.id)) ??
        open[0];
      const live =
        strand?.steps ??
        steps.filter(
          (s) =>
            s.deviceId === device.id &&
            s.chat === state.thread_id &&
            (s.running || s.id > turn),
        );
      const busyStep = steps.find((s) => s.running && s.deviceId === device.id);
      // A strand of another thread working here: the machine is busy all the same.
      const elsewhere = state.chats.find(
        (c) =>
          c.agent &&
          !strands.has(c.id) &&
          working(c.id) &&
          deviceOf(state, c.agent.device_id) === device.id,
      );
      let tone: Tone;
      let text: string;
      if (device.status !== "online") {
        tone = "off";
        text = "offline";
      } else if (strand?.status === "ask") {
        tone = "need";
        text = "needs you";
      } else if (
        strand?.status === "running" ||
        busyStep ||
        (device.id === "local" && threadRunning)
      ) {
        tone = "work";
        text =
          strand?.status === "running"
            ? strand.title.toLowerCase()
            : (busyStep?.tool ?? "working");
      } else if (elsewhere) {
        tone = "work";
        text = elsewhere.name.toLowerCase();
      } else if (device.id === "local") {
        tone = "on";
        text = "the brain";
      } else {
        tone = "idle";
        text = "idle";
      }
      return { device, tone, state: text, strand, session, steps: live };
    });
}
