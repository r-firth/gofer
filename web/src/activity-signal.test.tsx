// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ActivitySignal } from "./ActivitySignal";
import { animateSignal, mountSignal } from "./gpu";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
it("renders activity only while the agent is running", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(<ActivitySignal active={false} />));
    expect(element.querySelector("canvas")).toBeNull();
    await act(async () => root.render(<ActivitySignal active />));
    expect(element.querySelector("canvas[data-hub-gpu]")).not.toBeNull();
    await act(async () => root.render(<ActivitySignal active={false} />));
    expect(element.querySelector("canvas")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
it("renders every display frame at 120 Hz and stops when disposed", () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    callbacks.set(++next, cb);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    width: 104,
    height: 28,
  } as DOMRect);
  const times: number[] = [];
  const dispose = animateSignal(canvas, { render: (time) => times.push(time) });
  const before = times.length;
  for (const time of [8.33, 16.66, 24.99, 33.32, 41.65, 49.98]) {
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach((cb) => cb(time));
  }
  expect(times.slice(before)).toEqual([
    0.00833, 0.01666, 0.02499, 0.03332, 0.04165, 0.049979999999999996,
  ]);
  dispose();
  expect(callbacks.size).toBe(0);
});

it("draws moving pixel fields without WebGPU and releases its frame loop", () => {
  vi.stubGlobal("navigator", {});
  const callbacks = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  const canvas = document.createElement("canvas");
  const fallback = document.createElement("canvas");
  const pixels: number[][] = [];
  const context = {
    globalAlpha: 1,
    fillStyle: "",
    clearRect() {
      pixels.length = 0;
    },
    fillRect(x: number, y: number, width: number, height: number) {
      pixels.push([x, y, width, height, this.globalAlpha]);
    },
  };
  // Happy DOM has no rasterizer; capture the real renderer's pixel commands.
  vi.spyOn(fallback, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(fallback, "getBoundingClientRect").mockReturnValue({
    width: 120,
    height: 64,
  } as DOMRect);
  const dispose = mountSignal(canvas, fallback);
  const frame = (time: number) => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach((callback) => callback(time));
  };
  frame(16);
  expect(pixels.length).toBeGreaterThan(20);
  // Empty space must stay clear, not become a permanent dither wallpaper.
  expect(pixels.some(([x, y]) => x === 0 && y === 0)).toBe(false);
  expect(
    pixels.every(
      ([x, y, w, h]) =>
        x >= 0 && y >= 0 && x + w <= fallback.width && y + h <= fallback.height,
    ),
  ).toBe(true);
  const first = JSON.stringify(pixels);
  frame(500);
  expect(JSON.stringify(pixels)).not.toEqual(first);
  dispose();
  expect(callbacks.size).toBe(0);
  expect(fallback.dataset.ready).toBeUndefined();
});

it("keeps reduced-motion pixels still and pauses rendering in a hidden tab", () => {
  vi.stubGlobal("navigator", {});
  const media = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal("matchMedia", () => media);
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const callbacks = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  const canvas = document.createElement("canvas");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    width: 104,
    height: 52,
  } as DOMRect);
  const times: number[] = [];
  const dispose = animateSignal(canvas, { render: (time) => times.push(time) });
  const frame = (time: number) => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach((callback) => callback(time));
  };
  frame(100);
  expect(times).toEqual([0]);
  expect(callbacks.size).toBe(0);
  media.matches = false;
  media.dispatchEvent(new Event("change"));
  frame(200);
  expect(times).toEqual([0, 0.2]);
  hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  frame(300);
  expect(times).toEqual([0, 0.2]);
  expect(callbacks.size).toBe(0);
  hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  frame(400);
  expect(times).toEqual([0, 0.2, 0.4]);
  dispose();
});

it("pauses offscreen instruments and resumes when they return to the viewport", () => {
  let intersect: IntersectionObserverCallback | undefined;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const callbacks = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  const canvas = document.createElement("canvas");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    width: 84,
    height: 44,
  } as DOMRect);
  const times: number[] = [];
  const dispose = animateSignal(canvas, { render: (time) => times.push(time) });
  const frame = (time: number) => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach((callback) => callback(time));
  };
  intersect?.(
    [{ isIntersecting: false }] as IntersectionObserverEntry[],
    {} as IntersectionObserver,
  );
  frame(100);
  expect(times).toEqual([]);
  expect(callbacks.size).toBe(0);
  intersect?.(
    [{ isIntersecting: true }] as IntersectionObserverEntry[],
    {} as IntersectionObserver,
  );
  frame(200);
  expect(times).toEqual([0.2]);
  dispose();
  expect(callbacks.size).toBe(0);
});
