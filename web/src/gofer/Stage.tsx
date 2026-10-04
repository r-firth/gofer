import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, wsUrl, type Device, type Session } from "../api";
import { createGhosttyTerminal } from "../ghostty";
import { playVideo, readPacket, type VideoPacket } from "./screen-video";
import { AddMachine, Setup } from "./Setup";
import { Sessions } from "./Sessions";
import { mountTerminal, type TerminalControls } from "../terminal-session";
import type { TerminalHistory } from "../terminal-history";
import type { TerminalResources } from "../terminal-session";
import { Matrix } from "./matrix";
import { Tinted } from "./Thread";
import { clockSeconds, type Machine, type Step } from "./model";

/** The shared libghostty terminal, in Gofer's face and palette. */
function createTerminal(): Promise<TerminalResources> {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  return createGhosttyTerminal({
    font: "JetBrains Mono",
    size: 13,
    cursor: "block",
    theme: {
      background: token("--term"),
      foreground: token("--fg"),
      cursor: token("--peach"),
      selectionBackground: "#ffffff22",
      black: "#26221e",
      red: "#e08a74",
      green: token("--sage"),
      yellow: token("--a-gold"),
      blue: "#8fb3c9",
      magenta: "#c49ab0",
      cyan: "#88bdb8",
      white: token("--g1"),
    },
  });
}

/** A real tmux shell on the machine, streamed through ghostty-web. */
function TerminalView({
  session,
  onStatus,
}: {
  session: Session;
  onStatus: (s: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const owner = useRef(session.owner);
  owner.current = session.owner;
  const controls = useRef<TerminalControls | undefined>(undefined);
  useEffect(() => {
    // Taking or handing back control changes who may type, without reconnecting the view.
    controls.current?.syncInput();
    if (session.owner === "user") controls.current?.keyboard();
  }, [session.owner]);
  useEffect(() => {
    if (!box.current) return;
    return mountTerminal({
      element: box.current,
      onReady: (value) => {
        controls.current = value;
      },
      url: wsUrl(`/sessions/${session.id}/stream`),
      canInput: () => owner.current === "user",
      onStatus,
      onError: onStatus,
      create: createTerminal,
      loadHistory: (signal) =>
        api<TerminalHistory>(
          `/sessions/${session.id}/history`,
          undefined,
          signal,
        ),
    });
  }, [session.id]);
  return <div className="vbox tbox" ref={box} />;
}

function Transcript({ steps }: { steps: Step[] }) {
  const box = useRef<HTMLDivElement>(null);
  const tail = steps.at(-1);
  useLayoutEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [tail?.id, tail?.detail.length]);
  return (
    <div className="term" ref={box}>
      <pre>
        {steps.map((s) => (
          <span key={s.id}>
            <span className="o">
              {clockSeconds(s.time)} {s.tool}
            </span>
            {"\n"}
            <Tinted text={s.detail || s.text} />
            {s.running && <span className="cursor" />}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

/** The machine's desktop, live: frames captured through cua-driver for as long as this is on
 *  screen. The page being hidden stops the capture; coming back starts it again. */
function ScreenView({
  device,
  onStatus,
}: {
  device: Device;
  onStatus: (status: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [note, setNote] = useState("connecting to the screen");
  // How the picture arrives: video from Cua Spaces, or stills through cua-driver without it.
  const [kind, setKind] = useState<"video" | "frames">();
  useEffect(() => {
    const surface = canvas.current;
    const context = surface?.getContext("bitmaprenderer");
    let dead = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let decoding = false;
    let refused = false;
    let mode: "video" | "frames" | undefined;
    let player: Awaited<ReturnType<typeof playVideo>> | undefined;
    let starting: Promise<unknown> | undefined;
    const waiting: VideoPacket[] = [];
    const stopPlayer = () => {
      player?.destroy();
      player = undefined;
      starting = undefined;
      waiting.length = 0;
    };
    const live = (how: string) => {
      refused = false;
      setNote("");
      onStatus(how);
    };
    const connect = () => {
      clearTimeout(retry);
      if (dead || document.hidden) return;
      const current = new WebSocket(wsUrl(`/devices/${device.id}/screen`));
      current.binaryType = "arraybuffer";
      socket = current;
      onStatus("connecting");
      current.onmessage = (message) => {
        if (current !== socket) return;
        if (typeof message.data === "string") {
          if (message.data.startsWith("E ")) {
            refused = true;
            setNote(message.data.slice(2));
            onStatus("unavailable");
          } else if (message.data.startsWith("M ")) {
            mode = message.data === "M video" ? "video" : "frames";
            setKind(mode);
          }
          return;
        }
        if (mode === "video") {
          const packet = readPacket(message.data);
          if (!packet || !video.current) return;
          if (player) {
            player.feed(packet);
            live("live");
            return;
          }
          // The stream opens on a keyframe and may not send another for a long time, so
          // nothing is thrown away while the player loads.
          waiting.push(packet);
          starting ??= playVideo(video.current, () => {
            // A stream the browser cannot play. A fresh connection starts on a keyframe.
            current.close();
          }).then((started) => {
            if (dead || current !== socket) return started.destroy();
            player = started;
            for (const held of waiting.splice(0)) started.feed(held);
            live("live");
          });
          return;
        }
        // A still that arrives while the last is decoding is dropped, not queued.
        if (decoding) return;
        decoding = true;
        createImageBitmap(
          new Blob([message.data], { type: "image/jpeg" }),
        ).then(
          (bitmap) => {
            decoding = false;
            if (dead || !surface || !context) return bitmap.close();
            if (surface.width !== bitmap.width) surface.width = bitmap.width;
            if (surface.height !== bitmap.height)
              surface.height = bitmap.height;
            context.transferFromImageBitmap(bitmap);
            live("live, stills");
          },
          () => {
            decoding = false;
          },
        );
      };
      current.onclose = () => {
        if (dead || current !== socket) return;
        socket = undefined;
        stopPlayer();
        onStatus(refused ? "unavailable" : "reconnecting");
        // A machine that cannot show its screen is asked again, but not hammered.
        retry = setTimeout(connect, refused ? 15000 : 3000);
      };
    };
    const visibility = () => {
      if (document.hidden) {
        const open = socket;
        socket = undefined;
        open?.close();
        stopPlayer();
        clearTimeout(retry);
      } else if (!socket) connect();
    };
    document.addEventListener("visibilitychange", visibility);
    connect();
    return () => {
      dead = true;
      document.removeEventListener("visibilitychange", visibility);
      clearTimeout(retry);
      const open = socket;
      socket = undefined;
      open?.close();
      stopPlayer();
    };
  }, [device.id]);
  return (
    <div className="vbox screen">
      <video
        ref={video}
        hidden={kind !== "video"}
        muted
        autoPlay
        playsInline
        disablePictureInPicture
        aria-label={`${device.name} screen`}
      />
      <canvas
        ref={canvas}
        hidden={kind === "video"}
        aria-label={`${device.name} screen`}
      />
      {note && <p className="screen-note">{note}</p>}
    </div>
  );
}

type Mode = "term" | "screen" | "both";
const MODES: Mode[] = ["term", "screen", "both"];
const remembered = () => {
  try {
    const value = localStorage.getItem("gofer.view");
    return MODES.includes(value as Mode) ? (value as Mode) : undefined;
  } catch {
    return undefined;
  }
};

const HOLD: Record<string, string> = {
  off: "Offline. Gofer reaches it again when it comes back on the tailnet.",
  idle: "Nothing of Gofer's is running here. Ask in the thread, or open a shell yourself.",
  on: "Gofer runs here. Its own work appears in the thread; open a shell to look around.",
};

function tail(machine: Machine) {
  // The small view shows commands and their output; computer use is watched on the screen.
  return machine.steps
    .filter((s) => !s.screen)
    .slice(-6)
    .map((s) => `${s.detail || s.text}`)
    .join("\n")
    .split("\n")
    .slice(-28)
    .join("\n");
}

export function Stage({
  machines,
  current,
  sel,
  steps,
  all,
  wide,
  onWide,
  threadId,
  onThread,
  onPick,
  onLive,
  onAll,
  onClose,
  refresh,
  onError,
}: {
  machines: Machine[];
  current?: Machine;
  sel?: Step;
  steps: Step[];
  all: boolean;
  wide: boolean;
  onWide: () => void;
  /** The thread in view: where a loaded session goes. */
  threadId?: string;
  onThread: (id?: string, strand?: string) => void;
  onPick: (id: string) => void;
  onLive: () => void;
  onAll: () => void;
  onClose: () => void;
  refresh: () => void;
  onError: (s: string) => void;
}) {
  const [status, setStatus] = useState("");
  const [screenStatus, setScreenStatus] = useState("");
  // Setting the machine up, or adding one, takes the view's place while it is open.
  const [panel, setPanel] = useState<"setup" | "add" | "sessions">();
  const [opening, setOpening] = useState(false);
  // What he chose to look at. With no choice, the screen shows while computer use is running
  // and the terminal otherwise.
  const [choice, setChoice] = useState<Mode | undefined>(remembered);
  const usingScreen = Boolean(current?.steps.some((s) => s.screen));
  const mode: Mode = choice ?? (usingScreen ? "screen" : "term");
  const pickMode = (next: Mode | undefined) => {
    setChoice(next);
    try {
      if (next) localStorage.setItem("gofer.view", next);
      else localStorage.removeItem("gofer.view");
    } catch {
      // Private browsing: the choice lasts for this page only.
    }
  };
  useEffect(() => {
    // Computer use starting brings the desktop into view even if the terminal was chosen
    // for something earlier. "Both" already shows it.
    if (usingScreen && choice === "term") pickMode(undefined);
  }, [usingScreen, current?.device.id]);
  useEffect(() => {
    const cycle = () =>
      pickMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
    addEventListener("gofer:view", cycle);
    return () => removeEventListener("gofer:view", cycle);
  });
  useEffect(() => {
    const show = () => setPanel("sessions");
    addEventListener("gofer:sessions", show);
    return () => removeEventListener("gofer:sessions", show);
  }, []);
  if (!current) return <section id="stage" aria-label="Machines" />;
  const d = current.device;
  const rewound = sel !== undefined;
  const pastStep =
    rewound &&
    (sel.deviceId === d.id ||
      current.strand?.steps.some((s) => s.id === sel.id))
      ? sel
      : undefined;
  const session = current.session;
  // What is happening here now, and everything that ever happened here (the rail steps back
  // through that, so finished work stays reachable without being shown as current).
  const liveSteps = current.steps;
  const deviceSteps = steps.filter((s) => s.deviceId === d.id);
  // The rail is one run's steps, never every run strung together: the run that is going, or
  // the one the selected step belongs to, or else the last one here.
  const run = pastStep?.run ?? deviceSteps.at(-1)?.run;
  const railSteps =
    liveSteps.length && !pastStep
      ? liveSteps
      : deviceSteps.filter((s) => s.run === run);
  const railNote = pastStep
    ? " in that run"
    : liveSteps.length
      ? ""
      : " in the last run";
  const nowText = pastStep
    ? pastStep.text
    : rewound
      ? `Nothing recorded on ${d.name} at that moment.`
      : current.strand
        ? (liveSteps.at(-1)?.text ?? current.strand.title)
        : session
          ? `${session.owner === "user" ? "You have" : "Gofer has"} the shell on ${d.name}.`
          : (HOLD[current.tone] ?? current.state);
  async function openShell() {
    setOpening(true);
    try {
      const session = await api<Session>("/sessions", {
        device_id: d.id,
        name: `${d.name} shell`,
      });
      // A shell he opens is his to type in; Gofer can be handed it later.
      await api(`/sessions/${session.id}/control`, { owner: "user" });
      refresh();
    } catch (e) {
      onError(String(e instanceof Error ? e.message : e));
    } finally {
      setOpening(false);
    }
  }
  async function control() {
    if (!session) return;
    await api(`/sessions/${session.id}/control`, {
      owner: session.owner === "user" ? "agent" : "user",
    });
    refresh();
  }
  const hold = (
    <div className="hold">
      <canvas className="win" aria-hidden="true" />
      <div className="hold-c">
        <b>
          <i className="d" />
          {rewound ? "nothing then" : current.state}
        </b>
        <span>
          {rewound
            ? "Step to a moment when this machine was working."
            : (HOLD[current.tone] ?? "")}
        </span>
        {!rewound && d.status === "online" && (
          <button
            type="button"
            className="kbtn hold-b"
            disabled={opening}
            onClick={openShell}
          >
            open a shell
          </button>
        )}
      </div>
    </div>
  );
  // The terminal side: a real shell when there is one, else the commands being run. Computer
  // use is watched on the screen, not read as a list of its calls.
  const shellSteps = liveSteps.filter((s) => !s.screen);
  const term = session ? (
    <TerminalView session={session} onStatus={setStatus} />
  ) : shellSteps.length ? (
    <Transcript steps={shellSteps.slice(-40)} />
  ) : (
    hold
  );
  const canScreen = d.status === "online";
  const showScreen = !rewound && canScreen && mode !== "term";
  let view;
  if (panel === "add")
    view = (
      <AddMachine
        onCancel={() => setPanel(undefined)}
        onAdded={(device) => {
          refresh();
          onPick(device.id);
          setPanel("setup");
        }}
      />
    );
  else if (panel === "setup") view = <Setup device={d} />;
  else if (panel === "sessions")
    view = (
      <Sessions
        device={d}
        threadId={threadId}
        onThread={onThread}
        refresh={refresh}
      />
    );
  else if (pastStep)
    view = (
      <div className="term">
        {pastStep.image && (
          <img className="shot" src={pastStep.image} alt="What the step saw" />
        )}
        <pre>
          <span className="o">
            {clockSeconds(pastStep.time)} {pastStep.tool}
          </span>
          {"\n"}
          <Tinted text={pastStep.detail || pastStep.text} />
        </pre>
      </div>
    );
  else if (rewound) view = hold;
  else if (showScreen && mode === "both")
    view = (
      <div className="panes">
        {term}
        <ScreenView device={d} onStatus={setScreenStatus} />
      </div>
    );
  else if (showScreen)
    view = <ScreenView device={d} onStatus={setScreenStatus} />;
  else view = term;
  return (
    <section id="stage" className={all ? "all" : ""} aria-label="Machines">
      <div id="sbar">
        <button className="kbtn" type="button" onClick={onClose}>
          ‹ thread
        </button>
        <span className="sp" />
        <button className="kbtn" type="button" onClick={onAll}>
          {all ? "one machine" : "all machines"}
        </button>
      </div>
      <div id="vpane" className="slab">
        <header className="head" id="vhead">
          <Matrix id="h-name" text={d.name} />
          <div className="lk">
            <b id="h-state" className={current.tone}>
              <i className="d" />
              {current.state}
            </b>
            <span id="h-meta">
              {[
                d.os,
                d.address,
                d.target && d.target !== d.name ? `ssh ${d.target}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
          {session && !rewound && (
            <button
              className={`kbtn${session.owner === "user" ? " on" : ""}`}
              id="ctl"
              type="button"
              onClick={control}
            >
              <kbd>t</kbd>
              {session.owner === "user" ? "hand back" : "take control"}
            </button>
          )}
        </header>
        <div
          id="view"
          className={session?.owner === "user" && !rewound ? "ctl" : ""}
        >
          <div id="vtitle">
            <span id="url">
              {panel === "add"
                ? "add a machine"
                : panel === "sessions"
                  ? `sessions · ${d.name}`
                  : panel === "setup"
                    ? `setup · ${d.name}`
                    : pastStep
                      ? `${pastStep.tool} · ${d.name}`
                      : showScreen && mode === "screen"
                        ? `screen · ${d.name}`
                        : session
                          ? `${session.name} · ${session.cwd || "~"}`
                          : current.strand
                            ? `${current.strand.provider} · ${current.strand.title.toLowerCase()}`
                            : d.name}
            </span>
            <span className="sp" />
            {!rewound && showScreen ? (
              <span id="chrome-r">screen {screenStatus}</span>
            ) : (
              session &&
              !rewound && <span id="chrome-r">{status.toLowerCase()}</span>
            )}
            {!rewound && canScreen && (
              <span id="vmode" role="group" aria-label="What to show">
                {MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`kbtn${mode === m ? " on" : ""}`}
                    aria-pressed={mode === m}
                    onClick={() => pickMode(m)}
                  >
                    {m === "term" ? "terminal" : m}
                  </button>
                ))}
              </span>
            )}
            <button
              type="button"
              className={`kbtn vp${panel === "sessions" ? " on" : ""}`}
              aria-pressed={panel === "sessions"}
              title="Claude and Codex sessions already on this machine"
              onClick={() =>
                setPanel(panel === "sessions" ? undefined : "sessions")
              }
            >
              sessions
            </button>
            <button
              type="button"
              id="vsetup"
              className={`kbtn${panel === "setup" ? " on" : ""}`}
              aria-pressed={panel === "setup"}
              title="What this machine has, and what it needs"
              onClick={() => setPanel(panel === "setup" ? undefined : "setup")}
            >
              setup
            </button>
            <button
              type="button"
              id="vwide"
              className={`kbtn${wide ? " on" : ""}`}
              aria-pressed={wide}
              title="Give the machine view the whole window (w)"
              onClick={onWide}
            >
              wide
            </button>
            {rewound && (
              <>
                <span id="h-mode">as of {clockSeconds(sel.time)}</span>
                <button
                  className="kbtn"
                  id="live"
                  type="button"
                  onClick={onLive}
                >
                  <kbd>l</kbd>back to live
                </button>
              </>
            )}
          </div>
          {view}
        </div>
        <div id="foot">
          <div className="fr" id="now">
            <span className="fk">{rewound ? "then" : "now"}</span>
            <span id="now-x">{nowText}</span>
          </div>
          <div className={`fr${railSteps.length ? "" : " none"}`} id="rail">
            <span className="fk">steps</span>
            <div id="track">
              {railSteps.slice(-24).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`tick${sel?.id === s.id ? " on" : !rewound || s.id <= sel.id ? " done" : ""}${s.running ? " on now" : ""}`}
                  aria-label={`${clockSeconds(s.time)} ${s.text}`}
                  title={`${clockSeconds(s.time)}  ${s.text}`}
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent("gofer:select", { detail: s.id }),
                    )
                  }
                >
                  <i />
                </button>
              ))}
            </div>
            <span id="rail-r">
              {railSteps.length
                ? `${railSteps.length} ${railSteps.length === 1 ? "step" : "steps"}${railNote}`
                : "no steps on this machine yet"}
            </span>
          </div>
        </div>
      </div>
      <div id="mpane" className="slab">
        <div id="strip" role="tablist" aria-label="Machines">
          <button
            type="button"
            className={`th add${panel === "add" ? " sel" : ""}`}
            title="Add a machine Gofer can reach over ssh"
            onClick={() => setPanel(panel === "add" ? undefined : "add")}
          >
            + machine
          </button>
          {machines.map((m) => (
            <div
              key={m.device.id}
              className={`th ${m.tone}${m.device.id === d.id ? " sel" : ""}`}
              role="tab"
              tabIndex={0}
              aria-selected={m.device.id === d.id}
              title={`${m.device.name}: ${m.state}`}
              onClick={() => {
                if (panel === "add") setPanel(undefined);
                onPick(m.device.id);
              }}
              onKeyDown={(e) =>
                (e.key === "Enter" || e.key === " ") && onPick(m.device.id)
              }
            >
              <span className="tc">
                <b>{m.device.name}</b>
                <span className="ts">
                  <i className="d" />
                  <em>{m.state}</em>
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
      <div id="grid">
        {all &&
          machines.map((m, i) => {
            const text = tail(m);
            return (
              <div
                key={m.device.id}
                className={`mini slab ${m.tone}`}
                role="button"
                tabIndex={0}
                onClick={() => onPick(m.device.id)}
                onKeyDown={(e) =>
                  (e.key === "Enter" || e.key === " ") && onPick(m.device.id)
                }
              >
                <div className="mtitle">
                  {i < 9 && <kbd>{i + 1}</kbd>}
                  <b>{m.device.name}</b>
                  <span className="ts">
                    <i className="d" />
                    <em>{m.state}</em>
                  </span>
                </div>
                <div className={`mv${text ? "" : " hd"}`}>
                  {text ? (
                    <pre className="mt bot">{text}</pre>
                  ) : (
                    <div className="mhold">
                      <canvas className="win" aria-hidden="true" />
                      <span>
                        <i className="d" />
                        {m.state}
                      </span>
                    </div>
                  )}
                </div>
                <div className="mn">
                  {m.strand?.title ??
                    (m.session ? m.session.name : (HOLD[m.tone] ?? ""))}
                </div>
              </div>
            );
          })}
      </div>
    </section>
  );
}
