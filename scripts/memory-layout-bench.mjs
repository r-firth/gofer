// Measure the actual layout solver without a browser or exposing record contents.
import { layoutGraph } from "../web/src/memory-graph.ts";
const base = process.argv[2] || "http://127.0.0.1:4318";
const scene = await (await fetch(base + "/api/memory/graph")).json();
const dense = {
  ...scene,
  nodes: Array.from({ length: 101 }, (_, id) => ({
    id,
    scope: "dense",
    label: id ? "Event" : "Scope",
  })),
  edges: Array.from({ length: 99 }, (_, i) => ({
    id: i,
    source: i + 1,
    target: i + 2,
    label: "NEXT",
  })),
};
for (const [name, graph] of [
  ["overview", scene],
  ["dense context", dense],
])
  for (const mode of ["network", "sequence"]) {
    const samples = [];
    for (let i = 0; i < 35; i++) {
      const start = performance.now();
      const points = layoutGraph(graph, mode);
      if (points.size !== graph.nodes.length)
        throw new Error("Incomplete layout");
      if (i >= 5) samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    console.log(
      `${name} / ${mode}: ${graph.nodes.length} nodes; p50 ${samples[15].toFixed(2)}ms, p95 ${samples[28].toFixed(2)}ms, max ${samples.at(-1).toFixed(2)}ms`,
    );
  }
