import { describe, expect, it } from "vitest";
import request from "supertest";
import { MemoryStore, StoreUnavailableError, requestKey, resourceKey, type Resource } from "@emergency/shared";
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
    expect(list.body.items.map((r: { id: string }) => r.id)).toEqual([second.body.id, first.body.id]);
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
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].status).toBe("AVAILABLE");
  });

  it("returns 409 when matching a request that is no longer pending", async () => {
    const { app } = setup();
    const created = await request(app)
      .post("/requests")
      .send({ type: "food", location: "Zone A" })
      .expect(201);
    await request(app).put(`/requests/${created.body.id}/status`).send({ status: "CANCELLED" }).expect(200);
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

  it("gives a resource an id that carries its type and stores it under that type", async () => {
    const { app, store } = setup();
    const res = await request(app).post("/resources").send({ type: "medicine", location: "A" }).expect(201);
    expect(res.body.id.startsWith("medicine-")).toBe(true);
    expect(await store.list("resource:medicine:")).toHaveLength(1);
    expect(await store.list("resource:water:")).toHaveLength(0);
    const all = await request(app).get("/resources").expect(200);
    expect(all.body.items).toHaveLength(1);
  });

  it("updates request and resource statuses and validates them", async () => {
    const { app } = setup();
    const req = await request(app).post("/requests").send({ type: "food", location: "A" }).expect(201);
    const upd = await request(app).put(`/requests/${req.body.id}/status`).send({ status: "CANCELLED" }).expect(200);
    expect(upd.body.status).toBe("CANCELLED");
    await request(app).put(`/requests/${req.body.id}/status`).send({ status: "BOGUS" }).expect(400);
    await request(app).put("/requests/missing/status").send({ status: "CANCELLED" }).expect(404);

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
    const results = await Promise.all(
      Array.from({ length: 8 }, () => request(app).put(`/requests/${req.body.id}/status`).send({ status: "CANCELLED" })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const final = await request(app).get(`/requests/${req.body.id}`).expect(200);
    expect(final.body).toMatchObject({ id: req.body.id, type: "water", location: "A", status: "CANCELLED" });
  });

  it("handles many simultaneous request creations", async () => {
    const { app, queued } = setup();
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, i) => request(app).post("/requests").send({ type: "food", location: `L${i}` })),
    );
    expect(created.every((r) => r.status === 201)).toBe(true);
    expect(new Set(created.map((r) => r.body.id)).size).toBe(20);
    expect(queued).toHaveLength(20);
    expect((await request(app).get("/requests").expect(200)).body.items).toHaveLength(20);
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

  describe("idempotency", () => {
    const body = { type: "water", location: "Zone A", details: "flood" };

    it("a repeated create with the same key returns the same request and queues it once per attempt", async () => {
      const { app } = setup();
      const key = "double-click-0001";
      const [a, b] = await Promise.all([
        request(app).post("/requests").set("Idempotency-Key", key).send(body),
        request(app).post("/requests").set("Idempotency-Key", key).send(body),
      ]);
      expect(a.body.id).toBe(b.body.id);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      const list = await request(app).get("/requests").expect(200);
      expect(list.body.total).toBe(1);
    });

    it("a retry after a refused (503) write does not create a duplicate", async () => {
      // The store accepts the write but then reports failure, like a coordinator that stored the
      // record on a replica and still answered 503.
      const store = new MemoryStore();
      let fail = true;
      const flaky = Object.create(store) as MemoryStore;
      flaky.cas = async (k, v, value) => {
        const ok = await store.cas(k, v, value);
        if (fail) throw new StoreUnavailableError("503");
        return ok;
      };
      const app = createRequestApp({ store: flaky, publishMatch: async () => {} });
      const key = "retry-after-503-1";
      await request(app).post("/requests").set("Idempotency-Key", key).send(body).expect(503);
      fail = false;
      const retry = await request(app).post("/requests").set("Idempotency-Key", key).send(body).expect(200);
      expect(retry.headers["idempotent-replay"]).toBe("true");
      expect((await request(app).get("/requests")).body.total).toBe(1);
    });

    it("refuses a key that was used for a different request", async () => {
      const { app } = setup();
      const key = "reused-key-00001";
      await request(app).post("/requests").set("Idempotency-Key", key).send(body).expect(201);
      await request(app).post("/requests").set("Idempotency-Key", key).send({ ...body, type: "food" }).expect(409);
    });

    it("rejects a malformed key and works the same for resources", async () => {
      const { app } = setup();
      await request(app).post("/requests").set("Idempotency-Key", "short").send(body).expect(400);
      const key = "resource-key-0001";
      const a = await request(app).post("/resources").set("Idempotency-Key", key).send({ type: "food", location: "Z" }).expect(201);
      const b = await request(app).post("/resources").set("Idempotency-Key", key).send({ type: "food", location: "Z" }).expect(200);
      expect(b.body.id).toBe(a.body.id);
      expect((await request(app).get("/resources")).body.total).toBe(1);
    });
  });

  describe("pagination", () => {
    it("pages through requests with a cursor, without gaps or repeats", async () => {
      const { app } = setup();
      for (let i = 0; i < 7; i++) {
        await request(app).post("/requests").send({ type: "food", location: `Zone ${i}` }).expect(201);
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: request.Response = await request(app).get("/requests").query({ limit: 3, ...(cursor ? { cursor } : {}) }).expect(200);
        expect(res.body.total).toBe(7);
        seen.push(...res.body.items.map((r: { id: string }) => r.id));
        cursor = res.body.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(7);
    });

    it("rejects a bad limit or cursor and filters resources by type", async () => {
      const { app } = setup();
      await request(app).get("/requests?limit=0").expect(400);
      await request(app).get("/requests?limit=100000").expect(400);
      await request(app).get("/requests?cursor=bm9wZQ").expect(400);
      await request(app).post("/resources").send({ type: "water", location: "A" }).expect(201);
      await request(app).post("/resources").send({ type: "food", location: "A" }).expect(201);
      const water = await request(app).get("/resources?type=water").expect(200);
      expect(water.body.items.map((r: Resource) => r.type)).toEqual(["water"]);
      await request(app).get("/resources?type=gold").expect(400);
    });
  });

  describe("location validation", () => {
    it.each(["91, 10", "12.97, 190", "123", "!!!", "  ", "-", "Zone <script>", "x".repeat(61)])("rejects %j", async (location) => {
      const { app } = setup();
      await request(app).post("/requests").send({ type: "water", location }).expect(400);
      await request(app).post("/resources").send({ type: "water", location }).expect(400);
    });

    it.each(["Zone A", "12.97, 77.59", "(12.97, 77.59)", "St. John's Ward-2", "Zürich"])("accepts %j", async (location) => {
      const { app } = setup();
      await request(app).post("/requests").send({ type: "water", location }).expect(201);
    });

    it("with a zone list, refuses unknown zones but still accepts coordinates", async () => {
      const app = createRequestApp({ store: new MemoryStore(), publishMatch: async () => {}, zones: ["Zone A", "Zone B"] });
      await request(app).post("/requests").send({ type: "water", location: "asdf" }).expect(400);
      await request(app).post("/requests").send({ type: "water", location: "zone a" }).expect(201);
      await request(app).post("/requests").send({ type: "water", location: "12.97, 77.59" }).expect(201);
    });
  });

  describe("error messages", () => {
    it("explains an oversized body with 413", async () => {
      const { app } = setup();
      const res = await request(app).post("/requests").send({ type: "water", location: "A", details: "x".repeat(200_000) }).expect(413);
      expect(res.body.error).toBe("request body too large (limit 100 KB)");
    });

    it("explains malformed JSON with 400", async () => {
      const { app } = setup();
      const res = await request(app).post("/requests").set("content-type", "application/json").send("{nope").expect(400);
      expect(res.body.error).toBe("malformed request body: send valid JSON");
    });
  });
});
