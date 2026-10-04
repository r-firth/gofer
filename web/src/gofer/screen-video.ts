// The machine's desktop as video: Cua Spaces' media packets, played in a <video>.
//
// Each binary message is one packet of the rcdp wire: two big-endian lengths, a JSON header
// and one H.264 access unit (Annex B, parameter sets on every keyframe). The page is served
// over plain http on the tailnet, where browsers do not offer WebCodecs, so the stream is
// wrapped into fragmented MP4 for Media Source Extensions, which they do.

export type VideoPacket = {
  keyframe: boolean;
  codec_epoch: number;
  width_px: number;
  height_px: number;
  capture_timestamp_us: number;
  data: Uint8Array;
};

/** Reads one packet, or nothing if it is not an H.264 video packet. */
export function readPacket(message: ArrayBuffer): VideoPacket | undefined {
  if (message.byteLength < 8) return;
  const view = new DataView(message);
  const header = view.getUint32(0);
  const payload = view.getUint32(4);
  if (8 + header + payload > message.byteLength) return;
  let described;
  try {
    described = JSON.parse(
      new TextDecoder().decode(new Uint8Array(message, 8, header)),
    );
  } catch {
    return;
  }
  const frame = described?.message;
  if (described?.direction !== "video" || frame?.codec !== "h264") return;
  return {
    keyframe: Boolean(frame.keyframe),
    codec_epoch: Number(frame.codec_epoch) || 0,
    width_px: Number(frame.width_px) || 0,
    height_px: Number(frame.height_px) || 0,
    capture_timestamp_us: Number(frame.capture_timestamp_us) || 0,
    data: new Uint8Array(message, 8 + header, payload),
  };
}

/** How long a frame is given on the video's timeline, from when it and the last were captured.
 *  Kept short: a still screen sends nothing, and the player must not sit waiting out a gap. */
export const frameMs = (elapsedUs: number) =>
  Math.max(4, Math.min(50, Math.round(elapsedUs / 1000)));

/** Plays packets in `video`, staying at the newest frame rather than building up a delay. */
export async function playVideo(
  video: HTMLVideoElement,
  onError: (error: unknown) => void,
) {
  const { default: JMuxer } = await import("jmuxer");
  let muxer: InstanceType<typeof JMuxer> | undefined;
  let epoch = -1;
  let last = 0;
  // The muxer drops whatever it is given before its media source has opened, and the first
  // thing it is given is the keyframe everything after depends on. Hold frames until then.
  let open = false;
  let held: { video: Uint8Array; duration: number }[] = [];
  const start = () => {
    open = false;
    held = [];
    const created: InstanceType<typeof JMuxer> = new JMuxer({
      node: video,
      mode: "video",
      flushingTime: 0,
      maxDelay: 250,
      clearBuffer: true,
      fps: 60,
      debug: Boolean((window as { goferVideoDebug?: boolean }).goferVideoDebug),
      onReady: () => {
        if (created !== muxer) return;
        open = true;
        for (const frame of held.splice(0)) created.feed(frame);
      },
      onError,
    });
    return created;
  };
  return {
    feed(packet: VideoPacket) {
      // A new encoder configuration (the screen changed size) starts a new stream, and any
      // stream starts at a keyframe.
      if (packet.codec_epoch !== epoch) {
        if (!packet.keyframe) return;
        muxer?.destroy();
        muxer = start();
        epoch = packet.codec_epoch;
        last = 0;
      }
      const duration = last ? frameMs(packet.capture_timestamp_us - last) : 16;
      last = packet.capture_timestamp_us;
      const frame = { video: packet.data, duration };
      if (!open) {
        held.push(frame);
        return;
      }
      muxer?.feed(frame);
      // Keep to the live edge: what is on screen now matters, not every frame on the way.
      const buffered = video.buffered;
      if (buffered.length && !video.seeking) {
        const end = buffered.end(buffered.length - 1);
        if (end - video.currentTime > 0.15) video.currentTime = end - 0.03;
      }
      if (video.paused) void video.play().catch(() => {});
    },
    destroy() {
      muxer?.destroy();
      muxer = undefined;
    },
  };
}
