import { describe, expect, it } from "vitest";
import request from "supertest";
import { createStorageApp } from "../src/app";

describe("storage node", () => {
  it("stores and returns a value", async () => {
    const { app } = createStorageApp("s0-primary", 0);
    await request(app).put("/internal/data/request:1").send({ status: "PENDING" }).expect(200);
    const res = await request(app).get("/internal/data/request:1").expect(200);
    expect(res.body).toEqual({ status: "PENDING" });
  });

  it("returns 404 for a missing key", async () => {
    const { app } = createStorageApp("s0-primary", 0);
    await request(app).get("/internal/data/nope").expect(404);
  });

  it("dumps all entries for recovery sync", async () => {
    const { app } = createStorageApp("s0-primary", 0);
    await request(app).put("/internal/data/a").send({ v: 1 });
    const res = await request(app).get("/internal/dump").expect(200);
    expect(res.body).toEqual([["a", { v: 1 }]]);
  });
});
