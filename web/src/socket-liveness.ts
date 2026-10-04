// The server sends an empty binary frame every 15s. Mobile browsers freeze
// backgrounded PWAs and a sleeping phone or network change can leave a socket
// that still reports OPEN but will never deliver again. Silence is the only
// reliable signal, so treat it as a dead connection instead of waiting for the
// operating system's TCP timeout.
const DEAD_AFTER = 40_000;
// On returning to the app, one missed heartbeat is enough to reconnect.
const RESUME_DEAD_AFTER = 20_000;

export const isHeartbeat = (data: unknown) =>
  (data instanceof ArrayBuffer && data.byteLength === 0) ||
  (typeof Blob !== "undefined" && data instanceof Blob && data.size === 0);

/**
 * Reconnects a socket that closed while hidden, went quiet, or outlived a
 * network change. `lastSeen` is when the current socket was created or last
 * received data. `reconnect` must abandon the current socket and connect now.
 */
export function watchSocket(options: {
  socket: () => WebSocket | undefined;
  lastSeen: () => number;
  reconnect: () => void;
}): () => void {
  const check = (limit: number, skipBackoff: boolean) => {
    if (document.hidden) return;
    const socket = options.socket();
    // A closed socket is already waiting to retry. Only a user returning to
    // the app, or the network coming back, should cut that wait short.
    if (!socket || socket.readyState > WebSocket.OPEN) {
      if (skipBackoff) options.reconnect();
    } else if (Date.now() - options.lastSeen() > limit) options.reconnect();
  };
  const resume = () => check(RESUME_DEAD_AFTER, true);
  // The old route is gone after a network change even if the socket looks open.
  const online = () => check(0, true);
  const interval = setInterval(() => check(DEAD_AFTER, false), 5_000);
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("pageshow", resume);
  window.addEventListener("online", online);
  return () => {
    clearInterval(interval);
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("pageshow", resume);
    window.removeEventListener("online", online);
  };
}
