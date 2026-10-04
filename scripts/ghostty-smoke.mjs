// Feed a real Hub PTY into the packaged Ghostty WASM engine. No browser required.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ghostty } from "../web/node_modules/ghostty-web/dist/ghostty-web.js";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const data = await mkdtemp(join(tmpdir(), "hub-ghostty-"));
const server = spawn(join(root, "target/debug/hub-server"), [], {
  cwd: root,
  // Background services and SSH hosts may have no UTF-8 locale configured.
  env: { ...process.env, LANG: "C", LC_ALL: "C", LC_CTYPE: "C", HUB_PORT: "4322", HUB_DISCOVERY: "off", HUB_DATA_DIR: data, HUB_TOKEN: "" },
  stdio: "ignore",
});
const exited = new Promise((resolve) => server.on("exit", resolve));
const base = "http://127.0.0.1:4322/api";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(path, payload) {
  const r = await fetch(base + path, {
    method: payload === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  assert.ok(r.ok, await r.clone().text());
  return r.json();
}
let session, socket, observer, latest, terminal;
try {
  for (let attempt = 0; ; attempt++) {
    try {
      await api("/state");
      break;
    } catch (error) {
      if (attempt >= 60 || server.exitCode !== null) throw error;
      await delay(100);
    }
  }
  const wasm = await readFile(
    join(root, "web/node_modules/ghostty-web/ghostty-vt.wasm"),
  );
  const engine = await Ghostty.load(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
  terminal = engine.createTerminal(100, 28);
  session = await api("/sessions", { name: "Ghostty compatibility check" });
  await api(`/sessions/${session.id}/control`, { owner: "user" });
  socket = new WebSocket(
    `ws://127.0.0.1:4322/api/sessions/${session.id}/stream`,
  );
  socket.binaryType = "arraybuffer";
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  socket.onmessage = (e) => {
    if (typeof e.data === "string" && e.data.startsWith('{')) {
      const message = JSON.parse(e.data);
      if (message.type === "geometry") {
        terminal.resize(message.cols, message.rows);
        return;
      }
    }
    terminal.write(
      typeof e.data === "string" ? e.data : new Uint8Array(e.data),
    );
    const reply = terminal.readResponse();
    if (reply) socket.send(JSON.stringify({ type: "input", data: reply }));
  };
  socket.send(JSON.stringify({ type: "resize", cols: 100, rows: 28 }));
  socket.send(
    JSON.stringify({
      type: "input",
      data: "printf '\\033[32mGHOSTTY_%s\\342\\234\\223\\033[0m\\n' LIVE\n",
    }),
  );
  let screen = "";
  for (let attempt = 0; attempt < 100; attempt++) {
    terminal.update();
    screen = terminal
      .getViewport()
      .map((c) => String.fromCodePoint(c.codepoint || 32))
      .join("");
    if (screen.includes("GHOSTTY_LIVE✓")) break;
    await delay(100);
  }
  assert.ok(
    screen.includes("GHOSTTY_LIVE✓"),
    "Ghostty did not decode the live UTF-8 PTY output",
  );
  console.log(
    "PASS: packaged Ghostty WASM decoded ANSI and UTF-8 from a real Hub terminal",
  );
  const paneSize = () => execFileSync('tmux', ['-L', 'gofer', 'display-message', '-p', '-t', `hub_${session.id}`, '#{pane_width}x#{pane_height}'], {encoding:'utf8'}).trim();
  const observerSizes = [];
  observer = new WebSocket(`ws://127.0.0.1:4322/api/sessions/${session.id}/stream`);
  observer.onmessage = (e) => {
    if (typeof e.data === 'string' && e.data.startsWith('{')) {
      const message = JSON.parse(e.data);
      if (message.type === 'geometry') observerSizes.push(`${message.cols}x${message.rows}`);
    }
  };
  await new Promise((resolve,reject) => { observer.onopen=resolve; observer.onerror=reject; });
  observer.send(JSON.stringify({type:'resize',cols:42,rows:20,active:false}));
  await delay(250);
  assert.equal(paneSize(), '100x28', 'A passive second view changed the active terminal size');
  assert.ok(observerSizes.includes('100x28'), 'The passive view did not receive the authoritative grid');
  observer.send(JSON.stringify({type:'resize',cols:42,rows:20,active:true}));
  for (let i=0; i<50 && paneSize()!=='42x20'; i++) await delay(20);
  assert.equal(paneSize(), '42x20', 'The focused view could not take over sizing');
  for (let i=0; i<50 && terminal.cols!==42; i++) await delay(20);
  assert.equal(terminal.cols, 42, 'The other view did not adopt the shared grid');
  // The old viewer still measures its container, but must not win it back.
  socket.send(JSON.stringify({type:'resize',cols:110,rows:30,active:false}));
  await delay(150);
  assert.equal(paneSize(), '42x20', 'An older viewer reclaimed sizing on a layout update');
  latest = new WebSocket(`ws://127.0.0.1:4322/api/sessions/${session.id}/stream`);
  await new Promise((resolve,reject) => { latest.onopen=resolve; latest.onerror=reject; });
  latest.send(JSON.stringify({type:'resize',cols:80,rows:25,active:true}));
  for (let i=0; i<50 && paneSize()!=='80x25'; i++) await delay(20);
  assert.equal(paneSize(), '80x25', 'The most recent viewer did not set the terminal size');
  latest.close();
  for (let i=0; i<50 && paneSize()!=='42x20'; i++) await delay(20);
  assert.equal(paneSize(), '42x20', 'Closing the newest viewer must restore the previous viewer, not the largest');
  observer.close();
  for (let i=0; i<50 && paneSize()!=='110x30'; i++) await delay(20);
  assert.equal(paneSize(), '110x30', 'Closing the sizing view did not restore the remaining view');
  console.log('PASS: newest viewer sets geometry; older layout updates cannot steal it; disconnect restores the previous viewer');
} finally {
  latest?.close();
  observer?.close();
  socket?.close();
  terminal?.free();
  if (session) await api(`/sessions/${session.id}/close`, {}).catch(() => {});
  server.kill("SIGINT");
  const force = setTimeout(() => server.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(force);
  await rm(data, { recursive: true, force: true });
}
