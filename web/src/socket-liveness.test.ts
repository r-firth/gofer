// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isHeartbeat, watchSocket } from "./socket-liveness";

let hidden = false;
beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function watch(readyState: number) {
  const socket = { readyState } as WebSocket;
  let lastSeen = Date.now();
  const reconnect = vi.fn(() => {
    lastSeen = Date.now();
  });
  const stop = watchSocket({
    socket: () => socket,
    lastSeen: () => lastSeen,
    reconnect,
  });
  return { socket, reconnect, stop, seen: () => (lastSeen = Date.now()) };
}
const show = () => {
  hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
};

it("recognizes only empty binary frames as heartbeats", () => {
  expect(isHeartbeat(new ArrayBuffer(0))).toBe(true);
  expect(isHeartbeat(new Blob([]))).toBe(true);
  expect(isHeartbeat(new ArrayBuffer(1))).toBe(false);
  expect(isHeartbeat("")).toBe(false);
});

it("reconnects an open socket that went silent", async () => {
  const w = watch(WebSocket.OPEN);
  try {
    await vi.advanceTimersByTimeAsync(30_000);
    w.seen();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.reconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(w.reconnect).toHaveBeenCalledTimes(1);
  } finally {
    w.stop();
  }
});

it("reconnects immediately on return after missing a heartbeat", async () => {
  const w = watch(WebSocket.OPEN);
  try {
    hidden = true;
    await vi.advanceTimersByTimeAsync(10_000);
    show();
    expect(w.reconnect).not.toHaveBeenCalled();
    hidden = true;
    await vi.advanceTimersByTimeAsync(15_000);
    // Hidden pages are left alone; the check happens when the user returns.
    expect(w.reconnect).not.toHaveBeenCalled();
    show();
    expect(w.reconnect).toHaveBeenCalledTimes(1);
  } finally {
    w.stop();
  }
});

it("cuts a retry wait short only on return or network recovery", async () => {
  const w = watch(WebSocket.CLOSED);
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.reconnect).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("online"));
    expect(w.reconnect).toHaveBeenCalledTimes(1);
    show();
    expect(w.reconnect).toHaveBeenCalledTimes(2);
  } finally {
    w.stop();
  }
});

it("replaces an open socket when the network changes", () => {
  const w = watch(WebSocket.OPEN);
  try {
    vi.advanceTimersByTime(1);
    window.dispatchEvent(new Event("online"));
    expect(w.reconnect).toHaveBeenCalledTimes(1);
  } finally {
    w.stop();
  }
});

it("stops watching after disposal", async () => {
  const w = watch(WebSocket.CLOSED);
  w.stop();
  show();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(w.reconnect).not.toHaveBeenCalled();
});
