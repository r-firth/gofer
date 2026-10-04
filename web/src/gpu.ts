import { activityModes, type ActivityKind } from "./activity-kind";
import { signalDensity, smooth } from "./signal-field";

type Surface = {
  render(time: number, width: number, height: number, pixelRatio: number): void;
};
/** One render per display callback: no frame cap, layout reads, or idle loop. */
export function animateSignal(canvas: HTMLCanvasElement, surface: Surface) {
  let disposed = false;
  let visible = true;
  let frame = 0;
  let width = 0,
    height = 0,
    ratio = 1;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const render = (time: number) => {
    if (width && height) {
      surface.render(reduced.matches ? 0 : time / 1000, width, height, ratio);
      canvas.dataset.ready = "true";
    }
  };
  const draw = (time: number) => {
    frame = 0;
    if (disposed || document.hidden || !visible) return;
    render(time);
    if (!reduced.matches) frame = requestAnimationFrame(draw);
  };
  const resume = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    if (!disposed && !document.hidden && visible)
      frame = requestAnimationFrame(draw);
  };
  const measure = () => {
    const rect = canvas.getBoundingClientRect();
    ratio = Math.min(devicePixelRatio || 1, 2);
    width = Math.round(rect.width * ratio);
    height = Math.round(rect.height * ratio);
    resume();
  };
  const observer = new ResizeObserver(measure);
  observer.observe(canvas);
  const intersection =
    typeof IntersectionObserver === "undefined"
      ? undefined
      : new IntersectionObserver(([entry]) => {
          visible = entry.isIntersecting;
          resume();
        });
  intersection?.observe(canvas);
  document.addEventListener("visibilitychange", resume);
  reduced.addEventListener("change", resume);
  measure();
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    intersection?.disconnect();
    document.removeEventListener("visibilitychange", resume);
    reduced.removeEventListener("change", resume);
    delete canvas.dataset.ready;
  };
}
let modulePromise:
  Promise<typeof import("./generated/gpu/hub_graphics.js")> | undefined;
const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** Same ordered-dither field as the WGSL surface, including over plain HTTP. */
function canvasSurface(
  canvas: HTMLCanvasElement,
  kind: ActivityKind,
): Surface | undefined {
  const context = canvas.getContext("2d");
  if (!context) return;
  return {
    render(time, width, height, ratio) {
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.clearRect(0, 0, width, height);
      const flow = kind === "flow";
      context.fillStyle = flow ? "#ff995f" : "#ffa46b";
      const pixel = flow
        ? Math.max(1, ratio) * 2
        : Math.max(1, Math.round(ratio * 1.5));
      const fit =
        kind === "web" || kind === "thinking" || kind === "flow"
          ? 1
          : Math.min(1, width / height / 1.55);
      for (let col = 0; (col + 1) * pixel <= width; col++) {
        const x = ((((col + 0.5) * pixel) / width - 0.5) * 2 * width) / height;
        for (let row = 0; (row + 1) * pixel <= height; row++) {
          const y = (((row + 0.5) * pixel) / height - 0.5) * 2;
          const density = flow
            ? signalDensity(
                kind,
                ((col + 0.5) * pixel) / width,
                ((row + 0.5) * pixel) / height,
                time,
              )
            : signalDensity(kind, x / fit, y / fit, time);
          const threshold = (bayer[(col % 4) + (row % 4) * 4] + 0.5) / 16;
          const light =
            smooth(threshold - 0.1, threshold + 0.1, density) *
            (flow ? 1 : smooth(0, 0.12, density));
          if (light < 0.025) continue;
          context.globalAlpha = light * (flow ? 0.88 : 0.95);
          const dot = pixel * (flow ? 0.72 : 1);
          context.fillRect(col * pixel, row * pixel, dot, dot);
        }
      }
      context.globalAlpha = 1;
    },
  };
}

export function mountSignal(
  canvas: HTMLCanvasElement,
  fallback: HTMLCanvasElement,
  kind: ActivityKind = "thinking",
) {
  let disposed = false;
  let release: (() => void) | undefined;
  let free: (() => void) | undefined;
  const cpu = canvasSurface(fallback, kind);
  let releaseFallback = cpu ? animateSignal(fallback, cpu) : undefined;
  if ("gpu" in navigator) {
    modulePromise ??= import("./generated/gpu/hub_graphics.js").then(
      async (module) => {
        await module.default();
        return module;
      },
    );
    void modulePromise
      .then((module) => module.DitherSurface.create(canvas))
      .then((surface) => {
        if (disposed) {
          surface.free();
          return;
        }
        free = () => surface.free();
        release = animateSignal(canvas, {
          render(...args) {
            surface.render(...args, activityModes[kind]);
            releaseFallback?.();
            releaseFallback = undefined;
          },
        });
      })
      .catch(() => {
        /* The canvas renderer keeps the same pixel field on HTTP and older GPUs. */
      });
  }
  return () => {
    disposed = true;
    release?.();
    releaseFallback?.();
    free?.();
  };
}
