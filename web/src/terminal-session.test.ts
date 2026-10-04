// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mountTerminal,
  type TerminalResources,
  type TerminalControls,
} from "./terminal-session";
import { FitAddon } from "ghostty-web";

class Socket extends EventTarget {
  static OPEN = 1;
  static all: Socket[] = [];
  readyState = 0;
  binaryType = "";
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
  constructor(public url: string) {
    super();
    Socket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  close() {
    this.readyState = 3;
    this.closed = true;
    this.onclose?.();
  }
}
function fixture(
  loadHistory?: (
    signal: AbortSignal,
  ) => Promise<{ text: string; cols: number; rows: number }>,
) {
  let resolve!: (value: TerminalResources) => void;
  const loading = new Promise<TerminalResources>((r) => {
    resolve = r;
  });
  const writes: (string | Uint8Array)[] = [];
  const statuses: string[] = [];
  const errors: string[] = [];
  let input = (data: string) => {};
  let resized = (size: { cols: number; rows: number }) => {};
  const terminal = {
    cols: 80,
    rows: 24,
    open: vi.fn(),
    write: (data: string | Uint8Array) => writes.push(data),
    reset: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    getViewportY: () => 0,
    scrollLines() {},
    scrollToBottom() {},
    resize(cols: number, rows: number) {
      terminal.cols = cols;
      terminal.rows = rows;
    },
    dispose: vi.fn(),
    onData: (f: typeof input) => {
      input = f;
      return {
        dispose() {
          input = () => {};
        },
      };
    },
    onResize: (f: typeof resized) => {
      resized = f;
      return {
        dispose() {
          resized = () => {};
        },
      };
    },
  };
  const fit = {
    proposeDimensions: vi.fn(() => ({
      cols: terminal.cols,
      rows: terminal.rows,
    })),
  };
  const element = document.createElement("div");
  document.body.append(element);
  const owner = { value: "agent" };
  let controls: TerminalControls | undefined;
  const create = vi.fn(() => loading);
  const dispose = mountTerminal({
    element,
    url: "ws://localhost/api/sessions/one/stream",
    canInput: () => owner.value === "user",
    onStatus: (s) => statuses.push(s),
    onError: (s) => errors.push(s),
    create,
    loadHistory,
    onReady: (value) => {
      controls = value;
    },
  });
  return {
    terminal,
    create,
    fit,
    writes,
    statuses,
    errors,
    element,
    owner,
    controls: () => controls,
    dispose,
    resolve: () => resolve({ terminal, fit }),
    input: (s: string) => input(s),
    resize: () => window.dispatchEvent(new Event("focus")),
  };
}
it("scrolls a private history view while agent output continues, without sending input", async () => {
  const f = fixture(async () => ({
    text: "OLDER OUTPUT\nLATEST OUTPUT",
    cols: 80,
    rows: 24,
  }));
  const history = {
    ...f.terminal,
    open: (el: HTMLElement) => {
      el.append(document.createElement("textarea"));
    },
    write: vi.fn(),
    dispose: vi.fn(),
    scrollLines: vi.fn(),
    getViewportY: () => 10,
  };
  f.create.mockResolvedValue({ terminal: history, fit: f.fit });
  try {
    f.resolve();
    await vi.waitFor(() => expect(Socket.all).toHaveLength(1));
    const socket = Socket.all[0];
    socket.open();
    f.element.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -90, bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() =>
      expect(
        f.element.querySelector(".terminal-history-surface"),
      ).not.toBeNull(),
    );
    expect(
      (
        f.element.querySelector(
          ".terminal-history-surface textarea",
        ) as HTMLTextAreaElement
      ).readOnly,
    ).toBe(true);
    expect(
      (f.element.querySelector(".ghostty-surface") as HTMLElement).style
        .visibility,
    ).toBe("hidden");
    history.scrollLines.mockClear();
    for (let i = 0; i < 2; i++)
      f.element.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -9, bubbles: true }),
      );
    expect(history.scrollLines).toHaveBeenCalledExactlyOnceWith(-1);
    const frozen = history.write.mock.calls.length;
    socket.onmessage?.({ data: "NEW LIVE OUTPUT" });
    expect(f.writes).toContain("NEW LIVE OUTPUT");
    expect(history.write.mock.calls.length).toBe(frozen);
    f.input("do not send");
    f.owner.value = "user";
    f.input("do not send while reading history either");
    expect(
      socket.sent.map((v) => JSON.parse(v)).filter((v) => v.type === "input"),
    ).toEqual([]);
    f.controls()!.live();
    expect(f.element.querySelector(".terminal-history-surface")).toBeNull();
    expect(
      (f.element.querySelector(".ghostty-surface") as HTMLElement).style
        .visibility,
    ).toBe("");
    expect(history.dispose).toHaveBeenCalledOnce();
  } finally {
    f.dispose();
  }
});
it("keeps the live terminal usable if history is unavailable", async () => {
  const f = fixture(async () => {
    throw new Error("History unavailable");
  });
  try {
    f.resolve();
    await vi.waitFor(() => expect(Socket.all).toHaveLength(1));
    Socket.all[0].open();
    f.element.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -90, bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(f.errors).toContain("History unavailable"));
    expect(f.terminal.dispose).not.toHaveBeenCalled();
    expect(f.element.querySelector(".terminal-history-surface")).toBeNull();
    Socket.all[0].onmessage?.({ data: "STILL LIVE" });
    expect(f.writes).toContain("STILL LIVE");
    f.owner.value = "user";
    f.controls()!.send("echo hello\n");
    expect(JSON.parse(Socket.all[0].sent.at(-1)!)).toEqual({
      type: "input",
      data: "echo hello\n",
    });
  } finally {
    f.dispose();
  }
});
it("cancels a pending history fetch when leaving the terminal", async () => {
  let signal: AbortSignal | undefined;
  let finish!: (value: { text: string; cols: number; rows: number }) => void;
  const f = fixture((s) => {
    signal = s;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  f.resolve();
  await vi.waitFor(() => expect(Socket.all).toHaveLength(1));
  f.element.dispatchEvent(
    new WheelEvent("wheel", { deltaY: -90, bubbles: true, cancelable: true }),
  );
  await vi.waitFor(() => expect(signal).toBeDefined());
  f.dispose();
  expect(signal!.aborted).toBe(true);
  finish({ text: "late", cols: 80, rows: 24 });
  await Promise.resolve();
  expect(f.element.querySelector(".terminal-history-surface")).toBeNull();
});
beforeEach(() => {
  Socket.all = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});
it("mobile keys obey ownership, connection state, and disposal", async () => {
  const f = fixture();
  try {
    f.resolve();
    await vi.waitFor(() => expect(Socket.all).toHaveLength(1));
    const socket = Socket.all[0];
    expect(f.controls()).toBeDefined();
    const controls = f.controls()!;
    socket.open();
    controls.send("\t");
    expect(
      socket.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "input"),
    ).toEqual([]);
    f.owner.value = "user";
    controls.send("\u001b[A");
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "input",
      data: "\u001b[A",
    });
    socket.close();
    const count = socket.sent.length;
    controls.send("\r");
    expect(socket.sent).toHaveLength(count);
    f.dispose();
    expect(f.controls()).toBeUndefined();
    controls.send("\u0003");
    expect(socket.sent).toHaveLength(count);
  } finally {
    f.dispose();
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});
it("waits for WASM before opening a live connection", async () => {
  const f = fixture();
  try {
    expect(Socket.all).toHaveLength(0);
    f.resolve();
    await vi.waitFor(() => expect(Socket.all).toHaveLength(1));
    expect(f.terminal.open).toHaveBeenCalledWith(expect.any(HTMLElement));
  } finally {
    f.dispose();
  }
});
it("preserves the composer focus and keeps a watcher keyboard read-only", async () => {
  const f = fixture();
  const composer = document.createElement("textarea");
  const terminalInput = document.createElement("textarea");
  document.body.append(composer);
  composer.focus();
  f.terminal.open.mockImplementation((element) => {
    element.append(terminalInput);
    terminalInput.focus();
  });
  f.terminal.blur.mockImplementation(() => terminalInput.blur());
  try {
    f.resolve();
    await vi.waitFor(() => expect(f.controls()).toBeDefined());
    expect(document.activeElement).toBe(composer);
    expect(terminalInput.readOnly).toBe(true);
    expect(terminalInput.inputMode).toBe("none");
    f.owner.value = "user";
    f.controls()!.syncInput();
    expect(terminalInput.readOnly).toBe(false);
    f.owner.value = "agent";
    f.controls()!.syncInput();
    expect(terminalInput.readOnly).toBe(true);
  } finally {
    f.dispose();
    composer.remove();
  }
});
it("does not attach a late WASM load after switching sessions", async () => {
  const f = fixture();
  f.dispose();
  f.resolve();
  await vi.waitFor(() => expect(f.terminal.dispose).toHaveBeenCalledOnce());
  expect(Socket.all).toHaveLength(0);
  expect(f.terminal.open).not.toHaveBeenCalled();
  expect(f.element.children).toHaveLength(0);
});
it("forwards binary output intact and enforces current input ownership", async () => {
  const f = fixture();
  try {
    f.resolve();
    await vi.waitFor(() => expect(Socket.all).toHaveLength(1));
    const socket = Socket.all[0];
    socket.open();
    socket.onmessage?.({
      data: new Uint8Array([27, 91, 51, 49, 109, 226, 156, 147]).buffer,
    });
    expect(f.writes).toEqual([
      new Uint8Array([27, 91, 51, 49, 109, 226, 156, 147]),
    ]);
    f.input("blocked\n");
    expect(
      socket.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "input"),
    ).toEqual([]);
    f.owner.value = "user";
    f.input("pwd\n");
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "input",
      data: "pwd\n",
    });
    f.owner.value = "agent";
    f.input("blocked again\n");
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "input",
      data: "pwd\n",
    });
  } finally {
    f.dispose();
  }
});
it("reconnects without stealing sizing from a more recent viewer and cancels retries on disposal", async () => {
  const f = fixture();
  try {
    f.resolve();
    await vi.waitFor(() => expect(Socket.all).toHaveLength(1));
    vi.useFakeTimers();
    Socket.all[0].open();
    f.terminal.cols = 100;
    f.terminal.rows = 30;
    f.resize();
    expect(JSON.parse(Socket.all[0].sent.at(-1)!)).toEqual({
      type: "resize",
      cols: 100,
      rows: 30,
      active: true,
    });
    Socket.all[0].close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(Socket.all).toHaveLength(2);
    Socket.all[1].open();
    expect(JSON.parse(Socket.all[1].sent[0])).toEqual({
      type: "resize",
      cols: 100,
      rows: 30,
      active: false,
    });
    Socket.all[1].close();
    f.dispose();
    await vi.advanceTimersByTimeAsync(20000);
    expect(Socket.all).toHaveLength(2);
  } finally {
    f.dispose();
  }
});
it("ignores heartbeats and skips the retry wait when the app returns", async () => {
  const f = fixture();
  try {
    f.resolve();
    await vi.waitFor(() => expect(Socket.all).toHaveLength(1));
    vi.useFakeTimers();
    Socket.all[0].open();
    const written = f.writes.length;
    Socket.all[0].onmessage?.({ data: new ArrayBuffer(0) });
    expect(f.writes).toHaveLength(written);
    Socket.all[0].close();
    await vi.advanceTimersByTimeAsync(1000);
    Socket.all[1].close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(Socket.all).toHaveLength(2);
    // The app is backing off; returning to it must reconnect right away.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(Socket.all).toHaveLength(3);
    Socket.all[2].open();
    await vi.advanceTimersByTimeAsync(20000);
    expect(Socket.all).toHaveLength(3);
  } finally {
    f.dispose();
  }
});
it("reports initialization failure without opening a socket", async () => {
  const onError = vi.fn();
  const dispose = mountTerminal({
    element: document.createElement("div"),
    url: "ws://localhost",
    canInput: () => false,
    onStatus: () => {},
    onError,
    create: () => Promise.reject(new Error("WASM unavailable")),
  });
  try {
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith("WASM unavailable"),
    );
    expect(Socket.all).toHaveLength(0);
  } finally {
    dispose();
  }
});

it("applies the final container size during a rapid resize with Ghostty's real fit addon", async () => {
  vi.useFakeTimers();
  let observerChanged = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observerChanged = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const f = fixture();
  const geometry = { width: 420, height: 480 };
  const terminal = Object.assign(f.terminal, {
    element: undefined as HTMLElement | undefined,
    renderer: { getMetrics: () => ({ width: 9, height: 15 }) },
    resize(cols: number, rows: number) {
      f.terminal.cols = cols;
      f.terminal.rows = rows;
    },
  });
  terminal.open.mockImplementation((element: HTMLElement) => {
    terminal.element = element;
    Object.defineProperties(element, {
      clientWidth: { get: () => geometry.width },
      clientHeight: { get: () => geometry.height },
    });
  });
  const fit = new FitAddon();
  fit.activate(terminal as unknown as Parameters<FitAddon["activate"]>[0]);
  f.fit.proposeDimensions.mockImplementation(() => fit.proposeDimensions()!);
  try {
    f.resolve();
    await Promise.resolve();
    Socket.all[0].open();
    await vi.advanceTimersByTimeAsync(10);
    geometry.width = 930;
    observerChanged();
    await vi.advanceTimersByTimeAsync(15);
    geometry.width = 720;
    observerChanged();
    await vi.advanceTimersByTimeAsync(150);
    // (720px - 15px scrollbar) / 9px cells; 480px / 15px rows.
    const expected = { cols: 78, rows: 32 };
    expect(JSON.parse(Socket.all[0].sent.at(-1)!)).toEqual({
      type: "resize",
      ...expected,
      active: false,
    });
    Socket.all[0].onmessage?.({
      data: JSON.stringify({ type: "geometry", ...expected }),
    });
    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual(expected);
    geometry.width = 1020;
    observerChanged();
    f.dispose();
    await vi.advanceTimersByTimeAsync(150);
    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual(expected);
  } finally {
    f.dispose();
    fit.dispose();
  }
});

it("adopts the server grid without a resize feedback loop", async () => {
  const f = fixture();
  try {
    f.resolve();
    await vi.waitFor(() => expect(Socket.all).toHaveLength(1));
    Socket.all[0].open();
    expect(JSON.parse(Socket.all[0].sent[0])).toEqual({
      type: "resize",
      cols: 80,
      rows: 24,
      active: true,
    });
    const count = Socket.all[0].sent.length;
    Socket.all[0].onmessage?.({
      data: JSON.stringify({ type: "geometry", cols: 100, rows: 30 }),
    });
    expect(f.terminal.cols).toBe(100);
    expect(f.terminal.rows).toBe(30);
    expect(f.writes).toEqual([]);
    expect(Socket.all[0].sent).toHaveLength(count);
  } finally {
    f.dispose();
  }
});

it("only claims sizing when a viewer opens or the user returns, never from layout or terminal autofocus", async () => {
  vi.useFakeTimers();
  let observerChanged = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observerChanged = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  // Embedded browsers can still report focus after another browser takes over.
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const f = fixture();
  try {
    f.resolve();
    await Promise.resolve();
    const socket = Socket.all[0];
    socket.open();
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ active: true });
    socket.sent.length = 0;
    // Another viewer has since become active; this view's shell grid follows it.
    socket.onmessage?.({
      data: JSON.stringify({ type: "geometry", cols: 120, rows: 40 }),
    });
    f.fit.proposeDimensions.mockReturnValue({ cols: 42, rows: 20 });
    f.element.firstElementChild!.dispatchEvent(
      new FocusEvent("focusin", { bubbles: true }),
    );
    observerChanged();
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.sent.map((s) => JSON.parse(s))).toEqual([
      { type: "resize", cols: 42, rows: 20, active: false },
    ]);
    // Returning to this window makes it the most recent viewer again.
    window.dispatchEvent(new Event("focus"));
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "resize",
      cols: 42,
      rows: 20,
      active: true,
    });
    socket.sent.length = 0;
    observerChanged();
    await vi.advanceTimersByTimeAsync(100);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ active: false });
    // Clicking the terminal also takes over when both browser windows stay visible.
    f.element.firstElementChild!.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ active: true });
  } finally {
    f.dispose();
  }
});
