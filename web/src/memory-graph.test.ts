import { expect, it } from "vitest";
import { layoutGraph, zoomCamera, type MemoryScene } from "./memory-graph";
it("preserves the world point under the pointer when zooming, including clamps", () => {
  const camera = { x: 100, y: 50, scale: 2 },
    at = { x: 220, y: 160 };
  for (const scale of [4, 0.01, 100]) {
    const next = zoomCamera(camera, at, scale);
    expect((at.x - next.x) / next.scale).toBe(60);
    expect((at.y - next.y) / next.scale).toBe(55);
    expect(next.scale).toBeGreaterThanOrEqual(0.15);
    expect(next.scale).toBeLessThanOrEqual(6);
  }
});
it("lays out disconnected and densely connected records without mutating graph truth", () => {
  const nodes = Array.from({ length: 152 }, (_, id) => ({
    id,
    label: id % 76 === 0 ? "Scope" : "Event",
    scope: String(Math.floor(id / 76)),
  }));
  const scene = {
    nodes,
    edges: [{ id: 1, source: 0, target: 1, label: "HAS_EVENT" }],
  } as MemoryScene;
  const before = JSON.stringify(scene),
    p = layoutGraph(scene);
  expect(p.size).toBe(152);
  expect(
    [...p.values()].every((v) => Number.isFinite(v.x) && Number.isFinite(v.y)),
  ).toBe(true);
  expect(p).toEqual(layoutGraph(scene));
  expect(JSON.stringify(scene)).toBe(before);
});

function sceneOf(
  nodes: { id: number; scope: string; label?: string }[],
  edges: MemoryScene["edges"],
): MemoryScene {
  return {
    nodes: nodes.map((n) => ({
      label: "Event",
      title: n.scope,
      scope_name: n.scope,
      kind: "message.assistant",
      category: "message",
      excerpt: "",
      vectors: 0,
      ...n,
    })),
    edges,
    stats: { nodes: nodes.length, edges: edges.length, vectors: 0, runs: 0 },
    next_offset: null,
    elapsed_ms: 0,
  };
}
it("uses graph relationships to arrange records rather than their array order", () => {
  const nodes = Array.from({ length: 12 }, (_, id) => ({ id, scope: "a" }));
  const chain = nodes
    .slice(1)
    .map((n, i) => ({ id: i, source: i, target: n.id, label: "NEXT" }));
  const linked = sceneOf(nodes, chain),
    disconnected = sceneOf(nodes, []);
  expect(layoutGraph(linked)).not.toEqual(layoutGraph(disconnected));
  expect(layoutGraph(linked)).toEqual(
    layoutGraph({
      ...linked,
      nodes: [...linked.nodes].reverse(),
      edges: [...chain].reverse(),
    }),
  );
  const p = layoutGraph(linked);
  for (const [id, a] of p)
    for (const [other, b] of p)
      if (id !== other)
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(19);
});
it("sequence follows directed NEXT order even when node IDs are not chronological", () => {
  const s = sceneOf(
    [
      { id: 10, scope: "a" },
      { id: 3, scope: "a" },
      { id: 8, scope: "a" },
    ],
    [
      { id: 0, source: 10, target: 3, label: "NEXT" },
      { id: 1, source: 3, target: 8, label: "NEXT" },
    ],
  );
  const p = layoutGraph(s, "sequence");
  expect(p.get(10)!.y).toBe(p.get(3)!.y);
  expect(p.get(3)!.y).toBe(p.get(8)!.y);
  expect(p.get(10)!.x).toBeLessThan(p.get(3)!.x);
  expect(p.get(3)!.x).toBeLessThan(p.get(8)!.x);
});
it("keeps different contexts separated even with very unequal event counts", () => {
  const s = sceneOf(
    [
      ...Array.from({ length: 100 }, (_, id) => ({ id, scope: "large" })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: 200 + i, scope: "small" })),
    ],
    [],
  );
  const p = layoutGraph(s),
    a = s.nodes.filter((n) => n.scope === "large").map((n) => p.get(n.id)!),
    b = s.nodes.filter((n) => n.scope === "small").map((n) => p.get(n.id)!);
  for (const x of a)
    for (const y of b)
      expect(Math.hypot(x.x - y.x, x.y - y.y)).toBeGreaterThan(45);
});
