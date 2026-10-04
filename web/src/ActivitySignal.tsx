import { useEffect, useRef } from "react";
import type { ActivityKind } from "./activity-kind";
import { mountSignal } from "./gpu";

/** A live instrument. Completion unmounts both renderers and their frame loops. */
export function ActivitySignal({
  active,
  kind = "thinking",
}: {
  active: boolean;
  kind?: ActivityKind;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const fallback = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (active && canvas.current && fallback.current)
      return mountSignal(canvas.current, fallback.current, kind);
  }, [active, kind]);
  if (!active) return null;
  return (
    <span className="activity-signal" data-activity={kind} aria-hidden="true">
      <canvas ref={fallback} className="signal-fallback" />
      <canvas ref={canvas} className="signal-gpu" data-hub-gpu="activity" />
    </span>
  );
}
