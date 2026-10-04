import type { TerminalResources } from "./terminal-session";
import { terminalHistoryOutput } from "./terminal-history-output";

export type TerminalHistory = { text: string; cols: number; rows: number };
export type HistoryState = "live" | "loading" | "history";

/** Each browser reads its own snapshot. The live emulator keeps receiving output. */
export function mountTerminalHistory(options: {
  element: HTMLElement;
  liveSurface: HTMLElement;
  terminal: TerminalResources["terminal"];
  canInput: () => boolean;
  create: () => Promise<TerminalResources>;
  load: (signal: AbortSignal) => Promise<TerminalHistory>;
  onState: (state: HistoryState) => void;
  onError: (message: string) => void;
}) {
  let disposed = false,
    generation = 0,
    offset = 0,
    remainder = 0;
  let state: HistoryState = "live";
  let request: AbortController | undefined;
  let view: TerminalResources | undefined;
  let surface: HTMLDivElement | undefined;
  let observer: ResizeObserver | undefined;
  const setState = (next: HistoryState) => {
    state = next;
    if (!disposed) options.onState(next);
  };
  const live = () => {
    generation++;
    request?.abort();
    request = undefined;
    observer?.disconnect();
    observer = undefined;
    view?.terminal.dispose();
    view = undefined;
    surface?.remove();
    surface = undefined;
    options.liveSurface.style.visibility = "";
    offset = 0;
    remainder = 0;
    setState("live");
  };
  const scroll = async (amount: number) => {
    if (disposed) return;
    // Ghostty's history lookup requires whole rows. Keep fractional trackpad
    // movement here instead of passing it through and losing a rendered row.
    remainder += amount;
    const lines = Math.trunc(remainder);
    remainder -= lines;
    if (!lines) return;
    if (state === "history" && view) {
      view.terminal.scrollLines(lines);
      if (lines > 0 && view.terminal.getViewportY() === 0) live();
      return;
    }
    if (state === "loading") {
      offset += lines;
      return;
    }
    if (lines >= 0) return;
    offset = lines;
    setState("loading");
    request = new AbortController();
    const current = ++generation;
    try {
      const history = await options.load(request.signal);
      if (disposed || current !== generation) return;
      const loaded = await options.create();
      if (disposed || current !== generation) {
        loaded.terminal.dispose();
        return;
      }
      view = loaded;
      surface = document.createElement("div");
      surface.className = "terminal-history-surface";
      options.element.append(surface);
      const previous = document.activeElement as HTMLElement | null;
      loaded.terminal.open(surface);
      surface.setAttribute("aria-label", "Terminal scrollback");
      surface.setAttribute("contenteditable", "false");
      loaded.terminal.blur();
      previous?.focus({ preventScroll: true });
      const input = surface.querySelector("textarea");
      if (input) {
        input.readOnly = true;
        input.inputMode = "none";
      }
      const resize = () => {
        if (!view) return;
        const size = loaded.fit.proposeDimensions();
        // Preserve the captured column grid; horizontal scrolling handles narrow views.
        loaded.terminal.resize(
          history.cols,
          size?.rows || options.terminal.rows,
        );
      };
      resize();
      loaded.terminal.write(terminalHistoryOutput(history.text));
      loaded.terminal.scrollToBottom();
      loaded.terminal.scrollLines(Math.min(-1, offset));
      options.liveSurface.style.visibility = "hidden";
      observer = new ResizeObserver(resize);
      observer.observe(surface);
      setState("history");
    } catch (error) {
      if (disposed || current !== generation) return;
      live();
      options.onError(error instanceof Error ? error.message : String(error));
    }
  };
  const wheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey || !event.deltaY) return;
    event.preventDefault();
    event.stopPropagation();
    const unit =
      event.deltaMode === 1
        ? 1
        : event.deltaMode === 2
          ? options.terminal.rows
          : 1 / 18;
    void scroll(event.deltaY * unit);
  };
  const key = (event: KeyboardEvent) => {
    if (
      (event.key === "PageUp" || event.key === "PageDown") &&
      (state !== "live" || event.shiftKey || !options.canInput())
    ) {
      event.preventDefault();
      event.stopPropagation();
      void scroll(
        (event.key === "PageUp" ? -1 : 1) * options.terminal.rows * 0.8,
      );
    } else if (
      state !== "live" &&
      (event.key === "Escape" || event.key === "End")
    ) {
      event.preventDefault();
      event.stopPropagation();
      live();
    }
  };
  let touchY: number | undefined;
  const touchStart = (event: TouchEvent) => {
    touchY = event.touches.length === 1 ? event.touches[0].clientY : undefined;
  };
  const touchMove = (event: TouchEvent) => {
    if (touchY === undefined || event.touches.length !== 1) return;
    const next = event.touches[0].clientY,
      delta = touchY - next;
    if (Math.abs(delta) < 3) return;
    touchY = next;
    event.preventDefault();
    event.stopPropagation();
    void scroll(delta / 18);
  };
  options.element.addEventListener("wheel", wheel, {
    capture: true,
    passive: false,
  });
  options.element.addEventListener("keydown", key, true);
  options.element.addEventListener("touchstart", touchStart, { passive: true });
  options.element.addEventListener("touchmove", touchMove, {
    capture: true,
    passive: false,
  });
  return {
    reading: () => state !== "live",
    show: () => void scroll(-options.terminal.rows * 0.8),
    live,
    dispose() {
      disposed = true;
      live();
      options.element.removeEventListener("wheel", wheel, true);
      options.element.removeEventListener("keydown", key, true);
      options.element.removeEventListener("touchstart", touchStart);
      options.element.removeEventListener("touchmove", touchMove, true);
    },
  };
}
