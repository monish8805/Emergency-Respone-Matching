import { describe, expect, it } from "vitest";
import { MemoryStore, UpdateConflictError, updateRecord } from "../src/store";

describe("MemoryStore versions and compare-and-set", () => {
  it("only applies a CAS at the expected version", async () => {
    const store = new MemoryStore();
    expect(await store.cas("k", null, { n: 1 })).toBe(true);
    expect(await store.cas("k", null, { n: 2 })).toBe(false);
    const { version } = (await store.getWithVersion("k"))!;
    expect(await store.cas("k", version, { n: 3 })).toBe(true);
    expect(await store.cas("k", version, { n: 4 })).toBe(false);
    expect(await store.get("k")).toEqual({ n: 3 });
  });

  it("changes the version on every write", async () => {
    const store = new MemoryStore();
    await store.put("k", 1);
    const a = (await store.getWithVersion("k"))!.version;
    await store.put("k", 2);
    expect((await store.getWithVersion("k"))!.version).toBeGreaterThan(a);
  });
});

describe("updateRecord", () => {
  it("applies every concurrent increment exactly once", async () => {
    const store = new MemoryStore();
    await store.put("counter", { n: 0 });
    await Promise.all(Array.from({ length: 25 }, () => updateRecord<{ n: number }>(store, "counter", (c) => ({ n: c.n + 1 }), 100)));
    expect(await store.get("counter")).toEqual({ n: 25 });
  });

  it("returns undefined for a missing key and skips the write when nothing changes", async () => {
    const store = new MemoryStore();
    expect(await updateRecord(store, "nope", (x) => x)).toBeUndefined();
    await store.put("k", { a: 1 });
    const before = (await store.getWithVersion("k"))!.version;
    await updateRecord<{ a: number }>(store, "k", (x) => x);
    expect((await store.getWithVersion("k"))!.version).toBe(before);
  });

  it("gives up with a clear error when it cannot win", async () => {
    const store = new MemoryStore();
    await store.put("k", { a: 1 });
    const hostile = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "cas") return async () => false;
        return Reflect.get(target, prop, receiver);
      },
    });
    await expect(updateRecord(hostile, "k", (x: object) => ({ ...x }), 3)).rejects.toThrow(UpdateConflictError);
  });
});
