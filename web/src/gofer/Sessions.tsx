// The Claude and Codex sessions that already exist on a machine, to load into the thread.
import { useEffect, useState } from "react";
import { api, type Chat, type Device } from "../api";

type Found = {
  provider: "claude" | "codex";
  id: string;
  cwd: string;
  title: string;
  updated: number;
  bytes: number;
  /** The strand it is in Gofer as, and that strand's thread, when it is here already. */
  chat_id?: string | null;
  thread_id?: string | null;
};

function ago(seconds: number) {
  const s = Math.max(0, Date.now() / 1000 - seconds);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function Sessions({
  device,
  threadId,
  onThread,
  refresh,
}: {
  device: Device;
  threadId?: string;
  /** Brings a loaded session's strand into view, in whichever thread holds it. */
  onThread: (id?: string, strand?: string) => void;
  refresh: () => void;
}) {
  const [found, setFound] = useState<Found[]>();
  const [busy, setBusy] = useState("list");
  const [said, setSaid] = useState("");
  const [only, setOnly] = useState<"all" | "claude" | "codex">("all");
  async function list() {
    setBusy("list");
    setSaid("");
    try {
      const result = await api<{ sessions: Found[] }>(
        `/devices/${device.id}/sessions`,
      );
      setFound(result.sessions);
    } catch (e) {
      setFound([]);
      setSaid(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }
  useEffect(() => {
    setFound(undefined);
    void list();
  }, [device.id]);
  async function load(session: Found) {
    if (!threadId) return;
    setBusy(session.id);
    setSaid("");
    try {
      const result = await api<{ chat: Chat; turns: number }>(
        `/chats/${threadId}/load`,
        {
          device_id: device.id,
          provider: session.provider,
          native_id: session.id,
        },
      );
      setSaid(
        result.turns
          ? `Loaded ${result.turns} turns. The chat box on the left is talking to it now, and it is being written to memory.`
          : "It was loaded before. The chat box on the left is talking to it now.",
      );
      refresh();
      setTimeout(() => onThread(threadId, result.chat.id), 400);
      setFound((all) =>
        all?.map((s) =>
          s.id === session.id
            ? { ...s, chat_id: result.chat.id, thread_id: threadId }
            : s,
        ),
      );
    } catch (e) {
      setSaid(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }
  const shown = found?.filter((s) => only === "all" || s.provider === only);
  return (
    <div className="vbox setup">
      <div className="setup-h">
        <b>
          {!found
            ? `Looking for sessions on ${device.name}`
            : `${found.length} recent ${found.length === 1 ? "session" : "sessions"} on ${device.name}`}
        </b>
        <span className="sa">
          {(["all", "claude", "codex"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className={`kbtn${only === kind ? " on" : ""}`}
              aria-pressed={only === kind}
              onClick={() => setOnly(kind)}
            >
              {kind}
            </button>
          ))}
          <button
            type="button"
            className="kbtn"
            disabled={Boolean(busy)}
            onClick={list}
          >
            {busy === "list" ? "looking" : "look again"}
          </button>
        </span>
      </div>
      {said && <p className="setup-p">{said}</p>}
      {shown?.map((s) => (
        <div key={`${s.provider}:${s.id}`} className="sr ses">
          <span className="sl">{s.provider}</span>
          <span className="sd">
            <span className="st">{s.title}</span>
            <em>
              {s.cwd || "no folder"} · {ago(s.updated)}
            </em>
          </span>
          <span className="sa">
            {s.chat_id ? (
              <button
                type="button"
                className="kbtn"
                title="This session is already loaded. Show its strand and its continue box."
                onClick={() =>
                  onThread(s.thread_id ?? undefined, s.chat_id ?? undefined)
                }
              >
                loaded · open
              </button>
            ) : (
              <button
                type="button"
                className="kbtn"
                disabled={Boolean(busy) || !threadId}
                onClick={() => load(s)}
              >
                {busy === s.id ? "loading" : "load"}
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
