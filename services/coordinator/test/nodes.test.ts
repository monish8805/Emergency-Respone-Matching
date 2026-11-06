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
  it("marks a node down after its heartbeats stop", () => {
    const { registry, advance } = setup();
    advance(7000);
    expect(registry.checkTimeouts().sort()).toEqual(["a", "b"]);
    expect(registry.liveNodes(0)).toEqual([]);
  });

  it("reports recovery when a downed node sends a heartbeat again", () => {
    const { registry, advance } = setup();
    advance(7000);
    registry.checkTimeouts();
    expect(registry.heartbeat("a", "boot-1")).toEqual({ known: true, recovered: true });
    expect(registry.liveNodes(0).map((n) => n.id)).toEqual(["a"]);
  });

  it("reports recovery when a node restarts with a new bootId", () => {
    const { registry } = setup();
    registry.heartbeat("a", "boot-1");
    expect(registry.heartbeat("a", "boot-1").recovered).toBe(false);
    expect(registry.heartbeat("a", "boot-2").recovered).toBe(true);
  });
});
