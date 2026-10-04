// The ground: a few very large, slow, soft fields of colour over warm ink, resolved into fine
// grain with a blue-noise threshold. It is only seen in the gutters between slabs, through
// windows (the alert, a machine with nothing to show), and thinned out under the status line.

export type Mood = {
  /** Something is waiting on the owner. */
  need: boolean;
  /** Something is working. */
  work: boolean;
  /** The screen is showing the past. */
  past: boolean;
  /** Where the alert is on screen, when there is one. */
  focus?: DOMRect;
};

import { CELL, createPainter, gridOf, type Target } from "./aura-paint";

// peach, rose, teal, gold, overall: nothing happening, something working, something needs him
const MOODS = [
  [0.22, 0.4, 0.72, 0.2, 0.78],
  [0.4, 0.62, 0.9, 0.45, 0.9],
  [1, 0.84, 0.82, 0.7, 1],
];
const hex = (name: string) => {
  const value = parseInt(
    getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim()
      .slice(1),
    16,
  );
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

type Frame = { show?: ImageBitmap; keep?: ImageBitmap };

/** Keeps the ground in `canvas` and every `canvas.win` showing the part behind it. The pixels are
 *  worked out in a worker, so painting never costs the page a frame. */
export function startAura(canvas: HTMLCanvasElement) {
  const reduce = matchMedia("(prefers-reduced-motion:reduce)").matches;
  const inks = ["--a-peach", "--a-rose", "--a-teal", "--a-gold"].map(hex);
  const ground = hex("--ink");
  const now: Target & { ready: boolean } = {
    m: [0, 0, 0, 0],
    gain: 0,
    sat: 1,
    px: 0.4,
    py: 0.5,
    f: 0,
    ready: false,
  };
  const want: Target = {
    m: [0, 0, 0, 0],
    gain: 0,
    sat: 1,
    px: 0.4,
    py: 0.5,
    f: 0,
  };
  let scale = 1;
  let width = 0;
  let height = 0;
  let gridW = 0;
  let gridH = 0;
  let tick = 0;
  let last = 0;
  let frame = 0;
  let stopped = false;
  // Which cells of the ground can be seen at all. Slabs are solid and cover most of the screen,
  // so only the gutters, the status line and the windows are worth painting.
  let seen: Uint8Array | undefined;
  let seenSent = false;
  // The frame on screen, kept so windows can be filled from it at any time.
  let held: ImageBitmap | undefined;
  let busy = false;
  let again = false;

  // A finished frame is handed to the canvas whole. Without that (an old browser), paint here.
  const display = canvas.getContext("bitmaprenderer");
  const flat = display ? null : canvas.getContext("2d");
  let worker: Worker | undefined;
  let local: ReturnType<typeof createPainter> | undefined;
  const paintHere = () => {
    worker?.terminate();
    worker = undefined;
    local = createPainter(inks, ground);
    if (width) local.size(width, height, scale);
    busy = false;
  };
  if (display && typeof Worker === "function")
    try {
      worker = new Worker(new URL("./aura.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.postMessage({ type: "init", inks, ground });
      worker.onmessage = (event: MessageEvent<Frame>) => present(event.data);
      worker.onerror = () => {
        paintHere();
        request();
      };
    } catch {
      paintHere();
    }
  else paintHere();

  function size() {
    scale = innerWidth * innerHeight > 2.6e6 ? 2 : 1;
    width = Math.ceil(innerWidth / scale);
    height = Math.ceil(innerHeight / scale);
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${width * scale}px`;
    canvas.style.height = `${height * scale}px`;
    ({ gridW, gridH } = gridOf(width, height));
    seen = undefined;
    seenSent = false;
    worker?.postMessage({ type: "size", width, height, scale });
    local?.size(width, height, scale);
  }

  function present({ show, keep }: Frame) {
    busy = false;
    if (show && keep && display && !stopped) {
      display.transferFromImageBitmap(show);
      held?.close();
      held = keep;
      fillWindows();
    }
    if (again) {
      again = false;
      request();
    }
  }

  /** Asks for the ground as it is now. One request at a time; a later one waits its turn. */
  function request() {
    if (!width || stopped) return;
    if (busy) {
      again = true;
      return;
    }
    const t = tick * 0.14;
    const state: Target = {
      m: now.m.slice(),
      gain: now.gain,
      sat: now.sat,
      px: now.px,
      py: now.py,
      f: now.f,
    };
    if (worker) {
      busy = true;
      worker.postMessage({
        type: "paint",
        t,
        now: state,
        seen: seenSent ? undefined : (seen ?? null),
      });
      seenSent = true;
      return;
    }
    const image = local?.paint(t, state, seen);
    if (!image) return;
    if (flat) {
      flat.putImageData(image, 0, 0);
      fillWindows();
      return;
    }
    busy = true;
    void Promise.all([createImageBitmap(image), createImageBitmap(image)]).then(
      ([show, keep]) => present({ show, keep }),
    );
  }

  /** Works out which cells are in view. True when that changed, so the ground needs painting. */
  function look() {
    const boxes = (query: string, own: boolean) =>
      [...document.querySelectorAll<HTMLElement>(query)]
        .map((el) => (own ? el : el.parentElement!).getBoundingClientRect())
        .filter((r) => r.width > 2 && r.height > 2);
    const slabs = boxes(".slab", true);
    let next: Uint8Array | undefined;
    if (slabs.length) {
      next = new Uint8Array(gridW * gridH).fill(1);
      const cell = CELL * scale;
      const mark = (r: DOMRect, inset: number, value: number) => {
        // Hidden cells must sit wholly inside a slab, clear of its rounded corners; a window
        // shows every cell it touches.
        const round = value ? Math.floor : Math.ceil;
        const back = value ? Math.ceil : Math.floor;
        const x0 = Math.max(0, round((r.left + inset) / cell));
        const x1 = Math.min(gridW, back((r.right - inset) / cell));
        const y0 = Math.max(0, round((r.top + inset) / cell));
        const y1 = Math.min(gridH, back((r.bottom - inset) / cell));
        for (let y = y0; y < y1; y++)
          next!.fill(value, y * gridW + x0, y * gridW + Math.max(x0, x1));
      };
      for (const r of slabs) mark(r, 12, 0);
      for (const r of boxes("canvas.win", false)) mark(r, 0, 1);
    }
    const changed =
      next?.length !== seen?.length ||
      Boolean(next && seen && next.some((v, i) => v !== seen![i]));
    seen = next;
    if (changed) seenSent = false;
    return changed;
  }

  // A window is a canvas that shows the part of the ground directly behind it, grain aligned.
  function fillWindows() {
    const source = flat ? canvas : held;
    if (!width || !source) return;
    document
      .querySelectorAll<HTMLCanvasElement>("canvas.win")
      .forEach((win) => {
        const parent = win.parentElement!;
        const rect = parent.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return;
        const x0 = Math.floor(rect.left / scale);
        const y0 = Math.floor(rect.top / scale);
        const w = Math.ceil(rect.right / scale) - x0;
        const h = Math.ceil(rect.bottom / scale) - y0;
        if (win.width !== w || win.height !== h) {
          win.width = w;
          win.height = h;
          win.style.width = `${w * scale}px`;
          win.style.height = `${h * scale}px`;
        }
        win.style.left = `${x0 * scale - rect.left - parent.clientLeft}px`;
        win.style.top = `${y0 * scale - rect.top - parent.clientTop}px`;
        const target = win.getContext("2d")!;
        target.clearRect(0, 0, w, h);
        target.drawImage(source, x0, y0, w, h, 0, 0, w, h);
      });
  }

  function snap() {
    now.m = want.m.slice();
    now.gain = want.gain;
    now.sat = want.sat;
    now.px = want.px;
    now.py = want.py;
    now.f = want.f;
    now.ready = true;
    request();
  }

  /** Warm, with a bloom at the alert, when something needs him; quieter when idle; cooler in the past. */
  function setMood(mood: Mood) {
    const m = MOODS[mood.need ? 2 : mood.work ? 1 : 0];
    want.m = mood.past
      ? [m[0] * 0.3, m[1] * 0.5, m[2] * 1.15, m[3] * 0.35]
      : m.slice(0, 4);
    want.gain = m[4];
    want.sat = mood.past ? 0.72 : 1;
    if (mood.focus && mood.focus.width > 2) {
      want.px = (mood.focus.left + mood.focus.width / 2) / innerWidth;
      want.py = (mood.focus.top + mood.focus.height / 2) / innerHeight;
      want.f = 1;
    } else want.f = 0;
    if (reduce || !now.ready) snap();
  }

  const settling = () =>
    Math.abs(now.gain - want.gain) +
      Math.abs(now.sat - want.sat) +
      Math.abs(now.f - want.f) +
      Math.abs(now.px - want.px) +
      Math.abs(now.py - want.py) +
      Math.abs(now.m[0] - want.m[0]) +
      Math.abs(now.m[2] - want.m[2]) >
    0.004;

  function loop(time: number) {
    if (stopped) return;
    frame = requestAnimationFrame(loop);
    if (document.hidden || time - last < 140) return;
    last = time;
    tick++;
    const ease = 0.07;
    for (let k = 0; k < 4; k++) now.m[k] += (want.m[k] - now.m[k]) * ease;
    now.gain += (want.gain - now.gain) * ease;
    now.sat += (want.sat - now.sat) * ease;
    now.f += (want.f - now.f) * ease;
    now.px += (want.px - now.px) * 0.16;
    now.py += (want.py - now.py) * 0.16;
    if (look() || settling() || tick % 3 === 0) request();
  }

  /** After the page changed: repaint first if a different part of the ground is now in view. */
  function refill() {
    if (look()) request();
    fillWindows();
  }

  const resize = () => {
    size();
    snap();
  };
  size();
  addEventListener("resize", resize);
  if (!reduce) frame = requestAnimationFrame(loop);
  return {
    setMood,
    fillWindows: refill,
    stop() {
      stopped = true;
      cancelAnimationFrame(frame);
      removeEventListener("resize", resize);
      worker?.terminate();
      held?.close();
    },
  };
}
