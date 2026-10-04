import themeCSS from "./theme.css?raw";
import viewKitCSS from "./view-kit.css?raw";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  Check,
  Code2,
  Maximize2,
  MessageSquare,
  X,
} from "lucide-react";
import { api, randomId, type Chat, type Device, type Event } from "./api";
import { ActivitySignal } from "./ActivitySignal";
import "./agent-features.css";

export function agentLabel(chat?: Chat) {
  return chat?.agent?.provider === "codex"
    ? "Codex"
    : chat?.agent?.provider === "copilot"
      ? "Copilot"
      : chat?.agent?.provider === "claude"
        ? "Claude"
        : chat?.coordinator_provider === "claude"
          ? "Coordinator · Claude"
          : "Coordinator";
}
export function NewSession({
  devices,
  onCreated,
  close,
}: {
  devices: Device[];
  onCreated: (chat: Chat) => void;
  close: () => void;
}) {
  const [provider, setProvider] = useState("coordinator");
  const [coordinatorProvider, setCoordinatorProvider] = useState("codex");
  const [device, setDevice] = useState(devices[0]?.id || "local");
  const [cwd, setCwd] = useState("");
  const [probe, setProbe] = useState<{ available: string[]; home: string }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (provider === "coordinator") return;
    const controller = new AbortController();
    setProbe(undefined);
    setError("");
    api<{ available: string[]; home: string }>(
      `/devices/${device}/agents`,
      undefined,
      controller.signal,
    )
      .then((result) => {
        setProbe(result);
        setCwd(result.home);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [provider, device]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onCreated(
        await api<Chat>(
          "/chats",
          provider === "coordinator"
            ? { coordinator_provider: coordinatorProvider }
            : { agent: { provider, device_id: device, cwd } },
        ),
      );
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="new-agent-session" onSubmit={submit}>
      <div className="dialog-heading">
        <div>
          <span className="instrument-label">NEW SESSION</span>
          <h2>Where should the work happen?</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close dialog"
          onClick={close}
        >
          <X size={20} />
        </button>
      </div>
      <div className="provider-picker">
        {["coordinator", "codex", "copilot", "claude"].map((p) => (
          <button
            type="button"
            aria-pressed={provider === p}
            key={p}
            onClick={() => setProvider(p)}
          >
            {p === "coordinator" ? (
              <MessageSquare size={22} />
            ) : (
              <Code2 size={22} />
            )}
            <strong>
              {p === "coordinator"
                ? "Coordinator"
                : p === "codex"
                  ? "Codex"
                  : p === "claude"
                    ? "Claude"
                    : "Copilot"}
            </strong>
            <small>
              {p === "coordinator"
                ? "Across your devices"
                : "On a specific device"}
            </small>
          </button>
        ))}
      </div>
      {provider === "coordinator" && (
        <label className="coordinator-backend">
          Coordinator backend
          <select
            value={coordinatorProvider}
            onChange={(e) => setCoordinatorProvider(e.target.value)}
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
        </label>
      )}
      {provider !== "coordinator" ? (
        <div className="agent-location">
          <label>
            Device
            <select value={device} onChange={(e) => setDevice(e.target.value)}>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Project directory
            <input
              autoComplete="off"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/home/you/projects/game"
              required
              pattern="/.*"
            />
          </label>
          <p className="agent-probe" role="status">
            {probe ? (
              probe.available.includes(provider) ? (
                <>
                  <i className="dot online" />{" "}
                  {provider === "codex"
                    ? "Codex"
                    : provider === "claude"
                      ? "Claude"
                      : "Copilot"}{" "}
                  is installed · uses this device’s sign-in
                </>
              ) : (
                "This agent isn’t installed on the selected device."
              )
            ) : error ? (
              "Couldn’t check this device."
            ) : (
              "Checking installed agents…"
            )}
          </p>
        </div>
      ) : (
        <p className="agent-session-help">
          Work across your tailnet. The coordinator can use terminals, delegate
          to other agents, and bring the results back here.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <footer className="dialog-actions">
        <button type="button" className="button" onClick={close}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={
            busy ||
            (provider !== "coordinator" &&
              (!probe?.available.includes(provider) || !cwd.startsWith("/")))
          }
        >
          {busy ? "Starting…" : "Start session"}
          <ArrowUpRight size={16} />
        </button>
      </footer>
    </form>
  );
}

type ViewAction = { id: string; label: string; prompt: string };
export type ViewSpec = {
  view_id: string;
  revision: number;
  title: string;
  html: string;
  css: string;
  script: string;
  data: unknown;
  actions: ViewAction[];
};
const escapedJSON = (value: unknown) =>
  JSON.stringify(value).replace(/</g, "\\u003c");
function documentFor(view: ViewSpec, channel: string) {
  const css = view.css.replace(/<\/style/gi, "<\\/style");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>${themeCSS}
${viewKitCSS}
${css}</style></head><body>${view.html}<script>
const channel=${escapedJSON(channel)};let callbacks=[];window.tailnet={data:${escapedJSON(view.data)},onData(fn){callbacks.push(fn);fn(this.data);return()=>{callbacks=callbacks.filter(f=>f!==fn)}},action(id,data={}){parent.postMessage({type:'tailnet.action',channel,id,data},'*')}};
addEventListener('message',event=>{if(event.source!==parent||event.data?.channel!==channel)return;if(event.data.type==='tailnet.data'){tailnet.data=event.data.data;callbacks.forEach(f=>f(tailnet.data))}if(event.data.type==='tailnet.fonts'){const s=document.createElement('style');s.textContent=event.data.css;document.head.append(s)}});
parent.postMessage({type:'tailnet.ready',channel},'*');
new ResizeObserver(()=>parent.postMessage({type:'tailnet.resize',channel,height:document.body.scrollHeight},'*')).observe(document.body);
addEventListener('error',event=>parent.postMessage({type:'tailnet.error',channel,message:event.message},'*'));
(()=>{${view.script.replace(/<\/script/gi, "<\\/script")}
})();
</script></body></html>`;
}
let fonts: Promise<string> | undefined;
function viewFonts() {
  return (fonts ??= Promise.all(
    Object.entries(
      import.meta.glob(
        [
          "../node_modules/@fontsource/{chakra-petch,ibm-plex-mono}/files/*latin-400-normal.woff2",
          "../node_modules/@fontsource/chakra-petch/files/*latin-600-normal.woff2",
          "../node_modules/@fontsource-variable/oxanium/files/*latin-wght-normal.woff2",
        ],
        { query: "?url", import: "default", eager: true },
      ),
    ).map(async ([path, url]) => {
      const response = await fetch(String(url));
      if (!response.ok) return "";
      const blob = await response.blob();
      const data = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => resolve("");
        reader.readAsDataURL(blob);
      });
      const family = path.includes("oxanium")
        ? "Oxanium Variable"
        : path.includes("chakra")
          ? "Chakra Petch"
          : "IBM Plex Mono";
      const weight = path.includes("oxanium")
        ? "200 800"
        : path.includes("600")
          ? "600"
          : "400";
      return `@font-face{font-family:'${family}';src:url('${data}') format('woff2');font-weight:${weight};font-display:swap}`;
    }),
  )
    .then((r) => r.join(""))
    .catch(() => ""));
}
export function AgentView({
  view,
  chatId,
  running,
}: {
  view: ViewSpec;
  chatId: string;
  running: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const modal = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const wasExpanded = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [height, setHeight] = useState(340);
  const [pending, setPending] = useState<{
    id: string;
    data: unknown;
    revision: number;
    request_id: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const channel = useMemo(
    () => randomId(),
    [chatId, view.view_id, view.html, view.css, view.script],
  );
  // Data changes are delivered to the existing document, preserving its local UI state.
  const srcDoc = useMemo(() => documentFor(view, channel), [channel]);
  const latest = useRef(view);
  latest.current = view;
  useEffect(() => {
    setPending(undefined);
  }, [view.revision]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.data?.channel !== channel
      )
        return;
      if (event.data.type === "tailnet.error") {
        setError("View error: " + String(event.data.message).slice(0, 200));
        return;
      }
      if (
        event.data.type === "tailnet.resize" &&
        typeof event.data.height === "number" &&
        Number.isFinite(event.data.height)
      ) {
        setHeight(Math.max(180, Math.min(520, event.data.height)));
        return;
      }
      if (event.data.type === "tailnet.ready") {
        frame.current?.contentWindow?.postMessage(
          { type: "tailnet.data", channel, data: latest.current.data },
          "*",
        );
        void viewFonts().then((css) =>
          frame.current?.contentWindow?.postMessage(
            { type: "tailnet.fonts", channel, css },
            "*",
          ),
        );
        return;
      }
      if (
        event.data.type !== "tailnet.action" ||
        !latest.current.actions.some((a) => a.id === event.data.id)
      )
        return;
      try {
        if (JSON.stringify(event.data.data ?? {}).length > 16000) return;
      } catch {
        return;
      }
      setPending({
        id: event.data.id,
        data: event.data.data ?? {},
        revision: latest.current.revision,
        request_id: randomId(),
      });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [channel]);
  useEffect(() => {
    frame.current?.contentWindow?.postMessage(
      { type: "tailnet.data", channel, data: view.data },
      "*",
    );
  }, [channel, view.data]);
  useEffect(() => {
    if (expanded) {
      returnFocus.current = document.activeElement as HTMLElement;
      modal.current?.close();
      modal.current?.showModal();
      wasExpanded.current = true;
    } else if (wasExpanded.current) {
      modal.current?.close();
      modal.current?.setAttribute("open", "");
      returnFocus.current?.focus({ preventScroll: true });
      wasExpanded.current = false;
    }
  }, [expanded]);
  async function runAction(action: {
    id: string;
    data: unknown;
    revision: number;
    request_id: string;
  }) {
    setBusy(true);
    setError("");
    try {
      await api(`/chats/${chatId}/views/${view.view_id}/actions`, {
        action_id: action.id,
        revision: action.revision,
        data: action.data,
        request_id: action.request_id,
      });
      setPending(undefined);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const content = (
    <>
      <header>
        <span className="instrument-label">
          LIVE VIEW <b>/{String(view.revision).padStart(2, "0")}</b>
        </span>
        <strong>{view.title}</strong>
        <button
          className="icon-button"
          aria-label={expanded ? "Collapse view" : "Expand view"}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <X size={16} /> : <Maximize2 size={16} />}
        </button>
      </header>
      <iframe
        ref={frame}
        title={view.title}
        style={expanded ? undefined : { height }}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        data-channel={channel}
        srcDoc={srcDoc}
      />
      {(view.actions.length > 0 || pending) && (
        <footer>
          {pending ? (
            <>
              <span>
                {view.actions.find((a) => a.id === pending.id)?.label}
                <small>This will send an instruction to the agent.</small>
              </span>
              <button
                className="button view-confirm"
                disabled={running || busy}
                onClick={() => runAction(pending)}
              >
                Run action
                <ArrowUpRight size={14} />
              </button>
              <button
                className="icon-button"
                aria-label="Cancel action"
                onClick={() => setPending(undefined)}
              >
                <X size={16} />
              </button>
            </>
          ) : (
            view.actions.map((a) => (
              <button
                key={a.id}
                className="button"
                disabled={running || busy}
                title={a.prompt}
                onClick={() =>
                  setPending({
                    id: a.id,
                    data: {},
                    revision: view.revision,
                    request_id: randomId(),
                  })
                }
              >
                {a.label}
                <ArrowUpRight size={14} />
              </button>
            ))
          )}
        </footer>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </>
  );
  return (
    <dialog
      open
      className={`agent-view ${expanded ? "agent-view-expanded" : "agent-view-inline"}`}
      ref={modal}
      aria-label={view.title}
      onCancel={(event) => {
        event.preventDefault();
        setExpanded(false);
      }}
    >
      {content}
    </dialog>
  );
}
function tailscaleSignInURL(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      url.hostname === "login.tailscale.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith("/a/") &&
      url.pathname.length > 3
    )
      return url.href;
  } catch {
    /* A malformed URL is not an actionable sign-in request. */
  }
}

export function InputRequest({
  event,
  running,
}: {
  event: Event;
  running: boolean;
}) {
  const p = event.payload;
  const [answer, setAnswer] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const resolved = p.answer || sent;
  const active = running && !resolved && !p.cancelled;
  const tailscale = p.kind === "tailscale_auth";
  const signInURL =
    tailscale && active ? tailscaleSignInURL(p.auth_url) : undefined;
  const authStatus =
    tailscale && resolved
      ? (
          {
            connected: "Connected",
            cancel: "Cancelled",
            cancelled: "Cancelled",
            expired: "Sign-in expired",
            failed: "Connection failed",
          } as Record<string, string>
        )[resolved.choice]
      : undefined;
  async function submit(value: unknown) {
    setBusy(true);
    setError("");
    try {
      await api(`/chats/${event.scope}/requests/${p.request_id}`, value);
      setSent(value);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={`agent-input ${active ? "awaiting" : "resolved"}`}>
      <header>
        {active ? (
          <ActivitySignal active kind="thinking" />
        ) : (
          <Check size={16} />
        )}
        <strong>{p.title}</strong>
        <span>
          {resolved
            ? authStatus || "Answered"
            : active
              ? "Needs you"
              : "No longer waiting"}
        </span>
      </header>
      {p.detail && (!tailscale || active) && (
        <pre className="request-detail">{String(p.detail)}</pre>
      )}
      {resolved
        ? !authStatus && (
            <p>
              {p.options?.find((o: { id: string }) => o.id === resolved.choice)
                ?.label || Object.values(resolved.answers || {}).join(" · ")}
            </p>
          )
        : active && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit({ answers: answer });
              }}
            >
              {p.questions?.map(
                (q: {
                  id: string;
                  label: string;
                  options?: { label: string }[];
                }) => (
                  <label key={q.id}>
                    {q.label}
                    <input
                      required
                      list={`options-${p.request_id}-${q.id}`}
                      value={answer[q.id] || ""}
                      onChange={(e) =>
                        setAnswer({ ...answer, [q.id]: e.target.value })
                      }
                    />
                    {q.options && (
                      <datalist id={`options-${p.request_id}-${q.id}`}>
                        {q.options.map((o) => (
                          <option key={o.label} value={o.label} />
                        ))}
                      </datalist>
                    )}
                  </label>
                ),
              )}
              <div className="request-options">
                {signInURL && (
                  <a
                    className="button primary"
                    href={signInURL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Sign in with Tailscale <ArrowUpRight size={14} />
                  </a>
                )}
                {p.options?.map((o: { id: string; label: string }) => (
                  <button
                    type="button"
                    className="button"
                    key={o.id}
                    disabled={busy}
                    onClick={() => submit({ choice: o.id })}
                  >
                    {o.label}
                  </button>
                ))}
                {p.questions && (
                  <button disabled={busy} className="button">
                    Send answer
                    <ArrowUpRight size={14} />
                  </button>
                )}
              </div>
            </form>
          )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
