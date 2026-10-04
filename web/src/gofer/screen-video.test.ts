import { describe, expect, it } from "vitest";
import { frameMs, readPacket } from "./screen-video";

/** One packet of the rcdp wire, as cua-spacesd sends it. */
function packet(header: unknown, payload: number[]) {
  const described = new TextEncoder().encode(JSON.stringify(header));
  const bytes = new Uint8Array(8 + described.length + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, described.length);
  view.setUint32(4, payload.length);
  bytes.set(described, 8);
  bytes.set(payload, 8 + described.length);
  return bytes.buffer;
}

describe("readPacket", () => {
  it("reads a video packet's description and its H.264 payload", () => {
    const read = readPacket(
      packet(
        {
          direction: "video",
          message: {
            session_id: "media-4",
            sequence: 265417979341,
            geometry_epoch: 2,
            codec_epoch: 1,
            width_px: 1920,
            height_px: 1247,
            capture_timestamp_us: 1542026557040,
            codec: "h264",
            keyframe: true,
          },
        },
        [0, 0, 0, 1, 0x27, 0x42],
      ),
    );
    expect(read).toMatchObject({
      keyframe: true,
      codec_epoch: 1,
      width_px: 1920,
      height_px: 1247,
      capture_timestamp_us: 1542026557040,
    });
    expect([...read!.data]).toEqual([0, 0, 0, 1, 0x27, 0x42]);
  });

  it("ignores what is not H.264 video, and anything cut short", () => {
    const control = { direction: "server", message: { type: "hello" } };
    expect(readPacket(packet(control, []))).toBeUndefined();
    const png = { direction: "video", message: { codec: "png" } };
    expect(readPacket(packet(png, [1]))).toBeUndefined();
    expect(readPacket(new ArrayBuffer(4))).toBeUndefined();
    const whole = packet(
      { direction: "video", message: { codec: "h264" } },
      [1, 2, 3],
    );
    expect(readPacket(whole.slice(0, whole.byteLength - 1))).toBeUndefined();
  });
});

describe("frameMs", () => {
  it("follows the capture clock, but never waits out a still screen", () => {
    expect(frameMs(16_667)).toBe(17);
    expect(frameMs(5_000_000)).toBe(50);
    expect(frameMs(-40_000)).toBe(4);
  });
});
