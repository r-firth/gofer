import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Thread } from "./Thread";
import { Stage } from "./Stage";
import { Palette } from "./Palette";
import { MemoryPane } from "./MemoryPane";
import { Matrix } from "./matrix";
import { api } from "../api";
import { startAura } from "./aura";
import { useHub } from "./hub";
import {
  clock,
  clockSeconds,
  dayLabel,
  deviceOf,
  machinesOf,
  threadModel,
  type Step,
} from "./model";

function ago(iso: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h} h ${m} min` : m ? `${m} min` : `${Math.round(s)} s`} ago`;
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState("");
  return (
    <div id="signin">
      <form
        className="slab"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api("/login", {
              token: new FormData(e.currentTarget).get("token"),
            });
            onDone();
          } catch {
            setError("That access token did not match.");
          }
        }}
      >
        <Matrix text="gofer" />
        <label>
          <span>access token</span>
          <input
            name="token"
            type="password"
            required
            autoFocus
            autoComplete="current-password"
          />
        </label>
        <button className="kbtn" type="submit">
          <kbd>enter</kbd>sign in
        </button>
        {error && <p className="err">{error}</p>}
      </form>
    </div>
  );
}

export function App() {
  const { data, error, connection, refresh } = useHub();
  const navigate = useNavigate();
  const page = useRouterState({ select: (s) => s.location.pathname });
  const memory = page === "/memory";
  const focusNode = useRouterState({
    select: (s) =>
      Number((s.location.search as { node?: unknown }).node) || undefined,
  });
  const [picked, setPicked] = useState<string>();
  const [follow, setFollow] = useState(true);
  const [selId, setSelId] = useState<number>();
  const [all, setAll] = useState(false);
  const [stageOpen, setStageOpen] = useState(false);
  // Wide: the machine view takes the whole window, for watching a screen or two panes.
  const [wide, setWideState] = useState(() => {
    try {
      return localStorage.getItem("gofer.wide") === "1";
    } catch {
      return false;
    }
  });
  const setWide = (next: boolean) => {
    setWideState(next);
    try {
      localStorage.setItem("gofer.wide", next ? "1" : "0");
    } catch {
      // Private browsing: it lasts for this page only.
    }
  };
  // The chat pane's width: his own once he has dragged the divider, else a share of the window.
  const [paneWidth, setPaneWidth] = useState(() => {
    try {
      return Number(localStorage.getItem("gofer.pane")) || undefined;
    } catch {
      return undefined;
    }
  });
  const [windowWidth, setWindowWidth] = useState(innerWidth);
  useEffect(() => {
    const resized = () => setWindowWidth(innerWidth);
    addEventListener("resize", resized);
    return () => removeEventListener("resize", resized);
  }, []);
  const fitPane = (width: number) =>
    Math.round(Math.max(380, Math.min(width, windowWidth - 30 - 420)));
  const pane = fitPane(
    paneWidth ?? Math.max(520, Math.min((windowWidth - 20) * 0.45, 660)),
  );
  function dragPane(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const app = handle.parentElement!;
    handle.setPointerCapture(e.pointerId);
    app.classList.add("rz");
    let width = pane;
    let frame = 0;
    const move = (m: PointerEvent) => {
      width = fitPane(m.clientX - 10 - 5);
      // Straight to the style, once a frame: a drag must not rebuild the app on every pixel.
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        app.style.setProperty("--tw", `${width}px`);
      });
    };
    const done = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
      app.classList.remove("rz");
      setPaneWidth(width);
      try {
        localStorage.setItem("gofer.pane", String(width));
      } catch {
        // Private browsing: it lasts for this page only.
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
  }
  function resetPane() {
    setPaneWidth(undefined);
    try {
      localStorage.removeItem("gofer.pane");
    } catch {
      // Nothing was kept.
    }
  }
  const [toast, setToast] = useState("");
  const [palette, setPalette] = useState(false);
  const aura = useRef<ReturnType<typeof startAura>>(undefined);
  const ground = useRef<HTMLCanvasElement>(null);

  // The threads he has open, first one first, and the one being looked at.
  const threads = useMemo(
    () =>
      (data?.chats ?? [])
        .filter((c) => c.thread && !c.closed && !c.closing)
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [data?.chats],
  );
  const [chosen, setChosen] = useState(() => {
    try {
      return localStorage.getItem("gofer.thread") ?? undefined;
    } catch {
      return undefined;
    }
  });
  const threadId = threads.some((t) => t.id === chosen)
    ? chosen
    : data?.thread_id;
  // The session the chat box is talking to, in place of Gofer.
  const [focusId, setFocus] = useState<string>();
  const projects = useMemo(
    () => (data?.projects ?? []).filter((p) => !p.closed),
    [data?.projects],
  );
  const openThread = (id?: string) => {
    if (!id) return;
    if (id !== threadId) setFocus(undefined);
    setChosen(id);
    setSelId(undefined);
    try {
      localStorage.setItem("gofer.thread", id);
    } catch {
      // Private browsing: the choice lasts for this page only.
    }
  };
  async function newThread(name: string, project?: string) {
    const thread = await api<{ id: string }>("/threads", {
      name,
      ...(project ? { project_id: project } : {}),
    });
    refresh();
    openThread(thread.id);
  }
  async function newProject(name: string) {
    const made = await api<{ thread: { id: string } }>("/projects", { name });
    refresh();
    openThread(made.thread.id);
  }
  async function closeProject(id: string) {
    for (const thread of threads.filter((t) => t.project_id === id))
      await api(`/chats/${thread.id}/close`, {});
    await api(`/projects/${id}/close`, {});
    refresh();
    if (threads.find((t) => t.id === threadId)?.project_id === id)
      openThread(data?.thread_id);
  }
  async function closeThread(id: string) {
    await api(`/chats/${id}/close`, {});
    refresh();
    openThread(data?.thread_id);
  }
  // Everything below reads the workspace as seen from that thread.
  const view = useMemo(
    () => (data ? { ...data, thread_id: threadId } : undefined),
    [data, threadId],
  );
  const model = useMemo(() => (view ? threadModel(view) : undefined), [view]);
  const machines = useMemo(
    () => (view && model ? machinesOf(view, model.strands, model.steps) : []),
    [view, model],
  );
  const steps = model?.steps ?? [];
  const focus = focusId ? model?.strands.get(focusId) : undefined;
  const strands = useMemo(() => [...(model?.strands.values() ?? [])], [model]);
  function showSessions() {
    setWide(false);
    setStageOpen(true);
    if (memory) void navigate({ to: "/" });
    setTimeout(() => dispatchEvent(new CustomEvent("gofer:sessions")));
  }
  const sel = steps.find((s) => s.id === selId);
  const running = Boolean(
    data && model?.thread && data.running.includes(model.thread.id),
  );
  const need =
    machines.some((m) => m.tone === "need") ||
    model?.items.some(
      (i) => i.k === "ask" && running && !i.event.payload.answer,
    );
  const work = machines.some((m) => m.tone === "work") || running;

  // Follow the work: the machine that needs him, else the one working most recently.
  const followed =
    machines.find((m) => m.tone === "need") ??
    [...machines]
      .filter((m) => m.tone === "work" && m.device.id !== "local")
      .sort((a, b) => (b.strand?.first ?? 0) - (a.strand?.first ?? 0))[0];
  const [lastFollowed, setLastFollowed] = useState<string>();
  useEffect(() => {
    if (followed) setLastFollowed(followed.device.id);
  }, [followed?.device.id]);
  // A step on another machine (its terminal, or an ssh command) brings that machine into view.
  const lastRemote = [...steps]
    .reverse()
    .find((s) => s.deviceId && s.deviceId !== "local");
  useEffect(() => {
    if (lastRemote?.deviceId) setLastFollowed(lastRemote.deviceId);
  }, [lastRemote?.id]);
  const currentId =
    sel?.deviceId ??
    (follow ? (followed?.device.id ?? lastFollowed ?? picked) : picked) ??
    machines[0]?.device.id;
  const current =
    machines.find((m) => m.device.id === currentId) ?? machines[0];

  function pick(id?: string) {
    if (!id) return;
    setPicked(id);
    setFollow(false);
    setAll(false);
    setSelId(undefined);
    setStageOpen(true);
    if (memory) void navigate({ to: "/" });
  }
  function select(step: Step) {
    if (selId === step.id) return goLive();
    setSelId(step.id);
    if (step.deviceId) setPicked(step.deviceId);
    setAll(false);
  }
  function goLive() {
    setSelId(undefined);
    setFollow(true);
  }
  async function toggleControl() {
    const session = current?.session;
    if (!session || sel) return;
    try {
      await api(`/sessions/${session.id}/control`, {
        owner: session.owner === "user" ? "agent" : "user",
      });
      refresh();
    } catch (e) {
      setToast(String(e instanceof Error ? e.message : e));
    }
  }
  function stepBy(delta: number) {
    if (!steps.length) return;
    const index = sel ? steps.indexOf(sel) : steps.length;
    const next = index + delta;
    if (next >= steps.length) return goLive();
    select(steps[Math.max(0, next)]);
  }

  useEffect(() => {
    const listener = (e: Event) => {
      const step = steps.find(
        (s) => s.id === (e as CustomEvent<number>).detail,
      );
      if (step) select(step);
    };
    addEventListener("gofer:select", listener);
    return () => removeEventListener("gofer:select", listener);
  });
  useEffect(() => {
    if (!ground.current) return;
    aura.current = startAura(ground.current);
    return () => aura.current?.stop();
  }, []);
  const filling = useRef(0);
  useEffect(() => {
    // The alert's place only matters while something needs him; measuring it forces layout.
    const focus = need
      ? document.querySelector(".ask")?.getBoundingClientRect()
      : undefined;
    aura.current?.setMood({
      need: Boolean(need),
      work,
      past: sel !== undefined,
      focus,
    });
    // One refill per frame however many renders land in it.
    filling.current ||= requestAnimationFrame(() => {
      filling.current = 0;
      aura.current?.fillWindows();
    });
  });
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (palette) return;
      const typing =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.closest(".tbox"));
      if (e.key === "Escape") {
        // Out of a session, back to Gofer, with the box still ready to type in.
        if (focus && !memory) return setFocus(undefined);
        if (typing && e.target instanceof HTMLElement) e.target.blur();
        if (memory) void navigate({ to: "/" });
        setAll(false);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[1-9]$/.test(e.key)) pick(machines[Number(e.key) - 1]?.device.id);
      else if (e.key === "0") {
        setAll((a) => !a);
        setSelId(undefined);
        if (memory) void navigate({ to: "/" });
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepBy(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        stepBy(1);
      } else if (e.key === "l") goLive();
      else if (e.key === "m") void navigate({ to: memory ? "/" : "/memory" });
      else if (e.key === "t") void toggleControl();
      else if (e.key === "v") dispatchEvent(new CustomEvent("gofer:view"));
      else if (e.key === "w") setWide(!wide);
      else if (e.key === "s") {
        e.preventDefault();
        setWide(false);
        setTimeout(() => dispatchEvent(new CustomEvent("gofer:switch")));
      } else if (e.key === "[" || e.key === "]") {
        // Step through the threads.
        const at = threads.findIndex((t) => t.id === threadId);
        const next = threads[at + (e.key === "]" ? 1 : -1)];
        if (next) openThread(next.id);
      } else if (e.key === "/") {
        e.preventDefault();
        // The prompt lives in the thread, which wide mode puts away.
        setWide(false);
        setTimeout(() => document.getElementById("say-in")?.focus());
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  });

  const nameOf = (id?: string) =>
    data?.devices.find((d) => d.id === (data && deviceOf(data, id)))?.name ??
    id ??
    "a machine";
  const rewound = sel && {
    time: clockSeconds(sel.time),
    date: `${dayLabel(sel.time)} · ${ago(sel.time)}`,
  };
  const counts = {
    online: machines.filter((m) => m.tone !== "off").length,
    work: machines.filter((m) => m.tone === "work").length,
    need: machines.filter((m) => m.tone === "need").length,
  };
  const mode = memory ? "MEMORY" : sel ? `REWOUND ${clock(sel.time)}` : "LIVE";

  if (error?.message === "AUTH_REQUIRED" && !data)
    return (
      <>
        <canvas id="aura" ref={ground} aria-hidden="true" />
        <SignIn onDone={refresh} />
      </>
    );
  return (
    <>
      <canvas id="aura" ref={ground} aria-hidden="true" />
      <div
        id="app"
        className={`${sel ? "rew" : ""}${stageOpen ? " so" : ""}${memory ? " mm" : ""}${wide && !memory ? " wd" : ""}`}
        style={{ "--tw": `${pane}px` } as React.CSSProperties}
      >
        <div
          id="split"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the chat pane"
          title="Drag to resize the chat. Double-click to reset."
          onPointerDown={dragPane}
          onDoubleClick={resetPane}
        />
        {error && !data ? (
          <section id="thread" className="slab">
            <div className="blk ha err">
              <p>Cannot reach Gofer: {error.message}</p>
            </div>
          </section>
        ) : (
          <Thread
            items={model?.items ?? []}
            sel={selId}
            running={running}
            threadId={model?.thread?.id}
            threads={threads.map((t) => ({
              id: t.id,
              name: t.id === data?.thread_id ? "main" : t.name,
              main: t.id === data?.thread_id,
              busy: Boolean(data?.running.includes(t.id)),
              project: projects.some((p) => p.id === t.project_id)
                ? (t.project_id ?? undefined)
                : undefined,
            }))}
            projects={projects}
            onNewProject={newProject}
            onCloseProject={closeProject}
            onThread={openThread}
            onNewThread={newThread}
            onCloseThread={closeThread}
            strands={strands}
            focus={focus}
            onFocus={setFocus}
            onSessions={showSessions}
            machineName={nameOf}
            onSelect={select}
            onPick={pick}
            isRunning={(id) => Boolean(data?.running.includes(id))}
            rewound={rewound}
            bar={
              current && (
                <button
                  id="nowbar"
                  type="button"
                  className={current.tone}
                  onClick={() => setStageOpen(true)}
                >
                  <b>{current.device.name}</b>
                  <span>
                    <i className="d" />
                    {current.state}
                  </span>
                  <em>view ›</em>
                </button>
              )
            }
          />
        )}
        {memory ? (
          <MemoryPane
            embedding={data?.embedding_model ?? "embedding"}
            devices={data?.devices ?? []}
            focusNode={focusNode}
            onClose={() => {
              setStageOpen(false);
              void navigate({ to: "/" });
            }}
            onShowInThread={(eventId, scope) => {
              // The step at or just before the event, in that chat: what Gofer was doing when it learned this.
              const step = [...steps]
                .reverse()
                .find((s) => s.id <= eventId && s.chat === scope);
              void navigate({ to: "/" });
              if (step) select(step);
              else setToast("That record has no step in the thread.");
            }}
          />
        ) : (
          <Stage
            machines={machines}
            current={current}
            sel={sel}
            steps={steps}
            wide={wide}
            onWide={() => setWide(!wide)}
            threadId={threadId}
            onThread={(id, strand) => {
              // Showing a session means talking to it: its thread, with the chat box on it.
              openThread(id);
              setWide(false);
              setFocus(strand);
            }}
            all={all}
            onPick={pick}
            onLive={goLive}
            onAll={() => setAll((a) => !a)}
            onClose={() => setStageOpen(false)}
            refresh={refresh}
            onError={setToast}
          />
        )}
        {palette && (
          <Palette
            machines={machines}
            steps={steps}
            commands={[
              ...threads
                .filter((t) => t.id !== threadId)
                .map((t) => ({
                  kind: "thread",
                  label: t.id === data?.thread_id ? "main thread" : t.name,
                  run: () => openThread(t.id),
                })),
              ...strands.map((st) => ({
                kind: "session",
                label: `${st.provider} · ${nameOf(st.deviceId)} · ${st.title.toLowerCase()}`,
                run: () => setFocus(st.chat.id),
              })),
              { kind: "l", label: "go live", run: goLive },
              {
                kind: "0",
                label: all ? "one machine" : "all machines",
                run: () => setAll((a) => !a),
              },
              {
                kind: "m",
                label: memory ? "close memory" : "open memory",
                run: () => navigate({ to: memory ? "/" : "/memory" }),
              },
              ...(current?.session
                ? [
                    {
                      kind: "t",
                      label:
                        current.session.owner === "user"
                          ? "hand the shell back"
                          : "take control of the shell",
                      run: toggleControl,
                    },
                  ]
                : []),
            ]}
            onPick={pick}
            onSelect={select}
            onClose={() => setPalette(false)}
          />
        )}
        <footer id="status">
          <button id="mode" type="button" disabled={!sel} onClick={goLive}>
            {!sel && !memory && <i className="d" />}
            {mode}
          </button>
          <button className="key" id="back" type="button" onClick={goLive}>
            <kbd>l</kbd>back to live
          </button>
          <span id="sum">
            <span className="tn">
              <b>{counts.online}</b> on the tailnet
            </span>
            {counts.work > 0 && (
              <span>
                <b>{counts.work}</b> working
              </span>
            )}
            {counts.need > 0 && (
              <span className="n">
                <b>{counts.need}</b> needs you
              </span>
            )}
            {connection !== "connected" && (
              <span className="n">{connection}</span>
            )}
            {toast && <span className="n">{toast}</span>}
          </span>
          <button
            className="key"
            id="s-mem"
            type="button"
            onClick={() => navigate({ to: memory ? "/" : "/memory" })}
          >
            memory
            <span> · {data?.event_count.toLocaleString() ?? 0} events</span>
          </button>
          <span className="sp" />
          <span id="keys">
            <button
              className="key"
              type="button"
              onClick={() => setAll((a) => !a)}
            >
              <kbd>0</kbd>all
            </button>
            <span className="key o2">
              <kbd>1-9</kbd>machine
            </span>
            <span className="key kk">
              <button
                type="button"
                aria-label="Previous step"
                onClick={() => stepBy(-1)}
              >
                <kbd>←</kbd>
              </button>
              <button
                type="button"
                aria-label="Next step"
                onClick={() => stepBy(1)}
              >
                <kbd>→</kbd>step
              </button>
            </span>
            <button className="key o1" type="button" onClick={goLive}>
              <kbd>l</kbd>live
            </button>
            <button
              className="key o1"
              type="button"
              onClick={() => dispatchEvent(new CustomEvent("gofer:view"))}
            >
              <kbd>v</kbd>view
            </button>
            <button
              className="key"
              type="button"
              onClick={() => navigate({ to: memory ? "/" : "/memory" })}
            >
              <kbd>m</kbd>memory
            </button>
            <button
              className="key"
              type="button"
              onClick={() => setPalette(true)}
            >
              <kbd>⌘k</kbd>go to
            </button>
            <button
              className="key o2"
              type="button"
              onClick={() => dispatchEvent(new CustomEvent("gofer:switch"))}
            >
              <kbd>s</kbd>switch
            </button>
            <button
              className="key o2"
              type="button"
              onClick={() => document.getElementById("say-in")?.focus()}
            >
              <kbd>/</kbd>message
            </button>
          </span>
        </footer>
      </div>
    </>
  );
}
