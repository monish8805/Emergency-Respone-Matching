import { describe, expect, it } from "vitest";
import request from "supertest";
import { MemoryStore, requestKey, resourceKey, type Resource } from "@emergency/shared";
import { createRequestApp } from "../src/app";

function setup(options: { publishFails?: boolean } = {}) {
  const queued: string[] = [];
  const store = new MemoryStore();
  const app = createRequestApp({
    store,
    publishMatch: async (id) => {
      if (options.publishFails) throw new Error("rabbit down");
      queued.push(id);
    },
    checkRabbit: async () => !options.publishFails,
    coordinatorHealth: async () => ({ ok: true, nodes: [], shards: [] }),
  });
  return { app, queued, store };
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

  it("lists requests newest first", async () => {
    const { app } = setup();
    const first = await request(app).post("/requests").send({ type: "water", location: "A" }).expect(201);
    await new Promise((r) => setTimeout(r, 5));
    const second = await request(app).post("/requests").send({ type: "food", location: "B" }).expect(201);
    const list = await request(app).get("/requests").expect(200);
    expect(list.body.map((r: { id: string }) => r.id)).toEqual([second.body.id, first.body.id]);
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

  it("still stores the request when RabbitMQ is down and flags it as not queued", async () => {
    const { app, queued } = setup({ publishFails: true });
    const created = await request(app).post("/requests").send({ type: "water", location: "A" }).expect(201);
    expect(created.headers["x-match-queued"]).toBe("false");
    expect(queued).toEqual([]);
    const fetched = await request(app).get(`/requests/${created.body.id}`).expect(200);
    expect(fetched.body.status).toBe("PENDING"); // the matching sweeper will pick it up
  });

  it("returns 503 when a manual match cannot be queued", async () => {
    const { app } = setup({ publishFails: true });
    const created = await request(app).post("/requests").send({ type: "water", location: "A" }).expect(201);
    await request(app).post(`/match/${created.body.id}`).expect(503);
  });

  it("accepts all five resource types and rejects anything else", async () => {
    const { app } = setup();
    for (const type of ["water", "food", "medicine", "transportation", "shelter"]) {
      await request(app).post("/resources").send({ type, location: "Z" }).expect(201);
    }
    await request(app).post("/resources").send({ type: "gold", location: "Z" }).expect(400);
    await request(app).post("/resources").send({ type: "water" }).expect(400);
    await request(app).post("/requests").send({ type: "water", location: "   " }).expect(400);
  });

  it("registers an unavailable resource", async () => {
    const { app } = setup();
    const res = await request(app).post("/resources").send({ type: "food", location: "Z", availability: false }).expect(201);
    expect(res.body.status).toBe("UNAVAILABLE");
  });

  it("updates request and resource statuses and validates them", async () => {
    const { app } = setup();
    const req = await request(app).post("/requests").send({ type: "food", location: "A" }).expect(201);
    const upd = await request(app).put(`/requests/${req.body.id}/status`).send({ status: "IN_PROGRESS" }).expect(200);
    expect(upd.body.status).toBe("IN_PROGRESS");
    await request(app).put(`/requests/${req.body.id}/status`).send({ status: "BOGUS" }).expect(400);
    await request(app).put("/requests/missing/status").send({ status: "COMPLETED" }).expect(404);

    const res = await request(app).post("/resources").send({ type: "food", location: "A" }).expect(201);
    const off = await request(app).put(`/resources/${res.body.id}/status`).send({ status: "UNAVAILABLE" }).expect(200);
    expect(off.body).toMatchObject({ status: "UNAVAILABLE", availability: false });
    await request(app).put("/resources/missing/status").send({ status: "AVAILABLE" }).expect(404);
  });

  it("frees the resource when an assigned request is cancelled or completed", async () => {
    for (const final of ["CANCELLED", "COMPLETED"]) {
      const { app, store } = setup();
      const res = await request(app).post("/resources").send({ type: "water", location: "A" }).expect(201);
      const req = await request(app).post("/requests").send({ type: "water", location: "A" }).expect(201);
      // What the matching service does:
      await store.put(resourceKey(res.body.id), { ...res.body, status: "ASSIGNED", availability: false, assignedRequestId: req.body.id });
      await store.put(requestKey(req.body.id), { ...req.body, status: "ASSIGNED", resourceId: res.body.id });

      await request(app).put(`/requests/${req.body.id}/status`).send({ status: final }).expect(200);
      const freed = await store.get<Resource>(resourceKey(res.body.id));
      expect(freed, final).toMatchObject({ status: "AVAILABLE", availability: true, assignedRequestId: null });
    }
  });

  it("does not free a resource that now belongs to a different request", async () => {
    const { app, store } = setup();
    const res = await request(app).post("/resources").send({ type: "water", location: "A" }).expect(201);
    const req = await request(app).post("/requests").send({ type: "water", location: "A" }).expect(201);
    await store.put(requestKey(req.body.id), { ...req.body, status: "ASSIGNED", resourceId: res.body.id });
    await store.put(resourceKey(res.body.id), { ...res.body, status: "ASSIGNED", availability: false, assignedRequestId: "someone-else" });
    await request(app).put(`/requests/${req.body.id}/status`).send({ status: "CANCELLED" }).expect(200);
    expect((await store.get<Resource>(resourceKey(res.body.id)))!.status).toBe("ASSIGNED");
  });

  it("applies many concurrent status updates without losing the record", async () => {
    const { app } = setup();
    const req = await request(app).post("/requests").send({ type: "water", location: "A" }).expect(201);
    const statuses = ["IN_PROGRESS", "ASSIGNED", "COMPLETED", "CANCELLED", "PENDING"];
    const results = await Promise.all(statuses.map((status) => request(app).put(`/requests/${req.body.id}/status`).send({ status })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const final = await request(app).get(`/requests/${req.body.id}`).expect(200);
    expect(statuses).toContain(final.body.status);
    expect(final.body).toMatchObject({ id: req.body.id, type: "water", location: "A" });
  });

  it("handles many simultaneous request creations", async () => {
    const { app, queued } = setup();
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, i) => request(app).post("/requests").send({ type: "food", location: `L${i}` })),
    );
    expect(created.every((r) => r.status === 201)).toBe(true);
    expect(new Set(created.map((r) => r.body.id)).size).toBe(20);
    expect(queued).toHaveLength(20);
    expect((await request(app).get("/requests").expect(200)).body).toHaveLength(20);
  });

  it("reports system health and has root and health endpoints", async () => {
    const { app } = setup();
    expect((await request(app).get("/").expect(200)).body.service).toBe("request-service");
    expect((await request(app).get("/health").expect(200)).body).toEqual({ ok: true });
    const sys = await request(app).get("/system").expect(200);
    expect(sys.body).toMatchObject({ requestService: "up", rabbitmq: "up", coordinator: { reachable: true, ok: true } });
    const down = setup({ publishFails: true });
    expect((await request(down.app).get("/system").expect(200)).body.rabbitmq).toBe("down");
  });
});
