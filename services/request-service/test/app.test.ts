import { describe, expect, it } from "vitest";
import request from "supertest";
import { MemoryStore } from "@emergency/shared";
import { createRequestApp } from "../src/app";

function setup() {
  const queued: string[] = [];
  const store = new MemoryStore();
  const app = createRequestApp({
    store,
    publishMatch: async (id) => {
      queued.push(id);
    },
  });
  return { app, queued };
}

describe("request service", () => {
  it("creates, retrieves, and queues a request", async () => {
    const { app, queued } = setup();
    const created = await request(app)
      .post("/requests")
      .send({ type: "water", location: "Zone A", details: "flood" })
      .expect(201);
    expect(created.body.status).toBe("PENDING");
    expect(queued).toEqual([created.body.id]);

    const fetched = await request(app).get(`/requests/${created.body.id}`).expect(200);
    expect(fetched.body.location).toBe("Zone A");
  });

  it("rejects an invalid request type with 400", async () => {
    const { app } = setup();
    await request(app).post("/requests").send({ type: "gold", location: "Zone A" }).expect(400);
  });

  it("returns 404 for an unknown request", async () => {
    const { app } = setup();
    await request(app).get("/requests/missing").expect(404);
  });

  it("registers a resource and lists it", async () => {
    const { app } = setup();
    await request(app).post("/resources").send({ type: "food", location: "Zone A" }).expect(201);
    const list = await request(app).get("/resources").expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].status).toBe("AVAILABLE");
  });

  it("returns 409 when matching a request that is no longer pending", async () => {
    const { app } = setup();
    const created = await request(app)
      .post("/requests")
      .send({ type: "food", location: "Zone A" })
      .expect(201);
    await request(app).put(`/requests/${created.body.id}/status`).send({ status: "ASSIGNED" }).expect(200);
    await request(app).post(`/match/${created.body.id}`).expect(409);
  });
});
