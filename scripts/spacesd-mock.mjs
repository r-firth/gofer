// A stand-in for cua-spacesd, for testing Gofer's screen view without a Mac's permission:
// the same three things Gofer uses (GET /health, StreamService.OpenMedia over gRPC-Web, and
// the /media WebSocket speaking the rcdp v2 wire), fed from an H.264 mp4 on disk.
//
//   node scripts/spacesd-mock.mjs <recording.mp4> [--port 3299] [--fps 30] [--token TOKEN]
//
// The mp4 must be plain (ftyp, mdat, moov) H.264, as cua-driver's `record_video` writes it.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { WebSocketServer } = require("ws");

const args = process.argv.slice(2);
const flag = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const file = args.find((a) => !a.startsWith("--") && /\.(mp4|bin)$/.test(a));
const port = Number(flag("--port", 3299));
const fps = Number(flag("--fps", 30));
const token = flag("--token", "mock-token");
if (!file) throw new Error("pass an H.264 mp4, or a .bin of captured packets");

// A .bin is real packets captured from a cua-spacesd media socket, each behind a u32 length:
// they are replayed as they are, header and all.
const captured = [];
if (file.endsWith(".bin")) {
  const dump = readFileSync(file);
  for (let o = 0; o + 4 <= dump.length; ) {
    const length = dump.readUInt32BE(o);
    captured.push(dump.subarray(o + 4, o + 4 + length));
    o += 4 + length;
  }
}

// --- the recording, as Annex B access units ------------------------------------------------
const frames = captured.length ? [] : accessUnits(readFileSync(file));
function accessUnits(mp4) {
  const boxes = [];
  for (let o = 0; o + 8 <= mp4.length; ) {
    let size = mp4.readUInt32BE(o);
    let head = 8;
    if (size === 1) (size = Number(mp4.readBigUInt64BE(o + 8))), (head = 16);
    if (size === 0) size = mp4.length - o;
    boxes.push({ type: mp4.toString("latin1", o + 4, o + 8), at: o + head, end: o + size });
    o += size;
  }
  const mdat = boxes.find((b) => b.type === "mdat");
  const avcc = mp4.indexOf("avcC");
  if (!mdat || avcc < 0) throw new Error("not a plain H.264 mp4");
  const START = Buffer.from([0, 0, 0, 1]);
  // avcC: version, profile, compat, level, 0xFC|lengthSize-1, 0xE0|numSPS, then the sets.
  let p = avcc + 4 + 5;
  const sets = [];
  for (let n = mp4[p++] & 31; n > 0; n--) {
    const length = mp4.readUInt16BE(p);
    sets.push(START, mp4.subarray(p + 2, p + 2 + length));
    p += 2 + length;
  }
  for (let n = mp4[p++]; n > 0; n--) {
    const length = mp4.readUInt16BE(p);
    sets.push(START, mp4.subarray(p + 2, p + 2 + length));
    p += 2 + length;
  }
  const parameters = Buffer.concat(sets);
  const units = [];
  let pending = [];
  for (let o = mdat.at; o + 4 <= mdat.end; ) {
    const length = mp4.readUInt32BE(o);
    const nal = mp4.subarray(o + 4, o + 4 + length);
    o += 4 + length;
    const type = nal[0] & 31;
    pending.push(START, nal);
    if (type === 1 || type === 5) {
      const keyframe = type === 5;
      units.push({
        keyframe,
        data: Buffer.concat(keyframe ? [parameters, ...pending] : pending),
      });
      pending = [];
    }
  }
  if (!units.length || !units[0].keyframe) throw new Error("no keyframe at the start");
  return units;
}
// The frame size, read just far enough into the SPS for this fixture's purposes: the mock
// reports what the caller says, since the page takes its size from the decoded video.
const width = Number(flag("--width", 1800));
const height = Number(flag("--height", 1170));

// --- gRPC-Web: OpenMediaResponse{media_session_id=1, ticket=2, ws_path=4, codec=6} ----------
const field = (number, text) => {
  const value = Buffer.from(text);
  return Buffer.concat([Buffer.from([(number << 3) | 2, value.length]), value]);
};
const frame = (flagByte, payload) => {
  const head = Buffer.alloc(5);
  head[0] = flagByte;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
};
const tickets = new Set();
const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(204).end();
    return;
  }
  if (request.method === "POST" && request.url === "/cua.env.v1.StreamService/OpenMedia") {
    request.resume();
    request.on("end", () => {
      response.setHeader("content-type", "application/grpc-web+proto");
      if (request.headers.authorization !== `Bearer ${token}`) {
        response
          .writeHead(200)
          .end(frame(0x80, Buffer.from("grpc-status: 16\r\ngrpc-message: bad token\r\n")));
        return;
      }
      const ticket = Math.random().toString(36).slice(2);
      tickets.add(ticket);
      const message = Buffer.concat([
        field(1, "mock-session"),
        field(2, ticket),
        field(4, `/media?ticket=${ticket}`),
        Buffer.from([0x30, 0x01]),
      ]);
      response
        .writeHead(200)
        .end(Buffer.concat([frame(0, message), frame(0x80, Buffer.from("grpc-status: 0\r\n"))]));
    });
    return;
  }
  response.writeHead(404).end();
});

// --- the media socket ------------------------------------------------------------------------
const sockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, "http://mock");
  if (url.pathname !== "/media" || !tickets.has(url.searchParams.get("ticket"))) {
    socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }
  sockets.handleUpgrade(request, socket, head, (ws) => play(ws));
});
function play(ws) {
  ws.send(
    JSON.stringify({
      type: "hello",
      payload: { protocol: "rcdp", versions: [2], selected_version: 2, capabilities: ["desktop.v1"] },
    }),
  );
  ws.send(
    JSON.stringify({
      type: "session_opened",
      payload: { session_id: "mock-session", target: { kind: "display", display_id: "primary" } },
    }),
  );
  // Start on a keyframe, as the real daemon does on every attach.
  let index = 0;
  let sequence = 1000;
  const began = Date.now();
  const timer = setInterval(() => {
    if (captured.length) {
      ws.send(captured[index]);
      index = (index + 1) % captured.length;
      return;
    }
    const { keyframe, data } = frames[index];
    const header = Buffer.from(
      JSON.stringify({
        direction: "video",
        message: {
          session_id: "mock-session",
          sequence: sequence++,
          geometry_epoch: 1,
          codec_epoch: 1,
          width_px: width,
          height_px: height,
          capture_timestamp_us: (Date.now() - began) * 1000,
          codec: "h264",
          keyframe,
        },
      }),
    );
    const lengths = Buffer.alloc(8);
    lengths.writeUInt32BE(header.length, 0);
    lengths.writeUInt32BE(data.length, 4);
    ws.send(Buffer.concat([lengths, header, data]));
    index = (index + 1) % frames.length;
  }, 1000 / fps);
  ws.on("close", () => clearInterval(timer));
}

server.listen(port, "127.0.0.1", () =>
  console.log(
    `spacesd mock on 127.0.0.1:${port}: ${captured.length || frames.length} ${captured.length ? "captured packets" : "frames"} at ${fps} fps, token ${token}`,
  ),
);
