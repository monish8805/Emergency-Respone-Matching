import { describe, expect, it } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorageApp } from "../src/app";

const put = (app: ReturnType<typeof createStorageApp>["app"], key: string, body: unknown, version: number) =>
  request(app).put(`/internal/data/${key}`).set("x-version", String(version)).send(body as object);

describe("storage node", () => {
  it("stores and returns a value with its version", async () => {
    const { app } = createStorageApp("s0-primary", 0);
    await put(app, "request:1", { status: "PENDING" }, 5).expect(200);
    const res = await request(app).get("/internal/data/request:1").expect(200);
    expect(res.body).toEqual({ status: "PENDING" });
    expect(res.headers["x-version"]).toBe("5");
  });

  it("returns 404 for a missing key", async () => {
    const { app } = createStorageApp("s0-primary", 0);
    await request(app).get("/internal/data/nope").expect(404);
  });

  it("rejects writes without a version", async () => {
    const { app } = createStorageApp("s0-primary", 0);
    await request(app).put("/internal/data/a").send({ v: 1 }).expect(400);
  });

  it("ignores a write that is older than what it already holds", async () => {
    const { app } = createStorageApp("s0-primary", 0);
    await put(app, "a", { v: "new" }, 10).expect(200);
    const stale = await put(app, "a", { v: "old" }, 3).expect(200);
    expect(stale.body.applied).toBe(false);
    const res = await request(app).get("/internal/data/a");
    expect(res.body).toEqual({ v: "new" });
  });

  it("dumps all entries with versions for recovery sync", async () => {
    const { app } = createStorageApp("s0-primary", 0);
    await put(app, "a", { v: 1 }, 7);
    const res = await request(app).get("/internal/dump").expect(200);
    expect(res.body).toEqual([["a", { v: 1 }, 7]]);
  });

  it("keeps data across a restart when a data file is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "storage-"));
    try {
      const dataFile = join(dir, "node.json");
      const first = createStorageApp("n", 0, { dataFile });
      await put(first.app, "k", { v: 42 }, 9).expect(200);

      const second = createStorageApp("n", 0, { dataFile }); // simulates the process restarting
      const res = await request(second.app).get("/internal/data/k").expect(200);
      expect(res.body).toEqual({ v: 42 });
      expect(res.headers["x-version"]).toBe("9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
