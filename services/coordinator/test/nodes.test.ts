import { describe, expect, it } from "vitest";
import { NodeRegistry } from "../src/nodes";

function setup() {
  let now = 0;
  const registry = new NodeRegistry(
    [
      { id: "a", shard: 0, url: "http://a" },
      { id: "b", shard: 0, url: "http://b" },
    ],
    6000,
    () => now,
  );
  return { registry, advance: (ms: number) => (now += ms) };
}

describe("NodeRegistry", () => {
  it("does not trust any node until it has been synced", () => {
    const { registry } = setup();
    expect(registry.liveNodes(0)).toEqual([]);
    expect(registry.writeNodes(0).map((n) => n.id)).toEqual(["a", "b"]);
    expect(registry.heartbeat("a", "boot-1").recovered).toBe(true);
    expect(registry.markSynced("a", "boot-1")).toBe(true);
    expect(registry.liveNodes(0).map((n) => n.id)).toEqual(["a"]);
  });

  it("marks a node down after its heartbeats stop", () => {
    const { registry, advance } = setup();
    advance(7000);
    expect(registry.checkTimeouts().sort()).toEqual(["a", "b"]);
    expect(registry.liveNodes(0)).toEqual([]);
    expect(registry.writeNodes(0)).toEqual([]);
  });

  it("puts a downed node into syncing, not straight back to serving reads", () => {
    const { registry, advance } = setup();
    registry.heartbeat("a", "boot-1");
    registry.markSynced("a", "boot-1");
    advance(7000);
    registry.checkTimeouts();
    expect(registry.statusOf("a")).toBe("down");
    expect(registry.heartbeat("a", "boot-1")).toEqual({ known: true, recovered: true, status: "syncing" });
    expect(registry.liveNodes(0)).toEqual([]);
    expect(registry.writeNodes(0).map((n) => n.id)).toEqual(["a"]);
    registry.markSynced("a", "boot-1");
    expect(registry.liveNodes(0).map((n) => n.id)).toEqual(["a"]);
  });

  it("treats a new bootId as a restart that needs a resync", () => {
    const { registry } = setup();
    registry.heartbeat("a", "boot-1");
    registry.markSynced("a", "boot-1");
    expect(registry.heartbeat("a", "boot-1").recovered).toBe(false);
    expect(registry.heartbeat("a", "boot-2").recovered).toBe(true);
    expect(registry.statusOf("a")).toBe("syncing");
  });

  it("ignores a sync result that belongs to a previous incarnation", () => {
    const { registry } = setup();
    registry.heartbeat("a", "boot-1");
    registry.heartbeat("a", "boot-2"); // restarted while the old sync was running
    expect(registry.markSynced("a", "boot-1")).toBe(false);
    expect(registry.statusOf("a")).toBe("syncing");
    expect(registry.markSynced("a", "boot-2")).toBe(true);
  });

  it("lists shard peers that are not down", () => {
    const { registry } = setup();
    expect(registry.peersOf("a").map((n) => n.id)).toEqual(["b"]);
    registry.markDown("b");
    expect(registry.peersOf("a")).toEqual([]);
  });

  it("rejects heartbeats from unknown nodes", () => {
    const { registry } = setup();
    expect(registry.heartbeat("zzz")).toEqual({ known: false, recovered: false });
  });
});
