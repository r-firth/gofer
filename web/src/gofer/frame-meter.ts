/** Reports how evenly this browser is really drawing frames, so slowness can be read from the
 *  server's log rather than guessed at from a test machine. One reading every ten seconds while
 *  the page is on screen. */
export function startFrameMeter() {
  let last = 0;
  let since = performance.now();
  let gaps: number[] = [];
  const frame = (time: number) => {
    requestAnimationFrame(frame);
    // A hidden or just-returned page has no meaningful gap to the previous frame.
    if (last && time - last < 1000 && document.visibilityState === "visible")
      gaps.push(time - last);
    last = time;
    if (time - since < 10000) return;
    if (gaps.length >= 30) {
      const sorted = gaps.slice().sort((a, b) => a - b);
      const at = (p: number) =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      const median = at(0.5);
      void fetch("/api/client/frames", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          hz: Math.round(1000 / median),
          frames: gaps.length,
          seconds: Math.round((time - since) / 100) / 10,
          missed: gaps.filter((gap) => gap > median * 1.5).length,
          p99_ms: Math.round(at(0.99) * 10) / 10,
          worst_ms: Math.round(sorted[sorted.length - 1]),
          working: Boolean(document.querySelector(".streaming, .ln.run")),
          focused: document.hasFocus(),
          view: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
        }),
      }).catch(() => {});
    }
    gaps = [];
    since = time;
  };
  requestAnimationFrame(frame);
}
