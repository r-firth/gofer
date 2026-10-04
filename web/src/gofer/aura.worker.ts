import { createPainter, type Target } from "./aura-paint";

type Message =
  | { type: "init"; inks: number[][]; ground: number[] }
  | { type: "size"; width: number; height: number; scale: number }
  // seen: absent means unchanged, null means every cell.
  | { type: "paint"; t: number; now: Target; seen?: Uint8Array | null };

let painter: ReturnType<typeof createPainter> | undefined;
let seen: Uint8Array | undefined;

self.onmessage = async ({ data }: MessageEvent<Message>) => {
  if (data.type === "init") painter = createPainter(data.inks, data.ground);
  else if (data.type === "size") {
    painter?.size(data.width, data.height, data.scale);
    seen = undefined;
  } else {
    if (data.seen !== undefined) seen = data.seen ?? undefined;
    const image = painter?.paint(data.t, data.now, seen);
    if (!image) return self.postMessage({});
    // One copy to put on screen, one for the page to fill its windows from.
    const [show, keep] = await Promise.all([
      createImageBitmap(image),
      createImageBitmap(image),
    ]);
    self.postMessage({ show, keep }, { transfer: [show, keep] });
  }
};
