import type { Terminal, FitAddon } from "ghostty-web";
import {
  mountTerminalHistory,
  type TerminalHistory,
  type HistoryState,
} from "./terminal-history";
import { isHeartbeat, watchSocket } from "./socket-liveness";
export type TerminalResources = {
  terminal: Pick<
    Terminal,
    | "open"
    | "write"
    | "reset"
    | "focus"
    | "blur"
    | "resize"
    | "onData"
    | "onResize"
    | "dispose"
    | "cols"
    | "rows"
    | "getViewportY"
    | "scrollLines"
    | "scrollToBottom"
  >;
  fit: Pick<FitAddon, "proposeDimensions">;
};
export type TerminalControls = {
  send: (data: string) => void;
  keyboard: () => void;
  syncInput: () => void;
  activate: () => void;
  history: () => void;
  live: () => void;
};
export type TerminalMount = {
  element: HTMLElement;
  interactionElement?: HTMLElement;
  url: string;
  canInput: () => boolean;
  onStatus: (status: string) => void;
  onError: (message: string) => void;
  create: () => Promise<TerminalResources>;
  onReady?: (controls: TerminalControls | undefined) => void;
  loadHistory?: (signal: AbortSignal) => Promise<TerminalHistory>;
  onHistoryState?: (state: HistoryState) => void;
};

/** Owns one view/connection. Disposing it never closes the persistent shell. */
export function mountTerminal(options: TerminalMount): () => void {
  let disposed = false;
  let resources: TerminalResources | undefined;
  let surface: HTMLDivElement | undefined;
  let socket: WebSocket | undefined;
  let observer: ResizeObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let lastSeen = 0;
  let history: ReturnType<typeof mountTerminalHistory> | undefined;
  const subscriptions: { dispose(): void }[] = [];
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    clearTimeout(resizeTimer);
    observer?.disconnect();
    subscriptions.forEach((s) => s.dispose());
    history?.dispose();
    socket?.close();
    resources?.terminal.dispose();
    surface?.remove();
    options.onReady?.(undefined);
  };
  const fail = (error: unknown) => {
    if (disposed) return;
    dispose();
    options.onStatus("Terminal unavailable");
    options.onError(error instanceof Error ? error.message : String(error));
  };
  options.onStatus("Loading terminal");
  void options
    .create()
    .then((loaded) => {
      if (disposed) {
        loaded.terminal.dispose();
        return;
      }
      resources = loaded;
      const { terminal, fit } = loaded;
      surface = document.createElement("div");
      surface.className = "ghostty-surface";
      options.element.append(surface);
      const previousFocus = document.activeElement as HTMLElement | null;
      terminal.open(surface);
      // Opening a watcher must not steal the chat composer or open a phone keyboard.
      terminal.blur();
      if (previousFocus && previousFocus !== document.body)
        previousFocus.focus({ preventScroll: true });
      if (options.loadHistory)
        history = mountTerminalHistory({
          element: options.element,
          liveSurface: surface,
          terminal,
          canInput: options.canInput,
          create: options.create,
          load: options.loadHistory,
          onState: (state) => options.onHistoryState?.(state),
          onError: options.onError,
        });
      // Opening/returning to a view claims sizing once. Layout changes and
      // automatic reconnects only report dimensions; they cannot steal it back.
      let claimPending = !document.hidden;
      const resize = () => {
        const size = fit.proposeDimensions();
        if (!disposed && size && socket?.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              type: "resize",
              ...size,
              active: claimPending,
            }),
          );
          claimPending = false;
        }
      };
      const takeSizing = () => {
        if (disposed || document.hidden) return;
        claimPending = true;
        resize();
      };
      const interactionElement = options.interactionElement ?? surface;
      window.addEventListener("focus", takeSizing);
      document.addEventListener("visibilitychange", takeSizing);
      interactionElement.addEventListener("pointerdown", takeSizing, true);
      interactionElement.addEventListener("keydown", takeSizing, true);
      subscriptions.push({
        dispose: () => {
          window.removeEventListener("focus", takeSizing);
          document.removeEventListener("visibilitychange", takeSizing);
          interactionElement.removeEventListener(
            "pointerdown",
            takeSizing,
            true,
          );
          interactionElement.removeEventListener("keydown", takeSizing, true);
        },
      });
      const sendInput = (data: string) => {
        if (
          !disposed &&
          !history?.reading() &&
          options.canInput() &&
          socket?.readyState === WebSocket.OPEN
        )
          socket.send(JSON.stringify({ type: "input", data }));
      };
      subscriptions.push(terminal.onData(sendInput));
      const syncInput = () => {
        const input = surface?.querySelector("textarea");
        if (!input) return;
        input.readOnly = !options.canInput();
        input.inputMode = options.canInput() ? "text" : "none";
        if (!options.canInput()) terminal.blur();
      };
      syncInput();
      options.onReady?.({
        send: sendInput,
        syncInput,
        activate: takeSizing,
        history: () => history?.show(),
        live: () => history?.live(),
        keyboard: () => {
          if (disposed || history?.reading() || !options.canInput()) return;
          if (surface?.contains(document.activeElement)) terminal.blur();
          else terminal.focus();
        },
      });
      const connect = () => {
        if (disposed) return;
        clearTimeout(timer);
        options.onStatus("Connecting");
        const current = new WebSocket(options.url);
        socket = current;
        lastSeen = Date.now();
        current.binaryType = "arraybuffer";
        current.onopen = () => {
          if (disposed || current !== socket) return;
          lastSeen = Date.now();
          attempt = 0;
          terminal.reset();
          resize();
          options.onStatus("Connected");
        };
        current.onmessage = (e) => {
          if (disposed || current !== socket) return;
          lastSeen = Date.now();
          if (isHeartbeat(e.data)) return;
          if (typeof e.data === "string" && e.data.startsWith("{")) {
            const message = JSON.parse(e.data);
            if (message.type === "geometry") {
              terminal.resize(message.cols, message.rows);
              return;
            }
          }
          terminal.write(
            typeof e.data === "string" ? e.data : new Uint8Array(e.data),
          );
        };
        current.onclose = () => {
          if (disposed || current !== socket) return;
          options.onStatus("Reconnecting");
          timer = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15000));
        };
        current.onerror = () => {
          if (!disposed && current === socket)
            options.onStatus("Connection unavailable");
        };
      };
      observer = new ResizeObserver(() => {
        // Coalesce a resize burst, then measure its final geometry. The server
        // owns the grid; older views must never reclaim sizing from this event.
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => resize(), 75);
      });
      observer.observe(surface);
      connect();
      subscriptions.push({
        dispose: watchSocket({
          socket: () => socket,
          lastSeen: () => lastSeen,
          reconnect: () => {
            const stale = socket;
            socket = undefined;
            stale?.close();
            attempt = 0;
            connect();
          },
        }),
      });
    })
    .catch(fail);
  return dispose;
}
