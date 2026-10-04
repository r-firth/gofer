export type MemoryNode = {
  id: number;
  label: string;
  kind: string;
  category: string;
  title: string;
  scope: string;
  scope_name: string;
  excerpt: string;
  vectors: number;
  time?: string;
  run_id?: number;
  score?: number;
};
export type MemoryEdge = {
  id: number;
  source: number;
  target: number;
  label: string;
};
export type MemoryScene = {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  focus?: number;
  next_offset: number | null;
  stats: { nodes: number; edges: number; vectors: number; runs: number };
  elapsed_ms: number;
};
export type Point = { x: number; y: number };
export type Camera = Point & { scale: number };
export type LayoutMode = "network" | "sequence";

/** Stable topology-aware layout, evaluated in the graph's worker. */
export function layoutGraph(
  scene: MemoryScene,
  mode: LayoutMode = "network",
): Map<number, Point> {
  const groups = new Map<string, MemoryNode[]>();
  for (const n of [...scene.nodes].sort((a, b) => a.id - b.id)) {
    const group = groups.get(n.scope);
    if (group) group.push(n);
    else groups.set(n.scope, [n]);
  }
  const edges = [...scene.edges].sort((a, b) => a.id - b.id);
  const boxes = [...groups.values()]
    .map((nodes) => {
      const events = nodes.filter((n) => n.label !== "Scope");
      const ids = new Set(events.map((n) => n.id));
      const links = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
      const points =
        mode === "sequence" ? sequence(events, links) : network(events, links);
      const xs = [...points.values()].map((p) => p.x),
        ys = [...points.values()].map((p) => p.y);
      const minX = xs.length ? Math.min(...xs) : 0,
        maxX = xs.length ? Math.max(...xs) : 0;
      const minY = ys.length ? Math.min(...ys) : 0,
        maxY = ys.length ? Math.max(...ys) : 0;
      // The actual context node is the head of its neighborhood, outside the event field.
      for (const n of nodes.filter((n) => n.label === "Scope"))
        points.set(n.id, { x: (minX + maxX) / 2, y: minY - 58 });
      return {
        id: nodes[0].id,
        points,
        minX,
        minY: minY - 58,
        width: Math.max(175, maxX - minX + 64),
        height: Math.max(140, maxY - minY + 125),
      };
    })
    .sort((a, b) => b.height - a.height || a.id - b.id);
  // Variable-size shelf packing prevents dense contexts colliding with small ones.
  const area = boxes.reduce(
    (sum, b) => sum + (b.width + 45) * (b.height + 35),
    0,
  );
  const targetWidth = Math.max(
    ...boxes.map((b) => b.width),
    Math.sqrt(area * 2),
  );
  const positions = new Map<number, Point>();
  let x = 0,
    y = 0,
    rowHeight = 0;
  for (const box of boxes) {
    if (x && x + box.width > targetWidth) {
      x = 0;
      y += rowHeight + 38;
      rowHeight = 0;
    }
    for (const [id, p] of box.points)
      positions.set(id, {
        x: x + 32 + p.x - box.minX,
        y: y + 25 + p.y - box.minY,
      });
    x += box.width + 45;
    rowHeight = Math.max(rowHeight, box.height);
  }
  return positions;
}
function sequence(
  nodes: MemoryNode[],
  edges: MemoryEdge[],
): Map<number, Point> {
  const remaining = new Set(nodes.map((n) => n.id)),
    out = new Map<number, number[]>(),
    incoming = new Set<number>();
  for (const e of edges.filter((e) => e.label === "NEXT")) {
    out.set(e.source, [...(out.get(e.source) || []), e.target]);
    incoming.add(e.target);
  }
  const ordered: number[] = [];
  const visit = (start: number) => {
    const queue = [start];
    while (queue.length) {
      const id = queue.shift()!;
      if (!remaining.delete(id)) continue;
      ordered.push(id);
      queue.unshift(...(out.get(id) || []));
    }
  };
  for (const n of nodes) if (!incoming.has(n.id)) visit(n.id);
  for (const n of nodes) visit(n.id); // Includes disconnected records and malformed cycles once.
  const columns = Math.min(
    8,
    Math.max(3, Math.ceil(Math.sqrt(nodes.length * 1.8))),
  );
  return new Map(
    ordered.map((id, i) => {
      const row = Math.floor(i / columns),
        col = i % columns;
      return [id, { x: (row % 2 ? columns - 1 - col : col) * 66, y: row * 62 }];
    }),
  );
}
function network(nodes: MemoryNode[], edges: MemoryEdge[]): Map<number, Point> {
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const p = nodes.map((n, i) => ({
    x: Math.cos(i * 2.399963) * Math.sqrt(i + 1) * 24,
    y: Math.sin(i * 2.399963) * Math.sqrt(i + 1) * 24,
    vx: 0,
    vy: 0,
  }));
  const springs = edges.map((e) => ({
    a: index.get(e.source)!,
    b: index.get(e.target)!,
    weight: e.label === "NEXT" ? 0.11 : 0.035,
  }));
  // Bounded static solve. The display interpolates the answer; physics never runs at idle.
  for (let step = 0; step < 180; step++) {
    const heat = 1 - step / 210;
    const forces = p.map((v) => ({ x: -v.x * 0.012, y: -v.y * 0.012 }));
    for (let i = 0; i < p.length; i++)
      for (let j = i + 1; j < p.length; j++) {
        const dx = p[j].x - p[i].x,
          dy = p[j].y - p[i].y,
          d = Math.max(0.01, Math.hypot(dx, dy));
        const force = 510 / (d * d) + Math.max(0, 25 - d) * 0.6;
        forces[i].x -= (dx / d) * force;
        forces[i].y -= (dy / d) * force;
        forces[j].x += (dx / d) * force;
        forces[j].y += (dy / d) * force;
      }
    for (const { a, b, weight } of springs) {
      if (a === b) continue;
      const dx = p[b].x - p[a].x,
        dy = p[b].y - p[a].y,
        d = Math.max(0.01, Math.hypot(dx, dy));
      const force = (d - 44) * weight;
      forces[a].x += (dx / d) * force;
      forces[a].y += (dy / d) * force;
      forces[b].x -= (dx / d) * force;
      forces[b].y -= (dy / d) * force;
    }
    p.forEach((v, i) => {
      v.vx = (v.vx + forces[i].x * heat) * 0.64;
      v.vy = (v.vy + forces[i].y * heat) * 0.64;
      v.x += Math.max(-9, Math.min(9, v.vx));
      v.y += Math.max(-9, Math.min(9, v.vy));
    });
  }
  // Orient the long axis horizontally to use a focused viewport well.
  const cx = p.reduce((sum, v) => sum + v.x, 0) / (p.length || 1),
    cy = p.reduce((sum, v) => sum + v.y, 0) / (p.length || 1);
  let xx = 0,
    yy = 0,
    xy = 0;
  for (const v of p) {
    const x = v.x - cx,
      y = v.y - cy;
    xx += x * x;
    yy += y * y;
    xy += x * y;
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy),
    cos = Math.cos(angle),
    sin = Math.sin(angle);
  return new Map(
    nodes.map((n, i) => {
      const x = p[i].x - cx,
        y = p[i].y - cy;
      return [n.id, { x: x * cos + y * sin, y: y * cos - x * sin }];
    }),
  );
}
export function zoomCamera(camera: Camera, at: Point, scale: number): Camera {
  const next = Math.min(6, Math.max(0.15, scale));
  return {
    scale: next,
    x: at.x - ((at.x - camera.x) * next) / camera.scale,
    y: at.y - ((at.y - camera.y) * next) / camera.scale,
  };
}
export const nodeColor = (kind: string) =>
  ({
    scope: "#d8c9ac",
    message: "#99bea9",
    tool: "#e7a36d",
    terminal: "#93adc4",
    system: "#898985",
  })[kind] || "#85817b";
