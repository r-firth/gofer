import React, {
  useMemo,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { Link } from "@tanstack/react-router";
import remarkGfm from "remark-gfm";
import { api, randomId, uploadImage, type Event } from "../api";
import type { ChatImage } from "../ChatImages";
import { AgentView, type ViewSpec } from "../AgentFeatures";
import { Matrix } from "./matrix";
import {
  clock,
  clockSeconds,
  dayLabel,
  type Item,
  type Step,
  type Strand,
} from "./model";

/** Commands and additions stand forward, removals step back. */
export function Tinted({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => (
        <span
          key={i}
          className={
            line.startsWith("$ ") ||
            line.startsWith("> ") ||
            line.startsWith("@ ")
              ? "c-c"
              : line.startsWith("+ ")
                ? "c-a"
                : line.startsWith("- ") || line.startsWith("# ")
                  ? "c-r"
                  : undefined
          }
        >
          {line}
          {"\n"}
        </span>
      ))}
    </>
  );
}

function Line({
  step,
  sel,
  onSelect,
}: {
  step: Step;
  sel?: number;
  onSelect: (step: Step) => void;
}) {
  const on = sel === step.id;
  return (
    <>
      <button
        type="button"
        className={`ln${on ? " sel" : ""}${step.running ? " run" : ""}${sel !== undefined && step.id > sel ? " later" : ""}${step.failed ? " fail" : ""}`}
        aria-expanded={on}
        onClick={() => onSelect(step)}
      >
        <span className="lt">
          <span>{clockSeconds(step.time)}</span>
        </span>
        <span className="lk2">{step.tool}</span>
        <span className="lx" title={step.text}>
          <span>{step.text}</span>
        </span>
        <span className="ld">{step.running ? "" : step.dur}</span>
      </button>
      {on && step.detail && (
        <pre className="ldet">
          <Tinted text={step.detail} />
        </pre>
      )}
    </>
  );
}

const PLUGINS = [remarkGfm];
// Memoised: the thread re-renders on every event, and a reply that has not changed must not
// be parsed and rebuilt each time.
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={PLUGINS}>{text}</ReactMarkdown>
    </div>
  );
});

/** How much of a streamed reply to show: it arrives in uneven chunks and is let out a character
 *  at a time, faster when more is waiting, so it reads as steady typing. */
function useTyped(text: string, streaming: boolean) {
  const shown = useRef(streaming ? 0 : text.length);
  const target = useRef(text);
  target.current = text;
  const [, render] = useReducer((n: number) => n + 1, 0);
  if (shown.current > text.length) shown.current = text.length;
  const behind = shown.current < text.length;
  useEffect(() => {
    if (!behind) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      shown.current = target.current.length;
      render();
      return;
    }
    let frame = 0;
    let last = performance.now();
    let carry = 0;
    const step = (now: number) => {
      const full = target.current;
      const waiting = full.length - shown.current;
      if (waiting > 0) {
        // Clear what is waiting in about a third of a second, never slower than 60 a second.
        carry += (Math.max(60, waiting / 0.35) * (now - last)) / 1000;
        const add = Math.floor(carry);
        if (add) {
          carry -= add;
          let next = Math.min(full.length, shown.current + add);
          const code = full.charCodeAt(next - 1);
          if (code >= 0xd800 && code <= 0xdbff && next < full.length) next++;
          shown.current = next;
          render();
        }
      }
      last = now;
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [behind]);
  return { text: behind ? text.slice(0, shown.current) : text, typing: behind };
}

function Says({
  item,
  cls,
  onGrow,
}: {
  item: Extract<Item, { k: "ha" }>;
  cls: string;
  onGrow: () => void;
}) {
  const typed = useTyped(item.text, item.streaming);
  useLayoutEffect(() => {
    if (typed.typing) onGrow();
  }, [typed.text.length]);
  return (
    <div
      className={`blk ha${cls}${item.streaming || typed.typing ? " streaming" : ""}`}
    >
      <div className="bh">
        <time className="gt">{clock(item.time)}</time>
        <b>gofer</b>
        {item.interrupted && <span className="q">interrupted</span>}
      </div>
      <Markdown text={typed.text || " "} />
    </div>
  );
}

/** The composer's block cursor: one cell wide, so its place is a column count. */
function useBlockCursor() {
  const input = useRef<HTMLInputElement>(null);
  const block = useRef<HTMLElement>(null);
  const place = () => {
    const el = input.current;
    const b = block.current;
    if (!el || !b) return;
    const v = el.value;
    const p =
      document.activeElement === el
        ? ((el.selectionDirection === "backward"
            ? el.selectionStart
            : el.selectionEnd) ?? v.length)
        : v.length;
    b.style.transform = `translateX(calc(${p}ch - ${el.scrollLeft}px))`;
    b.textContent = v ? (v[p] ?? "") : (el.placeholder[0] ?? "");
  };
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const later = () => requestAnimationFrame(place);
    const events = [
      "input",
      "keyup",
      "keydown",
      "click",
      "focus",
      "blur",
      "select",
      "scroll",
    ];
    for (const name of events) el.addEventListener(name, later);
    document.addEventListener("selectionchange", later);
    place();
    return () => {
      for (const name of events) el.removeEventListener(name, later);
      document.removeEventListener("selectionchange", later);
    };
  }, []);
  return { input, block, place };
}

function Ask({
  event,
  running,
  compact,
}: {
  event: Event;
  running: boolean;
  compact?: boolean;
}) {
  const p = event.payload;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<any>();
  const [error, setError] = useState("");
  const resolved = p.answer || sent;
  const active = running && !resolved && !p.cancelled;
  async function submit(value: unknown) {
    setError("");
    try {
      await api(`/chats/${event.scope}/requests/${p.request_id}`, value);
      setSent(value);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }
  useEffect(() => {
    if (!active || !p.options?.length) return;
    const key = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      )
        return;
      const index = "abcd".indexOf(e.key);
      if (index >= 0 && p.options[index])
        void submit({ choice: p.options[index].id });
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [active]);
  if (!active)
    return (
      <div className="blk ha answered">
        <div className="bh">
          <span className="gt" />
          <b>{resolved ? "answered" : "no longer waiting"}</b>
        </div>
        <p>
          {p.title}
          {resolved &&
            ` · ${
              p.options?.find((o: { id: string }) => o.id === resolved.choice)
                ?.label ?? Object.values(resolved.answers ?? {}).join(" · ")
            }`}
        </p>
      </div>
    );
  return (
    <div className={`ask${compact ? " in-strand" : ""}`}>
      <canvas className="win" aria-hidden="true" />
      <div className="ask-in">
        <div className="ask-h">
          <span className="gt">
            <i className="d" />
          </span>
          <b>needs you</b>
        </div>
        <p className="ask-q">{p.title}</p>
        {p.detail && <p className="ask-n">{String(p.detail)}</p>}
        {p.options?.length > 0 && (
          <div className="ask-o">
            {p.options.map((o: { id: string; label: string }, k: number) => (
              <button
                type="button"
                key={o.id}
                onClick={() => submit({ choice: o.id })}
              >
                {k < 4 && <kbd>{"abcd"[k]}</kbd>}
                <span>{o.label}</span>
              </button>
            ))}
          </div>
        )}
        {p.questions?.length > 0 && (
          <form
            className="ask-f"
            onSubmit={(e) => {
              e.preventDefault();
              void submit({ answers });
            }}
          >
            {p.questions.map((q: { id: string; label: string }) => (
              <label key={q.id}>
                <span>{q.label}</span>
                <input
                  required
                  autoComplete="off"
                  value={answers[q.id] ?? ""}
                  onChange={(e) =>
                    setAnswers({ ...answers, [q.id]: e.target.value })
                  }
                />
              </label>
            ))}
            <button type="submit" className="kbtn">
              <kbd>enter</kbd>send answer
            </button>
          </form>
        )}
        {error && <p className="ask-n err">{error}</p>}
      </div>
    </div>
  );
}

/** The pictures he attached to a message. Clicking one shows it whole. */
function Pictures({ images }: { images?: ChatImage[] }) {
  if (!images?.length) return null;
  return (
    <div className="pics">
      {images.map((image) => (
        <img
          key={image.id}
          src={image.url}
          alt={image.name}
          title={image.name}
          width={image.width}
          height={image.height}
          loading="lazy"
          decoding="async"
        />
      ))}
    </div>
  );
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_IMAGES = 10;
/** A picture in the chat box, stored on the server as soon as it is attached. */
type Attachment = {
  key: string;
  name: string;
  preview: string;
  image?: ChatImage;
  error?: string;
};

/** Interrupt a chat's current turn if it has one, then send it a message. */
async function interruptAndSend(
  chatId: string,
  text: string,
  running: boolean,
  images: { id: string; name: string }[] = [],
) {
  if (running) {
    await api(`/chats/${chatId}/stop`, {});
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const state = await api<{ running: string[] }>("/state");
      if (!state.running.includes(chatId)) break;
    }
  }
  await api(`/chats/${chatId}/messages`, { text, images });
}

function StrandBlock({
  strand,
  machine,
  sel,
  running,
  onSelect,
  onPick,
  onOpen,
}: {
  strand: Strand;
  machine: string;
  sel?: number;
  running: boolean;
  onSelect: (step: Step) => void;
  onPick: () => void;
  onOpen: () => void;
}) {
  const finished = !["running", "ask"].includes(strand.status);
  const loaded = Boolean(strand.chat.loaded);
  // Its steps are there to be opened; the thread itself shows what was asked and what came back.
  const [open, setOpen] = useState(false);
  const brief = loaded ? undefined : strand.turns.find((t) => t.you)?.text;
  const now = finished ? undefined : strand.steps.at(-1);
  const lastDone = strand.steps.reduce(
    (n, s, i) => (sel === undefined || s.id <= sel ? i : n),
    -1,
  );
  const current = strand.steps.findIndex((s) => s.id === sel);
  const tag = strandTag(strand);
  return (
    <>
      <div className="sh">
        <span
          className="gt"
          title={loaded ? "Loaded from a session on this machine" : undefined}
        >
          {strand.provider}
        </span>
        <button type="button" className="mach" onClick={onPick}>
          {machine}
        </button>
        {loaded ? (
          <button type="button" className="sx" onClick={onOpen}>
            {strand.title.toLowerCase()}
          </button>
        ) : (
          <button
            type="button"
            className="sx"
            title="Show every step it took"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {strand.title.toLowerCase()}
          </button>
        )}
        <span className={`tag ${tag[0]}`}>
          {loaded ? (
            <span className="tn">
              {strand.turns.length}{" "}
              {strand.turns.length === 1 ? "turn" : "turns"}
            </span>
          ) : (
            <span className="run">
              {strand.steps.slice(-12).map((s) => {
                const i = strand.steps.indexOf(s);
                return (
                  <button
                    key={s.id}
                    type="button"
                    tabIndex={-1}
                    className={`rd${i === current || (current < 0 && i === strand.steps.length - 1 && !finished) ? " on" : i <= lastDone ? " done" : ""}`}
                    title={`${clockSeconds(s.time)}  ${s.text}`}
                    aria-label={`Rewind to ${clockSeconds(s.time)}`}
                    onClick={() => onSelect(s)}
                  >
                    <i />
                  </button>
                );
              })}
            </span>
          )}
          {tag[1]}
        </span>
        <button
          type="button"
          className="so"
          title={`Talk to this ${strand.provider} session`}
          onClick={onOpen}
        >
          open<span aria-hidden="true"> ›</span>
        </button>
      </div>
      {brief && (
        <div className="said">
          <i>asked</i>
          <Clamp text={brief} />
        </div>
      )}
      {now && !open && (
        <div className="lines">
          <Line step={now} sel={sel} onSelect={onSelect} />
        </div>
      )}
      {open && !loaded && (
        <div className="lines">
          {strand.steps.map((s) => (
            <Line key={s.id} step={s} sel={sel} onSelect={onSelect} />
          ))}
        </div>
      )}
      {strand.ask && <Ask event={strand.ask} running={running} compact />}
    </>
  );
}

/** Long text, a few lines of it until it is asked for whole. */
function Clamp({ text, markdown }: { text: string; markdown?: boolean }) {
  const long = text.length > 420 || text.split("\n").length > 6;
  const [whole, setWhole] = useState(false);
  return (
    <div className={`clamp${long && !whole ? " cut" : ""}`}>
      {markdown ? <Markdown text={text} /> : <p>{text}</p>}
      {long && (
        <button type="button" onClick={() => setWhole(!whole)}>
          {whole ? "less" : "all of it"}
        </button>
      )}
    </div>
  );
}

/** A strand's state, as a tone and a few words. */
function strandTag(strand: Strand) {
  return strand.status === "ask"
    ? ["need", "waiting on you"]
    : strand.status === "running"
      ? ["run-g", "running"]
      : strand.status === "error"
        ? ["err", "failed"]
        : strand.status === "stopped"
          ? ["", "stopped"]
          : ["ok", strand.ended ? `done ${clock(strand.ended)}` : "done"];
}

/** How many of a session's turns are drawn before he asks for the rest. */
const RECENT = 40;

/** One session, as the conversation on screen: what was said and done in it, in order. */
function Session({
  strand,
  sel,
  running,
  onSelect,
}: {
  strand: Strand;
  sel?: number;
  running: boolean;
  onSelect: (step: Step) => void;
}) {
  const [all, setAll] = useState(false);
  const rows = useMemo(() => {
    const said = all ? strand.turns : strand.turns.slice(-RECENT);
    const from = said[0]?.id ?? 0;
    const mixed = [
      ...said.map((turn) => ({ id: turn.id, turn, step: undefined })),
      ...strand.steps
        .filter((step) => all || step.id >= from)
        .map((step) => ({ id: step.id, turn: undefined, step })),
    ].sort((a, b) => a.id - b.id);
    // Steps that follow one another are one block of lines.
    const out: (
      | { id: number; turn: Strand["turns"][number] }
      | { id: number; steps: Step[] }
    )[] = [];
    for (const row of mixed) {
      const last = out.at(-1);
      if (row.turn) out.push({ id: row.id, turn: row.turn });
      else if (last && "steps" in last) last.steps.push(row.step!);
      else out.push({ id: row.id, steps: [row.step!] });
    }
    return out;
  }, [strand, all]);
  const earlier = strand.turns.length - RECENT;
  return (
    <div id="conv" className="ses">
      {!all && earlier > 0 && (
        <button type="button" className="tmore" onClick={() => setAll(true)}>
          show {earlier} earlier {earlier === 1 ? "turn" : "turns"}
        </button>
      )}
      {!rows.length && (
        <div className="blk ha">
          <p>Nothing has been said in this session yet.</p>
        </div>
      )}
      {rows.map((row) =>
        "steps" in row ? (
          <div key={row.id} className="blk stitch">
            <div className="lines">
              {row.steps.map((s) => (
                <Line key={s.id} step={s} sel={sel} onSelect={onSelect} />
              ))}
            </div>
          </div>
        ) : row.turn.you ? (
          <div key={row.id} className="blk you">
            <div className="bh">
              <span className="gt" />
              <b>{strand.chat.loaded ? "you" : "asked"}</b>
            </div>
            {row.turn.text && (
              <p>
                <i className="ps" aria-hidden="true">
                  ›
                </i>
                {row.turn.text}
              </p>
            )}
            <Pictures images={row.turn.images} />
          </div>
        ) : (
          <div key={row.id} className="blk ha">
            <div className="bh">
              <span className="gt" />
              <b>{strand.provider}</b>
            </div>
            <Markdown text={row.turn.text} />
          </div>
        ),
      )}
      {strand.ask && (
        <div className="blk">
          <Ask event={strand.ask} running={running} />
        </div>
      )}
    </div>
  );
}

function MemoryChips({
  label,
  rows,
}: {
  label: string;
  rows: {
    id: number;
    text: string;
    meta?: string;
    claim?: boolean;
    fresh?: boolean;
  }[];
}) {
  const [open, setOpen] = useState(false);
  const [struck, setStruck] = useState<Record<number, boolean>>({});
  async function toggle(id: number) {
    const next = !struck[id];
    await api(`/memory/claims/${id}/${next ? "wrong" : "restore"}`, {});
    setStruck({ ...struck, [id]: next });
  }
  return (
    <>
      <div className="chips">
        <button
          type="button"
          className="chip"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {label}
        </button>
      </div>
      {open && (
        <div className="fold">
          {rows.map((r) => (
            <div key={r.id} className={`mem${struck[r.id] ? " struck" : ""}`}>
              <em>{r.text}</em>
              <span className={r.fresh && !struck[r.id] ? "new" : undefined}>
                {struck[r.id] ? "marked wrong" : r.meta}
              </span>
              <i className="ma">
                <Link to="/memory" search={{ node: r.id }}>
                  graph
                </Link>
                {r.claim && (
                  <button type="button" onClick={() => toggle(r.id)}>
                    {struck[r.id] ? "undo" : "wrong"}
                  </button>
                )}
              </i>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** Whether a step line would draw the same. */
const sameSteps = (a: Step[], b: Step[]) =>
  a.length === b.length &&
  a.every((s, i) => {
    const t = b[i];
    return (
      s.id === t.id &&
      s.running === t.running &&
      s.failed === t.failed &&
      s.dur === t.dur &&
      s.text === t.text &&
      s.detail.length === t.detail.length
    );
  });

/** Whether two builds of a thread item would draw the same. The thread model is rebuilt from
 *  the events on every change, so items are compared by what they show, not by identity. */
function sameItem(a: Item, b: Item) {
  if (a.k !== b.k || a.key !== b.key || a.time !== b.time) return false;
  switch (a.k) {
    case "ha": {
      const o = b as typeof a;
      return (
        a.text === o.text &&
        a.streaming === o.streaming &&
        a.interrupted === o.interrupted
      );
    }
    case "steps":
      return sameSteps(a.steps, (b as typeof a).steps);
    case "strand": {
      const x = a.strand;
      const y = (b as typeof a).strand;
      return (
        x.status === y.status &&
        x.title === y.title &&
        x.result === y.result &&
        x.ended === y.ended &&
        x.deviceId === y.deviceId &&
        x.chat.id === y.chat.id &&
        x.turns.length === y.turns.length &&
        JSON.stringify(x.ask?.payload) === JSON.stringify(y.ask?.payload) &&
        sameSteps(x.steps, y.steps)
      );
    }
    case "ask":
    case "view":
      return (
        JSON.stringify(a.event.payload) ===
        JSON.stringify((b as typeof a).event.payload)
      );
    case "recalled":
      return a.items.length === (b as typeof a).items.length;
    case "written":
      return a.claims.length === (b as typeof a).claims.length;
    default:
      return a.text === (b as typeof a).text;
  }
}

type BlockProps = {
  item: Item;
  later: boolean;
  sel?: number;
  running: boolean;
  machine: string;
  strandRunning: boolean;
  onSelect: (step: Step) => void;
  onPick: (deviceId?: string) => void;
  onOpen: (strandId: string) => void;
  onGrow: () => void;
};

/** One item of the thread. Memoised: an event changes one or two items, and the rest of a long
 *  thread (replies, step lines, images) must not be rebuilt for it. */
const Block = memo(
  function Block({
    item,
    later,
    sel,
    running,
    machine,
    strandRunning,
    onSelect,
    onPick,
    onOpen,
    onGrow,
  }: BlockProps) {
    const cls = later ? " later" : "";
    switch (item.k) {
      case "day":
        return <div className={`day${cls}`}>{item.text}</div>;
      case "gap":
        return <div className={`gap${cls}`}>{item.text}</div>;
      case "you":
        return (
          <div className={`blk you${cls}`}>
            <div className="bh">
              <time className="gt">{clock(item.time)}</time>
              <b>you</b>
            </div>
            {item.text && (
              <p>
                <i className="ps" aria-hidden="true">
                  ›
                </i>
                {item.text}
              </p>
            )}
            <Pictures images={item.images} />
          </div>
        );
      case "ha":
        return <Says item={item} cls={cls} onGrow={onGrow} />;
      case "error":
      case "note":
        return (
          <div className={`blk ha ${item.k}${cls}`}>
            <div className="bh">
              <time className="gt">{clock(item.time)}</time>
              <b>{item.k === "error" ? "failed" : item.text}</b>
            </div>
            {item.k === "error" && <p>{item.text}</p>}
          </div>
        );
      case "steps":
        return (
          <div className={`blk stitch${cls}`}>
            <div className="lines">
              {item.steps.map((s) => (
                <Line key={s.id} step={s} sel={sel} onSelect={onSelect} />
              ))}
            </div>
          </div>
        );
      case "strand":
        return (
          <div
            className={`blk strand s-${item.strand.status}${item.strand.chat.loaded ? " ld" : ""}${cls}`}
          >
            <StrandBlock
              strand={item.strand}
              machine={machine}
              sel={sel}
              running={strandRunning}
              onSelect={onSelect}
              onPick={() => onPick(item.strand.deviceId)}
              onOpen={() => onOpen(item.strand.chat.id)}
            />
          </div>
        );
      case "tell":
        return (
          <div className={`blk tell${cls}`}>
            <div className="bh">
              <time className="gt">{clock(item.time)}</time>
              <b>gofer</b>
              <span className="q">
                to {item.strand.provider} on {machine}
              </span>
            </div>
            <Clamp text={item.text} />
          </div>
        );
      case "report":
        return (
          <div className={`blk report${cls}`}>
            <div className="bh">
              <time className="gt">{clock(item.time)}</time>
              <button
                type="button"
                className="who"
                title={`Talk to this ${item.strand.provider} session`}
                onClick={() => onOpen(item.strand.chat.id)}
              >
                {item.strand.provider}
              </button>
              <span className="q">on {machine}</span>
            </div>
            <Clamp text={item.text} markdown />
          </div>
        );
      case "ask":
        return (
          <div className={`blk${cls}`}>
            <Ask event={item.event} running={running} />
          </div>
        );
      case "view":
        return (
          <div className={`blk view${cls}`}>
            <AgentView
              chatId={item.event.scope}
              view={item.event.payload as ViewSpec}
              running={running}
            />
          </div>
        );
      case "recalled":
        return (
          <div className={`blk memrow${cls}`}>
            <MemoryChips
              label={`${item.items.length} remembered`}
              rows={item.items.map((r) => ({
                id: r.id,
                text: r.text,
                claim: r.kind === "claim",
                meta: [r.source, r.time && clock(r.time)]
                  .filter(Boolean)
                  .join(" · "),
              }))}
            />
          </div>
        );
      case "written":
        return (
          <div className={`blk memrow${cls}`}>
            <MemoryChips
              label={`${item.claims.length} written to memory`}
              rows={item.claims.map((c) => ({
                id: c.id,
                text: c.text,
                claim: true,
                fresh: !c.supersedes?.length,
                meta: c.supersedes?.length
                  ? `supersedes “${c.supersedes[0].text}”`
                  : "new",
              }))}
            />
          </div>
        );
    }
  },
  (a, b) =>
    a.later === b.later &&
    a.sel === b.sel &&
    a.running === b.running &&
    a.machine === b.machine &&
    a.strandRunning === b.strandRunning &&
    sameItem(a.item, b.item),
);

/** The head keeps its own time, so a passing second redraws the clock and nothing else. */
function Head({
  rewound,
  thread,
}: {
  rewound?: { time: string; date: string };
  /** The thread in view, when it is not the main one. */
  thread?: string;
}) {
  const [now, setNow] = useState(() => new Date());
  const live = !rewound;
  useEffect(() => {
    if (!live) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const time = rewound?.time ?? clockSeconds(now);
  return (
    <header className="head" id="thead">
      <Matrix
        id="clock"
        text={time}
        label={live ? `Time now ${time}` : `Rewound to ${time}`}
      />
      <div className="lk">
        <b>
          gofer
          {thread && <em> · {thread.toLowerCase()}</em>}
        </b>
        <span>{rewound?.date ?? dayLabel(now)}</span>
      </div>
    </header>
  );
}

export type ThreadTab = {
  id: string;
  name: string;
  main: boolean;
  busy: boolean;
  /** The project it belongs to, if any. */
  project?: string;
};
export type ProjectTab = { id: string; name: string };

type Row = { group: string; meta?: string; project?: string } & (
  | { k: "thread"; id: string; label: string; hint: string; busy: boolean }
  | { k: "session"; id: string; label: string; hint: string; busy: boolean }
  | { k: "new"; label: string; name?: string }
  | { k: "project"; label: string }
  | { k: "load"; label: string }
);

/** Who the chat box talks to: Gofer in one of the threads, or one session directly. Opens
 *  above the box; type to narrow it, or to name a new thread or project. */
function Switch({
  threads,
  projects,
  current,
  strands,
  focus,
  machineName,
  onThread,
  onNew,
  onNewProject,
  onCloseThread,
  onCloseProject,
  onFocus,
  onSessions,
  onClose,
}: {
  threads: ThreadTab[];
  projects: ProjectTab[];
  current?: string;
  strands: Strand[];
  focus?: string;
  machineName: (id?: string) => string;
  onThread: (id: string) => void;
  onNew: (name: string, project?: string) => Promise<void>;
  onNewProject: (name: string) => Promise<void>;
  onCloseThread: (id: string) => Promise<void>;
  onCloseProject: (id: string) => Promise<void>;
  onFocus: (id?: string) => void;
  onSessions: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [error, setError] = useState("");
  // Naming something new takes the list's place.
  const [making, setMaking] = useState<
    { k: "thread"; project?: string } | { k: "project" }
  >();
  const q = making ? "" : query.trim().toLowerCase();
  const typed = query.trim();
  const here = threads.find((t) => t.id === current);
  const hereProject = projects.find((p) => p.id === here?.project);
  const threadRow = (t: ThreadTab, group: string, meta?: string): Row => ({
    k: "thread",
    group,
    meta,
    project: t.project,
    id: t.id,
    label: t.name.toLowerCase(),
    hint: t.id === current && !focus ? "here" : "",
    busy: t.busy,
  });
  const match = (text: string) => !q || text.toLowerCase().includes(q);
  const rows: Row[] = [
    ...threads
      .filter((t) => !t.project && match(t.name))
      .map((t) => threadRow(t, "gofer")),
    ...(q ? [] : [{ k: "new" as const, group: "gofer", label: "new thread" }]),
    ...projects.flatMap((p) => {
      const group = `project · ${p.name.toLowerCase()}`;
      const named = match(p.name);
      return [
        ...threads
          .filter((t) => t.project === p.id && (named || match(t.name)))
          .map((t) => threadRow(t, group)),
        ...(q
          ? []
          : [
              {
                k: "new" as const,
                group,
                project: p.id,
                label: "new thread",
              },
            ]),
      ];
    }),
    ...(q
      ? [
          {
            k: "new" as const,
            group: "new",
            project: hereProject?.id,
            name: typed,
            label: `new thread “${typed}”${hereProject ? ` in ${hereProject.name.toLowerCase()}` : ""}`,
          },
          {
            k: "project" as const,
            group: "new",
            label: `new project “${typed}”`,
          },
        ]
      : [{ k: "project" as const, group: "new", label: "new project" }]),
    // Unasked, the list is the sessions he loaded and whatever is working, then the latest few
    // of Gofer's own; a search looks through all of them.
    ...[...strands]
      .reverse()
      .filter(
        (s, i) =>
          q ||
          s.chat.loaded ||
          s.chat.id === focus ||
          s.status === "running" ||
          s.status === "ask" ||
          i < 4,
      )
      .map((s): Row => ({
        k: "session",
        group: "a session directly",
        id: s.chat.id,
        label: `${s.provider} · ${machineName(s.deviceId)} · ${s.title.toLowerCase()}`,
        hint: s.chat.id === focus ? "here" : strandTag(s)[1],
        busy: s.status === "running" || s.status === "ask",
      }))
      .filter((r) => match(r.label)),
    ...(q
      ? []
      : [
          {
            k: "load" as const,
            group: "a session directly",
            label: "load a session from a machine",
          },
        ]),
  ];
  const at = Math.min(active, rows.length - 1);
  const fail = (err: unknown) =>
    setError(String(err instanceof Error ? err.message : err));
  function choose(row?: Row) {
    if (!row) return;
    setError("");
    if (row.k === "thread") onThread(row.id);
    else if (row.k === "session") onFocus(row.id);
    else if (row.k === "load") onSessions();
    else if (row.k === "new" && row.name) {
      void onNew(row.name, row.project).then(onClose, fail);
      return;
    } else {
      setMaking(
        row.k === "project"
          ? { k: "project" }
          : { k: "thread", project: row.project },
      );
      return;
    }
    onClose();
  }
  function make() {
    if (!making) return;
    if (!typed) return setError("It needs a name.");
    if (making.k === "thread")
      return void onNew(typed, making.project).then(onClose, fail);
    void onNewProject(typed).then(onClose, fail);
  }
  const makingIn =
    making?.k === "thread"
      ? projects.find((p) => p.id === making.project)
      : undefined;
  const back = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return false;
    e.stopPropagation();
    if (making) {
      setMaking(undefined);
      setError("");
    } else onClose();
    return true;
  };
  return (
    <>
      <div id="sw-away" onClick={onClose} />
      <div id="sw" role="dialog" aria-label="Who to talk to">
        <div id="sw-q">
          <input
            key={making?.k ?? "find"}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            maxLength={60}
            placeholder={
              making?.k === "project"
                ? "name the project"
                : making
                  ? `name the thread${makingIn ? ` in ${makingIn.name.toLowerCase()}` : ""}`
                  : "find a thread or session, or type a name for a new one"
            }
            aria-label={making ? "Name" : "Find a thread or session"}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              setError("");
            }}
            onKeyDown={(e) => {
              if (back(e)) return;
              if (e.key === "Enter") {
                e.preventDefault();
                if (making) make();
                else choose(rows[at]);
              } else if (
                !making &&
                (e.key === "ArrowDown" || e.key === "ArrowUp")
              ) {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : -1;
                setActive((at + step + rows.length) % rows.length);
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
        {making ? (
          <div
            id="sw-m"
            onKeyDown={(e) => {
              if (back(e)) return;
              if (e.key === "Enter") {
                e.preventDefault();
                make();
              }
            }}
          >
            <p>
              {making.k === "project"
                ? "A collection of threads. It starts with one, called general."
                : makingIn
                  ? `A thread of ${makingIn.name.toLowerCase()}.`
                  : "Another conversation with Gofer, with the same memory."}
            </p>
            <button type="button" onClick={make}>
              <kbd>enter</kbd>create
            </button>
          </div>
        ) : (
          <div id="sw-l" role="listbox">
            {rows.map((r, i) => (
              <React.Fragment
                key={`${r.k}${"id" in r ? r.id : ""}${r.group}${r.label}`}
              >
                {r.group !== rows[i - 1]?.group && r.group !== "new" && (
                  <h6>
                    <b>{r.group}</b>
                    {r.meta && <span>{r.meta}</span>}
                    {r.project && r.group !== "new" && (
                      <button
                        type="button"
                        title="Close this project and its threads. Its memory stays."
                        onClick={(e) => {
                          e.stopPropagation();
                          void onCloseProject(r.project!).catch(fail);
                        }}
                      >
                        close project
                      </button>
                    )}
                  </h6>
                )}
                {r.group === "new" && rows[i - 1]?.group !== "new" && <hr />}
                <div
                  role="option"
                  aria-selected={i === at}
                  className={`swr ${r.k}${i === at ? " act" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(r)}
                >
                  <i className={"busy" in r && r.busy ? "d" : ""} />
                  <span>
                    {(r.k === "new" || r.k === "load" || r.k === "project") &&
                      "+ "}
                    {r.label}
                  </span>
                  {"hint" in r && <small>{r.hint}</small>}
                  {r.k === "thread" &&
                    !threads.find((t) => t.id === r.id)?.main && (
                      <button
                        type="button"
                        title="Close this thread. Its memory stays."
                        aria-label={`Close ${r.label}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void onCloseThread(r.id).catch(fail);
                        }}
                      >
                        close
                      </button>
                    )}
                </div>
              </React.Fragment>
            ))}
          </div>
        )}
        {error && <p className="terr">{error}</p>}
      </div>
    </>
  );
}

export function Thread({
  items,
  sel,
  running,
  threadId,
  machineName,
  onSelect,
  onPick,
  isRunning,
  rewound,
  bar,
  threads,
  onThread,
  onNewThread,
  onCloseThread,
  projects,
  onNewProject,
  onCloseProject,
  strands,
  focus,
  onFocus,
  onSessions,
}: {
  items: Item[];
  sel?: number;
  running: boolean;
  threadId?: string;
  machineName: (id?: string) => string;
  onSelect: (step: Step) => void;
  onPick: (deviceId?: string) => void;
  isRunning: (chatId: string) => boolean;
  /** Set while a past step is selected: the clock shows that moment instead of now. */
  rewound?: { time: string; date: string };
  bar?: React.ReactNode;
  threads: ThreadTab[];
  onThread: (id: string) => void;
  onNewThread: (name: string, project?: string) => Promise<void>;
  onCloseThread: (id: string) => Promise<void>;
  projects: ProjectTab[];
  onNewProject: (name: string) => Promise<void>;
  onCloseProject: (id: string) => Promise<void>;
  /** The sessions of this thread, and the one the chat box is talking to instead of Gofer. */
  strands: Strand[];
  focus?: Strand;
  onFocus: (id?: string) => void;
  onSessions: () => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    const open = () => setSwitching(true);
    addEventListener("gofer:switch", open);
    return () => removeEventListener("gofer:switch", open);
  }, []);
  const here = threads.find((t) => t.id === threadId);
  const hereProject = projects.find((p) => p.id === here?.project);
  // Where he is, by name: the project first when the thread has one.
  const where = here
    ? `${hereProject ? `${hereProject.name} / ` : ""}${here.name}`.toLowerCase()
    : "main";
  const target = focus?.chat.id ?? threadId;
  const busy = focus ? isRunning(focus.chat.id) : running;
  const focusName = focus ? machineName(focus.deviceId) : "";
  const [text, setText] = useState("");
  const [attached, setAttached] = useState<Attachment[]>([]);
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [atEnd, setAtEnd] = useState(true);
  const [zoom, setZoom] = useState<string>();
  useEffect(() => {
    if (!zoom) return;
    const close = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setZoom(undefined);
    };
    addEventListener("keydown", close, true);
    return () => removeEventListener("keydown", close, true);
  }, [zoom]);
  const last = items.at(-1);
  const stick = () => {
    const el = scroll.current;
    if (el && atEnd && sel === undefined) el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(stick, [
    last?.key,
    last && "text" in last ? last.text : "",
    items.length,
    focus?.turns.length,
    focus?.steps.length,
  ]);
  // Another conversation on screen starts at its latest.
  useLayoutEffect(() => {
    const el = scroll.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAtEnd(true);
  }, [focus?.chat.id, threadId]);
  // Blocks are memoised, so they get callbacks that never change and read the latest props.
  const latest = useRef({ onSelect, onPick, onFocus, stick });
  latest.current = { onSelect, onPick, onFocus, stick };
  const select = useCallback((s: Step) => latest.current.onSelect(s), []);
  const pickDevice = useCallback(
    (id?: string) => latest.current.onPick(id),
    [],
  );
  const grow = useCallback(() => latest.current.stick(), []);
  const openStrand = useCallback(
    (id: string) => latest.current.onFocus(id),
    [],
  );
  const cursor = useBlockCursor();
  useLayoutEffect(cursor.place, [text, busy, target]);
  useEffect(() => {
    // On a desktop the prompt is ready to type into; on a phone that would raise the keyboard.
    if (!switching && matchMedia("(hover: hover) and (pointer: fine)").matches)
      cursor.input.current?.focus();
  }, [target, switching]);
  useEffect(() => {
    if (sel === undefined) return;
    scroll.current
      ?.querySelector(".ln.sel")
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [sel]);
  /** Attach pictures (picked, pasted or dropped) and store each one straight away. */
  function attach(files: File[]) {
    setError("");
    const room = MAX_IMAGES - attached.length;
    if (files.length > room)
      setError(`A message can carry up to ${MAX_IMAGES} images`);
    const added = files.slice(0, Math.max(room, 0)).map((file) => {
      const key = randomId();
      const name = file.name || "Pasted image";
      const problem =
        file.type && !IMAGE_TYPES.includes(file.type)
          ? "Only PNG, JPEG, WebP and GIF images can be attached"
          : file.size > 25 * 1024 * 1024
            ? "Images are limited to 25 MB"
            : "";
      const settle = (change: Partial<Attachment>) =>
        setAttached((list) =>
          list.map((a) => (a.key === key ? { ...a, ...change } : a)),
        );
      if (!problem)
        uploadImage(file, name).then(
          (image) => settle({ image }),
          (err) =>
            settle({ error: String(err instanceof Error ? err.message : err) }),
        );
      return {
        key,
        name,
        // Only a picture gets a preview; anything else is shown by its name.
        preview: file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : "",
        error: problem || undefined,
      };
    });
    setAttached((list) => [...list, ...added]);
  }
  function detach(key: string) {
    setAttached((list) =>
      list.filter((a) => {
        if (a.key === key) URL.revokeObjectURL(a.preview);
        return a.key !== key;
      }),
    );
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if ((!value && !attached.length) || !target) return;
    if (attached.some((a) => a.error))
      return setError("Remove the images that could not be attached");
    if (attached.some((a) => !a.image))
      return setError("Wait for the images to finish uploading");
    const sending = attached;
    setError("");
    setText("");
    setAttached([]);
    try {
      await interruptAndSend(
        target,
        value,
        busy,
        sending.map((a) => ({ id: a.image!.id, name: a.name })),
      );
      sending.forEach((a) => URL.revokeObjectURL(a.preview));
      setAtEnd(true);
    } catch (err) {
      setText(value);
      setAttached(sending);
      setError(String(err instanceof Error ? err.message : err));
    }
  }
  const uploading = attached.some((a) => !a.image && !a.error);
  const later = (first: number) => sel !== undefined && first > sel;
  return (
    <section
      id="thread"
      className="slab"
      aria-label="Thread"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setDropping(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDropping(false);
        attach([...e.dataTransfer.files]);
      }}
    >
      <Head rewound={rewound} thread={here?.main ? undefined : where} />
      {focus && (
        <div id="crumb">
          <button type="button" onClick={() => onFocus()}>
            <span aria-hidden="true">‹ </span>
            {where}
          </button>
          <span className="cp">{focus.provider}</span>
          <button
            type="button"
            className="mach"
            onClick={() => onPick(focus.deviceId)}
          >
            {focusName}
          </button>
          <span className="ct">{focus.title.toLowerCase()}</span>
          <span className={`tag ${strandTag(focus)[0]}`}>
            {strandTag(focus)[1]}
          </span>
        </div>
      )}
      {bar}
      <div
        id="scroll"
        ref={scroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - 60);
        }}
        onClick={(e) => {
          // A picture in a reply or a message is a thumbnail; clicking it shows it whole.
          const target = e.target as HTMLElement;
          if (
            target instanceof HTMLImageElement &&
            target.closest(".md, .pics")
          )
            setZoom(target.currentSrc || target.src);
        }}
      >
        {focus ? (
          <Session
            key={focus.chat.id}
            strand={focus}
            sel={sel}
            running={busy}
            onSelect={select}
          />
        ) : (
          <div id="conv" onLoadCapture={stick}>
            {!items.length && (
              <div className="blk ha">
                <div className="bh">
                  <span className="gt" />
                  <b>gofer</b>
                </div>
                <p>
                  Nothing yet. Ask for something below; I will pick the machine.
                </p>
              </div>
            )}
            {items.map((item) => (
              <Block
                key={item.key}
                item={item}
                later={later(item.first)}
                sel={
                  item.k === "steps" || item.k === "strand" ? sel : undefined
                }
                running={
                  item.k === "ask" || item.k === "view" ? running : false
                }
                machine={
                  item.k === "strand" ||
                  item.k === "tell" ||
                  item.k === "report"
                    ? machineName(item.strand.deviceId)
                    : ""
                }
                strandRunning={
                  item.k === "strand" && isRunning(item.strand.chat.id)
                }
                onSelect={select}
                onPick={pickDevice}
                onOpen={openStrand}
                onGrow={grow}
              />
            ))}
          </div>
        )}
      </div>
      {!atEnd && sel === undefined && (
        <button
          id="latest"
          type="button"
          onClick={() => {
            const el = scroll.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }}
        >
          latest<span aria-hidden="true">↓</span>
        </button>
      )}
      {zoom &&
        createPortal(
          <div
            id="zoom"
            role="dialog"
            aria-label="Picture"
            onClick={() => setZoom(undefined)}
          >
            <img src={zoom} alt="" />
          </div>,
          document.body,
        )}
      <form
        id="say"
        className={
          [focus && "tos", dropping && "drop"].filter(Boolean).join(" ") ||
          undefined
        }
        onSubmit={send}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("button, #sw, #sw-away"))
            cursor.input.current?.focus();
        }}
      >
        {switching && (
          <Switch
            threads={threads}
            projects={projects}
            onNewProject={onNewProject}
            onCloseProject={onCloseProject}
            current={threadId}
            strands={strands}
            focus={focus?.chat.id}
            machineName={machineName}
            onThread={(id) => {
              onFocus();
              onThread(id);
            }}
            onNew={onNewThread}
            onCloseThread={onCloseThread}
            onFocus={onFocus}
            onSessions={onSessions}
            onClose={() => setSwitching(false)}
          />
        )}
        <div id="to">
          <button
            type="button"
            id="to-b"
            aria-haspopup="dialog"
            aria-expanded={switching}
            title="Choose who this box talks to (s)"
            onClick={() => setSwitching(!switching)}
          >
            <span>to</span>
            <b>{focus ? focus.provider : "gofer"}</b>
            <em>
              {focus ? `${focusName} · ${focus.title.toLowerCase()}` : where}
            </em>
            <i aria-hidden="true">▾</i>
          </button>
          {focus && (
            <button type="button" id="to-x" onClick={() => onFocus()}>
              <kbd>esc</kbd>back to gofer
            </button>
          )}
        </div>
        {attached.length > 0 && (
          <div id="say-pics">
            {attached.map((a) => (
              <figure
                key={a.key}
                className={a.error ? "bad" : a.image ? undefined : "up"}
                title={a.error ?? a.name}
              >
                {a.preview ? (
                  <img src={a.preview} alt={a.name} />
                ) : (
                  <span>{a.name}</span>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => detach(a.key)}
                >
                  ×
                </button>
              </figure>
            ))}
          </div>
        )}
        <span className="ps" aria-hidden="true">
          ›
        </span>
        <span className="inw">
          <input
            id="say-in"
            ref={cursor.input}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={
              focus
                ? busy
                  ? `steer ${focus.provider} on ${focusName} (interrupts it)`
                  : `message ${focus.provider} on ${focusName}`
                : busy
                  ? "message gofer (interrupts the current turn)"
                  : "message gofer"
            }
            aria-label={
              focus
                ? `Message ${focus.provider} on ${focusName}`
                : "Message Gofer"
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files].filter((f) =>
                f.type.startsWith("image/"),
              );
              if (!files.length) return;
              e.preventDefault();
              attach(files);
            }}
          />
          <i id="bcur" ref={cursor.block} aria-hidden="true" />
        </span>
        <span className="say-b">
          <input
            ref={picker}
            type="file"
            accept={IMAGE_TYPES.join(",")}
            multiple
            hidden
            onChange={(e) => {
              attach([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            title="Attach images (or paste or drop them here)"
            onClick={() => picker.current?.click()}
          >
            + image
          </button>
          <button type="submit" disabled={uploading}>
            <kbd>enter</kbd>
            {uploading ? "uploading" : busy ? "interrupt and send" : "send"}
          </button>
        </span>
        {attached
          .filter((a) => a.error)
          .slice(0, 1)
          .map((a) => (
            <p key={a.key} id="say-err" role="status">
              {a.name}: {a.error}
            </p>
          ))}
        <small>
          {error ||
            (focus
              ? "Straight to this session, not to Gofer."
              : "Gofer picks the machine. Name one to choose it yourself.")}
        </small>
      </form>
    </section>
  );
}
