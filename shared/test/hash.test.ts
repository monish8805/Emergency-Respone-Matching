import { describe, expect, it } from "vitest";
import { shardFor } from "../src/hash";

describe("shardFor", () => {
  it("is deterministic and stays within the shard range", () => {
    for (let i = 0; i < 100; i++) {
      const key = `request:${i}`;
      const shard = shardFor(key, 3);
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(3);
      expect(shardFor(key, 3)).toBe(shard);
    }
  });

  it("spreads keys across all three shards", () => {
    const counts = [0, 0, 0];
    for (let i = 0; i < 300; i++) counts[shardFor(`resource:${i}`, 3)]++;
    for (const count of counts) expect(count).toBeGreaterThan(50);
  });
});
