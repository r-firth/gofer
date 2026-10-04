import { describe, expect, it } from "vitest";
import type { MemoryNode } from "../memory-graph";
import { textOf } from "./MemoryPane";

const node = (over: Partial<MemoryNode>): MemoryNode => ({
  id: 1,
  label: "Event",
  kind: "tool.started",
  category: "tool",
  title: "Bash",
  scope: "thread",
  scope_name: "Thread",
  excerpt: "",
  vectors: 0,
  ...over,
});

// Excerpts copied from /api/memory/graph; the server cuts them mid-JSON.
describe("textOf", () => {
  it("reads the command back out of a tool payload", () => {
    const started = node({
      excerpt:
        '{"arguments":{"command":"uptime","description":"Show system uptime and load"},"item_id":"toolu_01NDf',
    });
    expect(textOf(started)).toBe("$ uptime");
    expect(textOf({ ...started, kind: "tool.result" })).toBe(
      "$ uptime · result",
    );
  });

  it("names strands and machines the way the thread does", () => {
    const read = node({
      title: "read agent",
      kind: "tool.result",
      excerpt:
        '{"arguments":{"chat_id":"21aefe60"},"name":"read_agent","result":{"ok":true,"result":{"chat":{"agent":{"device_id":"tailscale-n1234567890CNTRL"',
    });
    const names = (t: string) =>
      t.replace("tailscale-n1234567890CNTRL", "homeserver");
    expect(textOf(read, names)).toBe("read strand homeserver · result");
  });

  it("uses names for entities and runs, text for claims", () => {
    expect(
      textOf(
        node({ label: "Entity", category: "entity", title: "homeserver" }),
      ),
    ).toBe("homeserver");
    expect(
      textOf(
        node({
          label: "Scope",
          category: "scope",
          scope_name: "homeserver disk usage",
        }),
      ),
    ).toBe("homeserver disk usage");
    expect(
      textOf(
        node({
          label: "Claim",
          category: "claim",
          excerpt: "homeserver's /mnt/media was 96% full on 3 Oct",
        }),
      ),
    ).toBe("homeserver's /mnt/media was 96% full on 3 Oct");
  });
});
