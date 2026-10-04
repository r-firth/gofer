import {
  Check,
  ChevronRight,
  Clock3,
  FileCode2,
  Globe,
  Network,
  Database,
  Braces,
  TerminalSquare,
  X,
  Image,
} from "lucide-react";
import { ChatImages } from "./ChatImages";
import { ActivitySignal } from "./ActivitySignal";
import { activityKind, activityName } from "./activity-kind";
import type { Device, Event, Session } from "./api";

export type ToolAction = {
  start: Event;
  end?: Event;
  output: string;
  interrupted?: boolean;
};
export type ChatEntry = { event: Event; action?: ToolAction };

// Keep a call at its original place in the conversation as results arrive, even
// when commentary or parallel tools appear between its start and completion.
export function chatEntries(events: Event[]): ChatEntry[] {
  const entries: ChatEntry[] = [];
  const pending = new Map<string, ToolAction[]>();
  const messages = new Map<string, ChatEntry>();
  const views = new Map<string, ChatEntry>();
  const requests = new Map<string, ChatEntry>();
  const keyFor = (e: Event) => {
    const p = e.payload;
    return p.item_id
      ? JSON.stringify([e.scope, p.thread_id, p.turn_id, p.item_id])
      : JSON.stringify([e.scope, p.name, p.arguments]);
  };
  for (const event of events) {
    if (
      [
        "agent.started",
        "agent.finished",
        "agent.stopped",
        "agent.error",
      ].includes(event.kind)
    ) {
      for (const request of requests.values()) {
        if (!request.event.payload.answer)
          request.event.payload.cancelled = true;
      }
      for (const calls of pending.values())
        for (const call of calls) call.interrupted = true;
      pending.clear();
      for (const entry of messages.values()) {
        if (entry.event.payload.streaming) {
          entry.event.payload.streaming = false;
          entry.event.payload.interrupted = true;
        }
      }
    }
    if (event.kind === "ui.updated") {
      const key = JSON.stringify([event.scope, event.payload.view_id]);
      const previous = views.get(key);
      if (previous) previous.event = { ...event, id: previous.event.id };
      else {
        const entry = { event };
        views.set(key, entry);
        entries.push(entry);
      }
      continue;
    }
    if (event.kind === "agent.requested") {
      const entry = { event: { ...event, payload: { ...event.payload } } };
      requests.set(
        JSON.stringify([event.scope, event.payload.request_id]),
        entry,
      );
      entries.push(entry);
      continue;
    }
    if (event.kind === "agent.answered") {
      const request = requests.get(
        JSON.stringify([event.scope, event.payload.request_id]),
      );
      if (request) request.event.payload.answer = event.payload.answer;
      continue;
    }
    if (
      ["message.started", "message.delta", "message.assistant"].includes(
        event.kind,
      ) &&
      event.payload.message_id
    ) {
      const key = JSON.stringify([event.scope, event.payload.message_id]);
      let entry = messages.get(key);
      if (!entry) {
        entry = {
          event: {
            ...event,
            kind: "message.assistant",
            payload: { ...event.payload, text: "", streaming: true },
          },
        };
        messages.set(key, entry);
        entries.push(entry);
      }
      if (event.kind === "message.delta") {
        entry.event.payload.text += String(event.payload.delta || "");
      } else if (event.kind === "message.assistant") {
        entry.event.payload = { ...event.payload, streaming: false };
      }
    } else if (event.kind === "tool.started") {
      const action: ToolAction = { start: event, output: "" };
      const key = keyFor(event);
      pending.set(key, [...(pending.get(key) || []), action]);
      entries.push({ event, action });
    } else if (event.kind === "tool.output") {
      const action = pending.get(keyFor(event))?.[0];
      if (action) action.output += String(event.payload.delta || "");
    } else if (event.kind === "tool.result") {
      const calls = pending.get(keyFor(event));
      const action = calls?.shift();
      if (action) action.end = event;
      else
        entries.push({
          event,
          action: { start: event, end: event, output: "" },
        });
    } else if (
      [
        "message.user",
        "message.assistant",
        "agent.error",
        "agent.stopped",
      ].includes(event.kind)
    ) {
      entries.push({ event });
    }
  }
  // Code-mode can report both the native image action and the same image in
  // its enclosing exec receipt. Keep one preview at the specific action while
  // preserving both original records and intentional displays on later turns.
  const imageKey = (e: Event, id: string) =>
    JSON.stringify([e.scope, e.payload.thread_id, e.payload.turn_id, id]);
  const nativeImages = new Set(
    entries.flatMap(({ action }) => {
      const event = action?.end;
      return event && !event.payload.native_receipt
        ? (event.payload.images || []).map((image: { id: string }) =>
            imageKey(event, image.id),
          )
        : [];
    }),
  );
  return entries.map((entry) => {
    const end = entry.action?.end;
    if (
      !entry.action ||
      !end?.payload.native_receipt ||
      !end.payload.images?.length
    )
      return entry;
    return {
      ...entry,
      action: {
        ...entry.action,
        end: {
          ...end,
          payload: {
            ...end.payload,
            images: end.payload.images.filter(
              (image: { id: string }) =>
                !nativeImages.has(imageKey(end, image.id)),
            ),
          },
        },
      },
    };
  });
}

function plainText(value: unknown): string {
  return String(value ?? "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n");
}
function webUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch {
    /* Malformed tool data remains plain text. */
  }
}
function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function ToolActivity({
  action,
  running,
  sessions,
  devices,
  onTerminal,
}: {
  action: ToolAction;
  running: boolean;
  sessions: Session[];
  devices: Device[];
  onTerminal: (id: string) => void;
}) {
  const p = (action.end || action.start).payload;
  const args = p.arguments || {};
  const receipt = p.result;
  const result = receipt?.result;
  const rawName = String(p.name || "Action");
  const name = p.source === "claude" ? activityName(rawName) : rawName;
  const kind = activityKind(name);
  const active = !action.end && !action.interrupted && running;
  const failed = action.end && receipt?.ok === false;
  const terminal = sessions.find(
    (s) =>
      s.id ===
      (args.session_id || (name === "open_terminal" ? result?.id : undefined)),
  );
  const device = devices.find(
    (d) => d.id === (terminal?.device_id || args.device_id),
  );
  const command =
    args.command ||
    result?.command ||
    (name === "terminal_send" ? args.text : undefined);
  const query =
    args.query ||
    args.url ||
    args.pattern ||
    result?.query ||
    args.action?.url ||
    result?.action?.url;
  const changes = Array.isArray(result?.changes)
    ? result.changes
    : Array.isArray(args.changes)
      ? args.changes
      : p.source === "claude" && name === "file_change"
        ? [
            {
              path: args.file_path || args.notebook_path,
              diff: args.new_string ?? args.content ?? args.new_source,
              kind: rawName,
            },
          ]
        : [];
  const search = name === "web_search";
  const files = ["file_change", "file_read", "file_search"].includes(name);
  const labels: Record<string, string> = {
    command_execution: active ? "Running command" : "Command",
    terminal_send: active ? "Sending to terminal" : "Terminal input",
    terminal_read: active ? "Reading terminal" : "Terminal output",
    open_terminal: active ? "Opening terminal" : "Open terminal",
    terminal_interrupt: "Interrupt terminal",
    list_devices: active ? "Discovering devices" : "Devices",
    list_terminals: "List terminals",
    search_memory: active ? "Searching memory" : "Memory search",
    wait: "Wait",
    web_search: active ? "Searching web" : "Web search",
    file_read: active ? "Reading file" : "Read file",
    file_search: active ? "Searching files" : "File search",
    file_change: active ? "Editing files" : "File changes",
    show_image: active ? "Loading image" : "Image",
    image_generation: active ? "Generating image" : "Image generated",
    image_view: "Image",
  };
  const label = p.native_receipt
    ? "Tool receipt"
    : labels[name] || name.replaceAll(/[._]/g, " ");
  const preview =
    command ||
    query ||
    changes.map((c: any) => c.path).join(", ") ||
    terminal?.name ||
    args.name ||
    args.path ||
    args.file_path ||
    (p.native_receipt ? name : undefined);
  const target = search
    ? "Web"
    : kind === "memory"
      ? "Memory"
      : device?.name ||
        (p.native_receipt
          ? "Response received by the agent"
          : p.source === "claude"
            ? "Claude execution device"
            : p.source === "codex"
              ? "Gofer host"
              : "Gofer");
  const cwd = args.cwd || result?.cwd;
  const exit = result?.exitCode;
  const status = active
    ? "Running"
    : !action.end
      ? "No result recorded"
      : failed
        ? "Failed"
        : receipt?.ok == null
          ? "Returned"
          : name === "terminal_send"
            ? "Sent"
            : "Done";
  const output =
    typeof result?.aggregatedOutput === "string"
      ? result.aggregatedOutput
      : typeof result?.output === "string"
        ? result.output
        : p.source === "claude" && Array.isArray(result?.output)
          ? result.output
              .map((block: any) =>
                block?.type === "text" ? block.text : json(block),
              )
              .join("\n")
          : action.output;
  let results = Array.isArray(result?.results) ? result.results : [];
  if (p.source === "claude" && rawName === "WebSearch" && !results.length) {
    // Claude returns its source list as a JSON line within the tool's text.
    // Parse only that explicit list; retain unrecognized output verbatim.
    const links = output
      .split("\n")
      .find((line: string) => line.startsWith("Links: "));
    if (links) {
      try {
        const parsed = JSON.parse(links.slice(7));
        if (Array.isArray(parsed))
          results = parsed.filter(
            (item: any) => item && typeof item.url === "string",
          );
      } catch {
        /* The raw receipt remains available. */
      }
    }
  }
  const hasOutput =
    Boolean(output) ||
    typeof result?.aggregatedOutput === "string" ||
    typeof result?.output === "string" ||
    (p.source === "claude" && Array.isArray(result?.output));
  const knownResult =
    hasOutput ||
    search ||
    files ||
    [
      "command_execution",
      "terminal_send",
      "open_terminal",
      "terminal_interrupt",
      "wait",
      "list_devices",
      "list_terminals",
      "search_memory",
    ].includes(name);
  const Icon =
    name === "show_image" || name.startsWith("image_")
      ? Image
      : search
        ? Globe
        : files
          ? FileCode2
          : command || name.startsWith("terminal")
            ? TerminalSquare
            : kind === "connection"
              ? Network
              : kind === "memory"
                ? Database
                : p.native_receipt
                  ? Braces
                  : Clock3;
  return (
    <>
      <details
        data-tool-kind={kind}
        className={`chat-action ${p.native_receipt ? "is-receipt" : ""} ${active ? "is-running" : ""} ${failed ? "is-failed" : ""}`}
      >
        <summary>
          {active && !p.native_receipt ? (
            <span className="tool-instrument">
              <ActivitySignal active kind={kind} />
            </span>
          ) : (
            <span className="tool-glyph">
              <Icon size={14} className="chat-action-icon" />
            </span>
          )}
          <span className="chat-action-description">
            <span className="chat-action-label">
              {label}
              {active && !p.native_receipt && (
                <span className="tool-destination">{target}</span>
              )}
            </span>
            {preview && (
              <code title={plainText(preview)}>
                {plainText(preview).trim()}
              </code>
            )}
          </span>
          <span className="chat-action-status" title={status}>
            {active ? (
              <span className="tool-live-led" aria-hidden="true" />
            ) : !action.end ? (
              <Clock3 size={12} />
            ) : failed ? (
              <X size={12} />
            ) : receipt?.ok == null ? (
              <Check size={12} className="receipt-returned" />
            ) : (
              <Check size={12} />
            )}
            <span>{typeof exit === "number" ? `Exit ${exit}` : status}</span>
          </span>
          <ChevronRight size={12} className="chat-action-chevron" />
        </summary>
        <div className="chat-action-evidence">
          <div className="chat-action-meta">
            <span>{target}</span>
            <time>
              {new Date(action.start.time).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </time>
            {typeof result?.durationMs === "number" && (
              <span>
                {result.durationMs < 1000
                  ? `${result.durationMs} ms`
                  : `${(result.durationMs / 1000).toFixed(1)} s`}
              </span>
            )}
            {terminal &&
              (terminal.closed ? (
                <span>Terminal closed</span>
              ) : (
                <button onClick={() => onTerminal(terminal.id)}>
                  Open {terminal.name} ↗
                </button>
              ))}
          </div>
          {cwd && <div className="chat-action-directory">{cwd}</div>}
          {command && (
            <section>
              <h4>{name === "terminal_send" ? "Input" : "Command"}</h4>
              <pre>{plainText(command)}</pre>
            </section>
          )}
          {p.native_receipt && (
            <section>
              <h4>Tool input</h4>
              <pre>{args.code || json(args)}</pre>
            </section>
          )}
          {search && query && (
            <section>
              <h4>Search / page</h4>
              <p>{String(query)}</p>
            </section>
          )}
          {search && results.length > 0 && (
            <section>
              <h4>Sources</h4>
              <ul className="chat-action-sources">
                {results.map((source: any, i: number) => (
                  <li key={i}>
                    {webUrl(source.url) ? (
                      <a
                        href={webUrl(source.url)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {String(source.title || source.url)}
                      </a>
                    ) : (
                      <strong>
                        {String(source.title || source.url || "Source")}
                      </strong>
                    )}
                    {source.snippet && <p>{String(source.snippet)}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {files &&
            changes.map((change: any, i: number) => (
              <section key={i}>
                <h4>{String(change.path || "File change")}</h4>
                <pre>
                  {plainText(
                    change.diff ||
                      change.kind?.type ||
                      change.kind ||
                      "Change recorded",
                  )}
                </pre>
              </section>
            ))}
          {hasOutput && (
            <section>
              <h4>Output{active && " · live"}</h4>
              <pre>{plainText(output) || "No output."}</pre>
            </section>
          )}
          {!hasOutput && command && action.end && (
            <p className="chat-action-note">
              {name === "terminal_send"
                ? "Input sent. Subsequent terminal reads show the result."
                : "No output recorded."}
            </p>
          )}
          {receipt?.error && (
            <pre className="chat-action-error">
              {plainText(
                typeof receipt.error === "string"
                  ? receipt.error
                  : json(receipt.error),
              )}
            </pre>
          )}
          {result?.error && (
            <pre className="chat-action-error">
              {plainText(
                typeof result.error === "string"
                  ? result.error
                  : json(result.error),
              )}
            </pre>
          )}
          {Array.isArray(result) &&
            ["list_devices", "list_terminals"].includes(name) && (
              <ul className="chat-action-list">
                {result.map((item: any, i: number) => (
                  <li key={i}>
                    <strong>{item.name || item.id}</strong>
                    <span>
                      {item.status || (item.closed ? "Closed" : "Open")}
                      {item.target ? ` · ${item.target}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          {name === "search_memory" && Array.isArray(result) && (
            <ul className="chat-action-list">
              {result.map((item: any, i: number) => (
                <li key={i}>
                  <strong>{String(item.kind || "Memory")}</strong>
                  <p>
                    {String(
                      item.payload?.text || item.payload?.name || json(item),
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {!knownResult && args && Object.keys(args).length > 0 && (
            <section>
              <h4>Input</h4>
              <pre>{json(args)}</pre>
            </section>
          )}
          {!knownResult && result !== undefined && (
            <section>
              <h4>Result</h4>
              <pre>{typeof result === "string" ? result : json(result)}</pre>
            </section>
          )}
          {!action.end && !active && (
            <p className="chat-action-note">
              No result recorded. The turn ended before this action reported an
              outcome.
            </p>
          )}
          <details className="chat-action-record">
            <summary>Full record</summary>
            <pre>
              {json({ ...p, streamed_output: action.output || undefined })}
            </pre>
          </details>
        </div>
      </details>
      <ChatImages images={p.images} errors={p.image_errors} />
    </>
  );
}
