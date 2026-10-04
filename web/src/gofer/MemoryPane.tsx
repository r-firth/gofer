// What Gofer knows, as a graph: claims and the things they are about, the runs they came from and
// the steps that support them. One dot per record; the shape says what it is.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { MemoryEdge, MemoryNode, MemoryScene } from "../memory-graph";
import { Matrix } from "./matrix";

type Type = "ent" | "claim" | "sup" | "epi" | "evt";
type GNode = {
  id: number;
  type: Type;
  text: string;
  node: MemoryNode;
  t: number;
  deg: number;
  nx: number;
  ny: number;
  sx: number;
  sy: number;
  x: number;
  y: number;
  ox: number;
  oy: number;
  px: number;
  py: number;
  pr: number;
  placed?: boolean;
  lane?: number;
};
type GEdge = { a: GNode; b: GNode; type: string };
type Element = MemoryNode & {
  properties: Record<string, unknown>;
  vector: number[] | null;
  neighbors?: { id: number; node: number; label: string; direction: string }[];
  state?: string;
  evidence?: number[];
  about?: string[];
  source?: string;
};
type Search = {
  hits: MemoryNode[];
  total: number;
  semantic: boolean;
  semantic_pending?: boolean;
};

const KEEP = new Set(["scope", "message", "tool", "claim", "entity"]);
const LISTED = new Set([...KEEP, "terminal"]);
const typeOf = (n: MemoryNode): Type =>
  n.label === "Entity"
    ? "ent"
    : n.label === "Claim"
      ? (n as any).state === "active"
        ? "claim"
        : "sup"
      : n.label === "Scope"
        ? "epi"
        : "evt";
// Tool records are stored as their JSON payload; read the command or first argument back out of it.
const arg = (json: string, key: string) => {
  const m = json.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)`));
  return m ? m[1].replace(/\\n/g, " ").replace(/\\(.)/g, "$1") : undefined;
};
const TOOL_NAMES: Record<string, string> = {
  "read agent": "read strand",
  "start agent": "start strand",
  "steer agent": "steer strand",
};
type Rename = (text: string) => string;
const same: Rename = (text) => text;
export function textOf(n: MemoryNode, rename: Rename = same) {
  return rename(rawText(n));
}
function rawText(n: MemoryNode) {
  if (n.label === "Entity") return n.title;
  if (n.label === "Scope") return n.scope_name || n.title;
  if (n.category === "tool" && n.excerpt.startsWith("{")) {
    const what = arg(n.excerpt, "command");
    const line = what
      ? `$ ${what}`
      : `${TOOL_NAMES[n.title] ?? n.title} ${arg(n.excerpt, "path") ?? arg(n.excerpt, "file_path") ?? arg(n.excerpt, "prompt") ?? arg(n.excerpt, "device_id") ?? ""}`.trim();
    return n.kind === "tool.result" ? `${line} · result` : line;
  }
  return n.excerpt || n.title;
}
const NAMES: Record<Type, string> = {
  ent: "entity",
  claim: "claim",
  sup: "claim",
  epi: "run",
  evt: "event",
};
const FILTERS: [string, string][] = [
  ["all", "all"],
  ["claim", "claims"],
  ["message", "chat"],
  ["tool", "tools"],
];
const cut = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
const age = (iso?: string) => {
  if (!iso) return "";
  const d = (Date.now() - Date.parse(iso)) / 1000;
  return d < 90
    ? "now"
    : d < 5400
      ? `${Math.round(d / 60)} min`
      : d < 172800
        ? `${Math.round(d / 3600)} h`
        : `${Math.round(d / 86400)} d`;
};

function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const REST: Record<string, number> = {
  ABOUT: 70,
  SUPPORTED_BY: 44,
  SUPERSEDES: 60,
  HAS_EVENT: 34,
  NEXT: 21,
};
const CHARGE: Record<Type, number> = {
  ent: 66,
  claim: 27,
  sup: 22,
  epi: 30,
  evt: 12,
};

/** Network: a force layout from a fixed seed, so the same memory is the same picture every time. */
function network(nodes: GNode[], edges: GEdge[]) {
  const rand = rng(20261003);
  const seed = (n: GNode) => {
    let x = 0;
    let y = 0;
    let c = 0;
    for (const e of edges) {
      const o = e.a === n ? e.b : e.b === n ? e.a : undefined;
      if (o?.placed) {
        x += o.nx;
        y += o.ny;
        c++;
      }
    }
    n.nx = (c ? x / c : 0) + (rand() - 0.5) * 60;
    n.ny = (c ? y / c : 0) + (rand() - 0.5) * 60;
    n.placed = true;
  };
  const ents = nodes.filter((n) => n.type === "ent");
  ents.forEach((n, i) => {
    const a = Math.PI * 0.9 + (i / Math.max(1, ents.length)) * Math.PI * 2;
    n.nx = Math.cos(a) * 260;
    n.ny = Math.sin(a) * 150;
    n.placed = true;
  });
  for (const n of nodes) if (!n.placed) seed(n);
  const N = nodes.length;
  const iters = N > 220 ? 160 : 320;
  for (let it = 0; it < iters; it++) {
    const heat = 1 - it / iters;
    const f = nodes.map((n) => [-n.nx * 0.008, -n.ny * 0.03]);
    for (let i = 0; i < N; i++) {
      const p = nodes[i];
      for (let j = i + 1; j < N; j++) {
        const q = nodes[j];
        let dx = p.nx - q.nx;
        let dy = p.ny - q.ny;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = 0.5 + (i % 3);
          dy = 0.5 + (j % 2);
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const k = (CHARGE[p.type] * CHARGE[q.type]) / d2;
        f[i][0] += (dx / d) * k;
        f[i][1] += (dy / d) * k;
        f[j][0] -= (dx / d) * k;
        f[j][1] -= (dy / d) * k;
      }
    }
    const index = new Map(nodes.map((n, i) => [n, i]));
    for (const e of edges) {
      const dx = e.b.nx - e.a.nx;
      const dy = e.b.ny - e.a.ny;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const k = (d - (REST[e.type] ?? 40)) * 0.09;
      const a = index.get(e.a)!;
      const b = index.get(e.b)!;
      f[a][0] += (dx / d) * k;
      f[a][1] += (dy / d) * k;
      f[b][0] -= (dx / d) * k;
      f[b][1] -= (dy / d) * k;
    }
    const lim = 1.5 + 24 * heat;
    nodes.forEach((n, i) => {
      const m = Math.hypot(f[i][0], f[i][1]) || 1;
      const s = Math.min(lim, m) / m;
      n.nx += f[i][0] * s;
      n.ny += f[i][1] * s;
    });
  }
}

/** Sequence: time runs left to right, one lane per run. Claims hang under the step that supports them,
 * and the things they are about sit in a band underneath, below the claims that mention them. */
function sequence(nodes: GNode[], edges: GEdge[]) {
  const runs = nodes.filter((n) => n.type === "epi");
  const events = nodes
    .filter((n) => n.type === "evt")
    .sort((a, b) => a.t - b.t);
  const claims = nodes.filter((n) => n.type === "claim" || n.type === "sup");
  const firstTime = new Map<string, number>();
  for (const e of events)
    if (!firstTime.has(e.node.scope)) firstTime.set(e.node.scope, e.t);
  runs.sort(
    (a, b) =>
      (firstTime.get(a.node.scope) ?? 0) - (firstTime.get(b.node.scope) ?? 0),
  );
  let x = 0;
  let previous: number | undefined;
  for (const e of events) {
    if (previous !== undefined)
      x += 26 + (e.t - previous > 30 * 60_000 ? 40 : 0);
    e.sx = x;
    previous = e.t;
  }
  const support = new Map<GNode, GNode>();
  const hanging = new Map<GNode, number>();
  for (const c of claims) {
    const by = edges.find(
      (e) => e.a === c && e.type === "SUPPORTED_BY" && e.b.type === "evt",
    )?.b;
    if (!by) continue;
    support.set(c, by);
    hanging.set(by, (hanging.get(by) ?? 0) + 1);
  }
  // Each lane is as tall as the most claims hanging from one of its steps.
  let y = 0;
  const laneY = new Map<string, number>();
  for (const r of runs) {
    laneY.set(r.node.scope, y);
    const deepest = Math.max(
      0,
      ...events
        .filter((e) => e.node.scope === r.node.scope)
        .map((e) => hanging.get(e) ?? 0),
    );
    y += 40 + deepest * 17;
  }
  for (const e of events) e.sy = laneY.get(e.node.scope) ?? y;
  for (const r of runs) {
    const first = events.find((e) => e.node.scope === r.node.scope);
    r.sx = (first?.sx ?? 0) - 28;
    r.sy = laneY.get(r.node.scope) ?? 0;
  }
  const hung = new Map<GNode, number>();
  let loose = 0;
  for (const c of claims) {
    const by = support.get(c);
    if (by) {
      const j = (hung.get(by) ?? 0) + 1;
      hung.set(by, j);
      c.sx = by.sx;
      c.sy = by.sy + 17 * j;
    } else {
      c.sx = -60;
      c.sy = y + 17 * loose++;
    }
  }
  const band = y + 17 * loose + 40;
  const ents = nodes
    .filter((n) => n.type === "ent")
    .map((n) => {
      const about = edges
        .filter((e) => e.b === n && e.type === "ABOUT")
        .map((e) => e.a.sx);
      return {
        n,
        at: about.length ? about.reduce((a, b) => a + b, 0) / about.length : 0,
      };
    })
    .sort((a, b) => a.at - b.at);
  // Two rows so neighbouring names have room; each keeps its order along time.
  let last = [-1e9, -1e9];
  ents.forEach(({ n, at }, i) => {
    const row = i % 2;
    n.sx = Math.max(at, last[row] + 90);
    n.sy = band + row * 30;
    last[row] = n.sx;
  });
}

function buildGraph(scene: MemoryScene, rename: Rename) {
  const nodes: GNode[] = scene.nodes
    .filter((n) => KEEP.has(n.category))
    .map((node) => ({
      id: node.id,
      type: typeOf(node),
      text: textOf(node, rename),
      node,
      t: node.time ? Date.parse(node.time) : 0,
      deg: 0,
      nx: 0,
      ny: 0,
      sx: 0,
      sy: 0,
      x: 0,
      y: 0,
      ox: 0,
      oy: 0,
      px: 0,
      py: 0,
      pr: 0,
    }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: GEdge[] = [];
  for (const e of scene.edges as MemoryEdge[]) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    edges.push({ a, b, type: e.label });
    a.deg++;
    b.deg++;
  }
  // Runs with nothing left in view after dropping system records are noise.
  const live = nodes.filter((n) => n.type !== "epi" || n.deg > 0);
  const kept = new Set(live);
  const keptEdges = edges.filter((e) => kept.has(e.a) && kept.has(e.b));
  network(live, keptEdges);
  sequence(live, keptEdges);
  return {
    nodes: live,
    edges: keptEdges,
    byId: new Map(live.map((n) => [n.id, n])),
  };
}

const radius = (n: GNode) =>
  n.type === "ent"
    ? 5 + Math.min(n.deg, 12) * 0.42
    : n.type === "claim" || n.type === "sup"
      ? 3.4 + Math.min(n.deg, 5) * 0.3
      : n.type === "epi"
        ? 4
        : 2;

function useCanvas(
  graph: ReturnType<typeof buildGraph> | undefined,
  arrangement: "network" | "sequence",
  selected: number | undefined,
  trace: boolean,
  onSelect: (id?: number) => void,
) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef({
    view: { k: 1, x: 0, y: 0 },
    user: false,
    hover: undefined as GNode | undefined,
    w: 0,
    h: 0,
    dpr: 1,
    amount: 0,
    tween: undefined as { t0: number; from: number; to: number } | undefined,
    frame: 0,
  });
  const reduce = matchMedia("(prefers-reduced-motion:reduce)").matches;
  const props = useRef({ graph, arrangement, selected, trace });
  props.current = { graph, arrangement, selected, trace };

  useEffect(() => {
    const cv = canvas.current!;
    const ctx = cv.getContext("2d")!;
    const s = state.current;
    const css = getComputedStyle(document.documentElement);
    const rgb = (v: string) => {
      const n = parseInt(css.getPropertyValue(v).trim().slice(1), 16);
      return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
    };
    const P = {
      fg: rgb("--fg"),
      g1: rgb("--g1"),
      g2: rgb("--g2"),
      peach: rgb("--peach"),
      slab: rgb("--slab-solid"),
    };
    const rgba = (c: string, a: number) => `rgba(${c},${a})`;
    const LABEL = '500 11px "JetBrains Mono", ui-monospace, monospace';
    const EDGE = '400 10px "JetBrains Mono", ui-monospace, monospace';
    const ease = (p: number) =>
      p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    const rest = (n: GNode): [number, number] =>
      props.current.arrangement === "sequence"
        ? [n.sx, n.sy]
        : s.h > s.w * 1.15
          ? [n.ny, n.nx]
          : [n.nx, n.ny];
    const targets = () => {
      const g = props.current.graph;
      if (!g) return;
      for (const n of g.nodes) {
        n.ox = n.x;
        n.oy = n.y;
      }
      return g.nodes.map(rest);
    };
    const fit = () => {
      const g = props.current.graph;
      if (!g || !g.nodes.length || !s.w) return;
      const seq = props.current.arrangement === "sequence";
      let a = 1e9;
      let b = 1e9;
      let c = -1e9;
      let d = -1e9;
      for (const n of g.nodes) {
        const [x, y] = rest(n);
        a = Math.min(a, x);
        b = Math.min(b, y);
        c = Math.max(c, x);
        d = Math.max(d, y);
      }
      const pl = seq ? 112 : 60;
      const pr = seq ? 44 : 104;
      const k = Math.max(
        0.25,
        Math.min(
          1.5,
          (s.w - pl - pr) / Math.max(1, c - a),
          (s.h - 70) / Math.max(1, d - b),
        ),
      );
      s.view = {
        k,
        x: pl + (s.w - pl - pr - (c - a) * k) / 2 - a * k,
        y: 30 + (s.h - 70 - (d - b) * k) / 2 - b * k,
      };
    };
    const draw = (now: number) => {
      s.frame = 0;
      const g = props.current.graph;
      ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
      ctx.clearRect(0, 0, s.w, s.h);
      if (!g) return;
      let more = false;
      const seq = props.current.arrangement === "sequence";
      if (s.tween) {
        const p = reduce ? 1 : Math.min(1, (now - s.tween.t0) / 400);
        const e = ease(p);
        for (const n of g.nodes) {
          const [tx, ty] = rest(n);
          n.x = n.ox + (tx - n.ox) * e;
          n.y = n.oy + (ty - n.oy) * e;
        }
        s.amount = s.tween.from + (s.tween.to - s.tween.from) * e;
        if (p < 1) more = true;
        else s.tween = undefined;
      }
      const { k } = s.view;
      const zs = Math.max(0.85, Math.min(1.5, Math.sqrt(k)));
      const sel = g.byId.get(props.current.selected ?? -1);
      const hov = s.hover && s.hover !== sel ? s.hover : undefined;
      const near = new Set<GNode>();
      const hot: GEdge[] = [];
      for (const n of g.nodes) {
        n.px = n.x * k + s.view.x;
        n.py = n.y * k + s.view.y;
        n.pr = radius(n) * zs;
      }
      if (sel) {
        near.add(sel);
        for (const e of g.edges)
          if (e.a === sel || e.b === sel) {
            near.add(e.a);
            near.add(e.b);
            hot.push(e);
          }
      }
      ctx.lineWidth = 1;
      const seg = (e: GEdge, alpha: number) => {
        const A = e.a;
        const B = e.b;
        const dx = B.px - A.px;
        const dy = B.py - A.py;
        const d = Math.hypot(dx, dy);
        const ga = A.pr + 2.5;
        const gb = B.pr + 2.5;
        if (d < ga + gb + 2) return undefined;
        const ux = dx / d;
        const uy = dy / d;
        const out = [
          A.px + ux * ga,
          A.py + uy * ga,
          B.px - ux * gb,
          B.py - uy * gb,
          ux,
          uy,
        ];
        ctx.strokeStyle = rgba(P.fg, alpha);
        ctx.beginPath();
        ctx.moveTo(out[0], out[1]);
        ctx.lineTo(out[2], out[3]);
        ctx.stroke();
        return out;
      };
      for (const e of g.edges) {
        if (sel && (e.a === sel || e.b === sel)) continue;
        const alpha =
          e.type === "ABOUT"
            ? sel
              ? 0.04
              : 0.12
            : e.type === "HAS_EVENT"
              ? sel
                ? 0.03
                : 0.07
              : sel
                ? 0.06
                : 0.2;
        seg(e, alpha);
      }
      const segs = hot.map((e) => seg(e, 0.62));
      segs.forEach((g2) => {
        if (!g2) return;
        const [, , x, y, ux, uy] = g2;
        ctx.beginPath();
        ctx.moveTo(x - ux * 6 - uy * 3, y - uy * 6 + ux * 3);
        ctx.lineTo(x, y);
        ctx.lineTo(x - ux * 6 + uy * 3, y - uy * 6 - ux * 3);
        ctx.stroke();
      });
      const TAU = Math.PI * 2;
      for (const n of g.nodes) {
        const { px: x, py: y, pr: r } = n;
        ctx.globalAlpha = sel && !near.has(n) ? 0.3 : 1;
        if (n.type === "ent") {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, TAU);
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = rgba(P.fg, 0.95);
          ctx.stroke();
        } else if (n.type === "sup") {
          ctx.lineWidth = 1;
          ctx.strokeStyle = rgba(P.g2, 1);
          ctx.beginPath();
          ctx.arc(x, y, r, 0, TAU);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x - r - 3, y + r + 3);
          ctx.lineTo(x + r + 3, y - r - 3);
          ctx.stroke();
        } else if (n.type === "epi") {
          const q = Math.round(r);
          ctx.fillStyle = rgba(P.fg, 0.95);
          ctx.fillRect(Math.round(x) - q, Math.round(y) - q, 2 * q, 2 * q);
        } else {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, TAU);
          ctx.fillStyle =
            n.type === "evt" ? rgba(P.g1, 0.95) : rgba(P.fg, 0.95);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      if (hov) {
        ctx.beginPath();
        ctx.arc(hov.px, hov.py, hov.pr + 4, 0, TAU);
        ctx.lineWidth = 1;
        ctx.strokeStyle = rgba(P.fg, 0.5);
        ctx.stroke();
      }
      if (sel) {
        ctx.beginPath();
        ctx.arc(sel.px, sel.py, sel.pr + 4.5, 0, TAU);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = rgba(P.peach, 1);
        ctx.stroke();
      }
      if (props.current.trace && sel && !reduce) {
        segs.forEach((g2, i) => {
          if (!g2) return;
          const p = (now / 1600 + i * 0.17) % 1;
          ctx.beginPath();
          ctx.arc(
            g2[0] + (g2[2] - g2[0]) * p,
            g2[1] + (g2[3] - g2[1]) * p,
            2.25,
            0,
            TAU,
          );
          ctx.fillStyle = rgba(P.fg, 1);
          ctx.fill();
        });
        more = true;
      }
      // Labels: entities always, the selection and its neighbours, everything once zoomed in. No overlaps.
      const boxes: number[][] = [];
      const clash = (x: number, y: number, w: number, h: number) =>
        boxes.some(
          (b) =>
            x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1],
        );
      const want: [number, GNode][] = [];
      for (const n of g.nodes) {
        boxes.push([
          n.px - n.pr - 3,
          n.py - n.pr - 3,
          2 * n.pr + 6,
          2 * n.pr + 6,
        ]);
        const p =
          n === sel
            ? 0
            : n === hov
              ? 1
              : near.has(n)
                ? 2
                : n.type === "ent"
                  ? 3
                  : n.type === "claim"
                    ? 4
                    : n.type === "epi"
                      ? 5
                      : k >= 2.4
                        ? 6
                        : 9;
        if (p < 9) want.push([p, n]);
      }
      want.sort((a, b) => a[0] - b[0] || b[1].deg - a[1].deg);
      ctx.font = LABEL;
      ctx.textBaseline = "middle";
      for (const [p, n] of want) {
        const full = cut(
          n.text,
          n.type === "ent"
            ? Math.max(12, Math.floor((s.w - 24) / 6.8))
            : n.type === "epi"
              ? 34
              : 30,
        );
        const place = (text: string) => {
          const w = ctx.measureText(text).width;
          const gap = n.pr + 8;
          const spots = [
            [n.px + gap, n.py - 8],
            [n.px - gap - w, n.py - 8],
            [n.px - w / 2, n.py + n.pr + 6],
            [n.px - w / 2, n.py - n.pr - 22],
          ];
          const at = spots.find(
            (q) =>
              q[0] > 6 &&
              q[0] + w < s.w - 6 &&
              !clash(q[0] - 3, q[1], w + 6, 16),
          );
          return { text, w, at, first: spots[0] };
        };
        // Long names get a second, shorter try before giving up their label.
        let label = place(full);
        if (!label.at && full.length > 22) label = place(cut(full, 20));
        const { text, w, first } = label;
        let at = label.at;
        if (!at) {
          if (p > 1) continue;
          // The selection always gets its name, pulled back inside the edges.
          at = [Math.max(6, Math.min(s.w - w - 6, first[0])), first[1]];
        }
        boxes.push([at[0] - 3, at[1], w + 6, 16]);
        const far = sel && !near.has(n);
        ctx.fillStyle = rgba(P.slab, 0.86);
        ctx.fillRect(
          Math.round(at[0]) - 4,
          Math.round(at[1]),
          Math.ceil(w) + 8,
          16,
        );
        ctx.fillStyle =
          p < 2
            ? rgba(P.fg, 1)
            : n.type === "ent"
              ? rgba(P.fg, far ? 0.32 : 0.9)
              : rgba(P.g1, far ? 0.4 : 1);
        ctx.fillText(text, Math.round(at[0]), Math.round(at[1]) + 8.5);
      }
      if (sel) {
        ctx.font = EDGE;
        for (const e of hot) {
          const d = Math.hypot(e.b.px - e.a.px, e.b.py - e.a.py);
          if (d < 64) continue;
          const text = e.type.toLowerCase().replace("_", " ");
          const w = ctx.measureText(text).width;
          for (const f of [0.5, 0.36, 0.64]) {
            const x = e.a.px + (e.b.px - e.a.px) * f - w / 2;
            const y = e.a.py + (e.b.py - e.a.py) * f - 7;
            if (clash(x - 3, y, w + 6, 14)) continue;
            boxes.push([x - 3, y, w + 6, 14]);
            ctx.fillStyle = rgba(P.slab, 0.9);
            ctx.fillRect(
              Math.round(x) - 3,
              Math.round(y),
              Math.ceil(w) + 6,
              14,
            );
            ctx.fillStyle = rgba(P.g1, 0.95);
            ctx.fillText(text, Math.round(x), Math.round(y) + 7.5);
            break;
          }
        }
      }
      if (more) kick();
    };
    const kick = () => {
      if (!s.frame) s.frame = requestAnimationFrame(draw);
    };
    const size = () => {
      const r = cv.parentElement!.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      s.dpr = devicePixelRatio || 1;
      s.w = r.width;
      s.h = r.height;
      cv.width = Math.round(s.w * s.dpr);
      cv.height = Math.round(s.h * s.dpr);
      // Turning a phone can flip the network upright or back.
      if (!s.tween)
        for (const n of props.current.graph?.nodes ?? []) [n.x, n.y] = rest(n);
      if (!s.user) fit();
      kick();
    };
    const hit = (x: number, y: number) => {
      const g = props.current.graph;
      let best: GNode | undefined;
      let bd = 1e9;
      for (const n of g?.nodes ?? []) {
        const d = Math.hypot(n.px - x, n.py - y);
        if (d < Math.max(n.pr + 6, 11) && d < bd) {
          bd = d;
          best = n;
        }
      }
      return best;
    };
    const xy = (e: PointerEvent | WheelEvent) => {
      const r = cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    let drag:
      | { x: number; y: number; vx: number; vy: number; moved: boolean }
      | undefined;
    const down = (e: PointerEvent) => {
      const [x, y] = xy(e);
      cv.setPointerCapture(e.pointerId);
      drag = { x, y, vx: s.view.x, vy: s.view.y, moved: false };
    };
    const move = (e: PointerEvent) => {
      const [x, y] = xy(e);
      if (drag) {
        const dx = x - drag.x;
        const dy = y - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        drag.moved = true;
        cv.classList.add("drag");
        s.view = { k: s.view.k, x: drag.vx + dx, y: drag.vy + dy };
        s.user = true;
        kick();
        return;
      }
      const h = hit(x, y);
      if (h !== s.hover) {
        s.hover = h;
        cv.classList.toggle("pt", !!h);
        kick();
      }
    };
    const up = (e: PointerEvent) => {
      if (drag && !drag.moved && e.type === "pointerup") {
        const [x, y] = xy(e);
        onSelectRef.current(hit(x, y)?.id);
      }
      drag = undefined;
      cv.classList.remove("drag");
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const [x, y] = xy(e);
      zoom(Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0016)), x, y);
    };
    const zoom = (f: number, cx = s.w / 2, cy = s.h / 2) => {
      const k = Math.max(0.25, Math.min(4, s.view.k * f));
      const r = k / s.view.k;
      s.view = { k, x: cx - (cx - s.view.x) * r, y: cy - (cy - s.view.y) * r };
      s.user = true;
      kick();
    };
    controls.current = {
      fit: () => {
        s.user = false;
        fit();
        kick();
      },
      zoom,
      arrange: () => {
        const g = props.current.graph;
        if (!g) return;
        targets();
        s.tween = {
          t0: performance.now(),
          from: s.amount,
          to: props.current.arrangement === "sequence" ? 1 : 0,
        };
        s.user = false;
        fit();
        kick();
      },
      reset: () => {
        const g = props.current.graph;
        if (!g) return;
        for (const n of g.nodes) [n.x, n.y] = rest(n);
        if (!s.user) fit();
        kick();
      },
      kick,
    };
    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("wheel", wheel, { passive: false });
    const observer = new ResizeObserver(size);
    observer.observe(cv.parentElement!);
    return () => {
      observer.disconnect();
      cv.removeEventListener("pointerdown", down);
      cv.removeEventListener("pointermove", move);
      cv.removeEventListener("pointerup", up);
      cv.removeEventListener("pointercancel", up);
      cv.removeEventListener("wheel", wheel);
      cancelAnimationFrame(s.frame);
    };
  }, []);
  const controls = useRef<{
    fit: () => void;
    zoom: (f: number) => void;
    arrange: () => void;
    reset: () => void;
    kick: () => void;
  }>(undefined);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  useEffect(() => controls.current?.reset(), [graph]);
  useEffect(() => controls.current?.arrange(), [arrangement]);
  useEffect(() => controls.current?.kick(), [selected, trace]);
  return { canvas, controls };
}

function Embedding({ vector }: { vector: number[] }) {
  const values = vector.slice(0, 96);
  const sorted = values.map(Math.abs).sort((a, b) => a - b);
  const max = Math.max(sorted[Math.floor(sorted.length * 0.95)] ?? 0, 1e-6);
  return (
    <svg
      className="embs"
      width="191"
      height="31"
      viewBox="0 0 191 31"
      aria-hidden="true"
    >
      {values.map((v, i) => {
        const a = Math.min(1, Math.abs(v) / max);
        const h = Math.max(1, Math.round(a * 14));
        return (
          <rect
            key={i}
            x={i * 2}
            y={v > 0 ? 15 - h : 16}
            width="1"
            height={h}
            className={a < 0.34 ? "lo" : undefined}
          />
        );
      })}
    </svg>
  );
}

export function MemoryPane({
  embedding,
  devices,
  onShowInThread,
  onClose,
  focusNode,
}: {
  embedding: string;
  devices: { id: string; name: string }[];
  onShowInThread: (eventId: number, scope: string) => void;
  onClose: () => void;
  focusNode?: number;
}) {
  const client = useQueryClient();
  const [arrangement, setArrangement] = useState<"network" | "sequence">(
    "network",
  );
  const [trace, setTrace] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<number | undefined>(focusNode);
  const [around, setAround] = useState<number | undefined>(focusNode);
  const [tab, setTab] = useState<"search" | "graph" | "inspect">("graph");
  useEffect(() => {
    if (focusNode === undefined) return;
    setSelected(focusNode);
    setAround(focusNode);
  }, [focusNode]);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 160);
    return () => clearTimeout(timer);
  }, [query]);
  const scene = useQuery({
    queryKey: ["gofer-memory", "graph", around],
    queryFn: ({ signal }) =>
      api<MemoryScene>(
        `/memory/graph${around !== undefined ? `?node=${around}` : ""}`,
        undefined,
        signal,
      ),
    placeholderData: (previous) => previous,
    refetchInterval: 20_000,
  });
  const search = useQuery({
    queryKey: ["gofer-memory", "search", debounced, filter],
    queryFn: ({ signal }) =>
      api<Search>(
        `/memory/search?${new URLSearchParams({ q: debounced, kind: filter, mode: "hybrid", offset: "0" })}`,
        undefined,
        signal,
      ),
    refetchInterval: (q) => (q.state.data?.semantic_pending ? 500 : 20_000),
  });
  const element = useQuery({
    queryKey: ["gofer-memory", "element", selected],
    queryFn: ({ signal }) =>
      api<Element>(`/memory/element/node/${selected}`, undefined, signal),
    enabled: selected !== undefined,
  });
  // Machines are stored by tailnet id; show the names their owner knows them by.
  const rename = useMemo<Rename>(() => {
    const names = new Map(devices.map((d) => [d.id, d.name]));
    return (text) =>
      text.replace(/\btailscale-[A-Za-z0-9]+\b/g, (id) => names.get(id) ?? id);
  }, [devices]);
  const graph = useMemo(
    () => (scene.data ? buildGraph(scene.data, rename) : undefined),
    [scene.data, rename],
  );
  const { canvas, controls } = useCanvas(
    graph,
    arrangement,
    selected,
    trace,
    (id) => {
      setSelected(id);
    },
  );
  function choose(node: MemoryNode) {
    setSelected(node.id);
    if (!graph?.byId.has(node.id)) setAround(node.id);
    setTab("graph");
  }
  async function retract(e: Element, wrong: boolean) {
    await api(`/memory/claims/${e.id}/${wrong ? "wrong" : "restore"}`, {});
    client.invalidateQueries({ queryKey: ["gofer-memory"] });
  }
  const hits = (search.data?.hits ?? []).filter((h) => LISTED.has(h.category));
  const e = element.data;
  const titleOf = (id: number) => graph?.byId.get(id)?.text ?? `#${id}`;
  const stats = scene.data?.stats;
  const sourceEvent = e && (e.label === "Event" ? e.id : e.evidence?.[0]);
  return (
    <section id="stage" className="mm" aria-label="Memory">
      <div id="sbar">
        <button className="kbtn" type="button" onClick={onClose}>
          ‹ thread
        </button>
        <span className="sp" />
        <span id="mtabs">
          {(["search", "graph", "inspect"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`kbtn${tab === t ? " on" : ""}`}
              disabled={t === "inspect" && selected === undefined}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </span>
      </div>
      <div id="mem" data-tab={tab}>
        <div id="mg" className="slab">
          <header className="head" id="mhead">
            <Matrix text="memory" />
            <div className="lk">
              <b>
                {graph
                  ? `${graph.nodes.length} records · ${graph.edges.length} links`
                  : "reading memory"}
              </b>
              <span>
                {around !== undefined ? (
                  <button
                    type="button"
                    className="lnk"
                    onClick={() => setAround(undefined)}
                  >
                    near one record · show all
                  </button>
                ) : stats ? (
                  `of ${stats.nodes.toLocaleString()} records · ${stats.runs} runs`
                ) : (
                  ""
                )}
              </span>
            </div>
            <div id="mtools">
              <span id="marr" role="group" aria-label="Arrangement">
                <button
                  className="tog"
                  type="button"
                  aria-pressed={arrangement === "network"}
                  onClick={() => setArrangement("network")}
                >
                  network
                </button>
                <button
                  className="tog"
                  type="button"
                  aria-pressed={arrangement === "sequence"}
                  onClick={() => setArrangement("sequence")}
                >
                  sequence
                </button>
              </span>
              <button
                className="tog"
                type="button"
                aria-pressed={trace}
                onClick={() => setTrace((t) => !t)}
              >
                <i className="d" />
                trace
              </button>
            </div>
          </header>
          <div id="mwrap">
            <canvas
              id="mcv"
              ref={canvas}
              tabIndex={0}
              aria-label="Memory graph. Drag to pan, scroll to zoom, click a record to select it."
            />
            <div id="mzoom">
              <button
                className="key"
                type="button"
                aria-label="Zoom out"
                onClick={() => controls.current?.zoom(1 / 1.3)}
              >
                <kbd>-</kbd>
              </button>
              <button
                className="key"
                type="button"
                aria-label="Zoom in"
                onClick={() => controls.current?.zoom(1.3)}
              >
                <kbd>+</kbd>
              </button>
              <button
                className="key"
                type="button"
                onClick={() => controls.current?.fit()}
              >
                <kbd>f</kbd>fit
              </button>
            </div>
          </div>
          {e && (
            <button id="mpeek" type="button" onClick={() => setTab("inspect")}>
              <i className={`gl ${typeOf(e)}`} />
              <span>{String(e.properties?.text ?? textOf(e, rename))}</span>
              <em>read ›</em>
            </button>
          )}
        </div>
        <div id="ms" className="slab">
          <form id="mq" onSubmit={(ev) => ev.preventDefault()}>
            <span className="ps" aria-hidden="true">
              ›
            </span>
            <input
              id="mq-in"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="search memory"
              aria-label="Search memory"
              value={query}
              onChange={(ev) => setQuery(ev.target.value)}
            />
          </form>
          <div id="mfil" role="group" aria-label="Record type">
            {FILTERS.map(([f, label]) => (
              <button
                key={f}
                type="button"
                className="mfb"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {f === "claim" && <i className="gl claim" />}
                {f === "message" && <i className="gl evt" />}
                {f === "tool" && <i className="gl evt" />}
                {label}
              </button>
            ))}
          </div>
          <div id="mres" role="listbox" aria-label="Records">
            {hits.map((h) => {
              const t = typeOf(h);
              return (
                <button
                  key={h.id}
                  type="button"
                  role="option"
                  aria-selected={selected === h.id}
                  className={`mr${selected === h.id ? " sel" : ""}`}
                  onClick={() => choose(h)}
                >
                  <i className={`gl ${t}`} />
                  <span className="mrt">{textOf(h, rename)}</span>
                  <small>
                    {[
                      h.label === "Claim" ? (h as any).source : h.scope_name,
                      age(h.time),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </button>
              );
            })}
            {!hits.length && (
              <p className="ie">
                {search.isFetching
                  ? "Searching…"
                  : "Nothing in memory matches that."}
              </p>
            )}
          </div>
        </div>
        <div id="mi" className="slab">
          <div id="minsp">
            {!e ? (
              <p className="ie">
                Pick a record in the list or on the graph to read it here.
              </p>
            ) : (
              <>
                <div className="ih">
                  <i className={`gl ${typeOf(e)}`} />
                  <span>
                    {NAMES[typeOf(e)]} · {e.id}
                  </span>
                  <span className="sp" />
                  {e.label === "Claim" && e.state !== "superseded" && (
                    <button
                      type="button"
                      className="kbtn"
                      onClick={() => retract(e, e.state !== "retracted")}
                    >
                      {e.state === "retracted" ? "undo" : "wrong"}
                    </button>
                  )}
                  {sourceEvent !== undefined && e.scope && (
                    <button
                      type="button"
                      className="kbtn"
                      onClick={() => onShowInThread(sourceEvent, e.scope)}
                    >
                      show in thread
                    </button>
                  )}
                </div>
                <p
                  className={`itx${e.state && e.state !== "active" ? " sup" : ""}`}
                >
                  {String(e.properties?.text ?? textOf(e, rename))}
                </p>
                <dl className="kv">
                  {e.state && (
                    <>
                      <dt>status</dt>
                      <dd>
                        {e.state === "retracted"
                          ? "marked wrong by you"
                          : e.state}
                      </dd>
                    </>
                  )}
                  {(e.source || e.scope_name) && (
                    <>
                      <dt>source</dt>
                      <dd>
                        {e.source || e.scope_name}
                        {e.time
                          ? ` · ${age(e.time) === "now" ? "just now" : `${age(e.time)} ago`}`
                          : ""}
                      </dd>
                    </>
                  )}
                  {e.vector && (
                    <>
                      <dt>embedding</dt>
                      <dd className="emb">
                        <Embedding vector={e.vector} />
                        <small>
                          {embedding} · {e.vector.length} dims
                        </small>
                      </dd>
                    </>
                  )}
                  {Object.entries(
                    (e.neighbors ?? []).reduce<
                      Record<string, { node: number }[]>
                    >((groups, n) => {
                      const key = `${n.direction === "in" ? "← " : "→ "}${n.label.toLowerCase().replace("_", " ")}`;
                      (groups[key] ??= []).push(n);
                      return groups;
                    }, {}),
                  ).map(([key, rows]) => (
                    <div key={key} style={{ display: "contents" }}>
                      <dt>{key}</dt>
                      <dd>
                        {rows.slice(0, 30).map((r) => (
                          <button
                            key={r.node}
                            type="button"
                            className="rel"
                            onClick={() => setSelected(r.node)}
                          >
                            <i
                              className={`gl ${graph?.byId.get(r.node)?.type ?? "evt"}`}
                            />
                            <span>{titleOf(r.node)}</span>
                          </button>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
