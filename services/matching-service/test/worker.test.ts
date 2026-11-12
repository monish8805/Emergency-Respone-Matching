import { describe, expect, it } from "vitest";
import {
  MemoryStore,
  requestKey,
  resourceKey,
  type EmergencyRequest,
  type RequestType,
  type Resource,
} from "@emergency/shared";
import { processMatch } from "../src/worker";
import { sweepPending } from "../src/sweeper";

let counter = 0;
async function addRequest(store: MemoryStore, type: RequestType, location: string, createdAt = new Date().toISOString()) {
  const r: EmergencyRequest = { id: `req-${++counter}`, type, location, details: "", status: "PENDING", resourceId: null, createdAt };
  await store.put(requestKey(r.id), r);
  return r;
}
async function addResource(store: MemoryStore, type: RequestType, location: string) {
  const r: Resource = { id: `res-${++counter}`, type, location, availability: true, status: "AVAILABLE", assignedRequestId: null };
  await store.put(resourceKey(r.id), r);
  return r;
}
const request = (store: MemoryStore, id: string) => store.get<EmergencyRequest>(requestKey(id));
const resource = (store: MemoryStore, id: string) => store.get<Resource>(resourceKey(id));

describe("processMatch", () => {
  it("assigns a matching resource and updates both records", async () => {
    const store = new MemoryStore();
    const res = await addResource(store, "water", "Zone A");
    const req = await addRequest(store, "water", "zone a ");
    expect(await processMatch(req.id, store)).toBe("assigned");
    expect(await request(store, req.id)).toMatchObject({ status: "ASSIGNED", resourceId: res.id });
    expect(await resource(store, res.id)).toMatchObject({ status: "ASSIGNED", availability: false, assignedRequestId: req.id });
  });

  it("leaves the request PENDING when nothing matches", async () => {
    const store = new MemoryStore();
    await addResource(store, "food", "Zone A");
    const req = await addRequest(store, "water", "Zone A");
    expect(await processMatch(req.id, store)).toBe("no-match");
    expect((await request(store, req.id))!.status).toBe("PENDING");
  });

  it("skips requests that are not pending, so redelivered jobs are harmless", async () => {
    const store = new MemoryStore();
    await addResource(store, "water", "A");
    const req = await addRequest(store, "water", "A");
    expect(await processMatch(req.id, store)).toBe("assigned");
    expect(await processMatch(req.id, store)).toBe("skipped");
    expect(await processMatch("does-not-exist", store)).toBe("skipped");
  });

  it("gives a single resource to only one of many simultaneous requests", async () => {
    const store = new MemoryStore();
    const res = await addResource(store, "water", "Zone A");
    const requests = await Promise.all(Array.from({ length: 10 }, () => addRequest(store, "water", "Zone A")));

    const outcomes = await Promise.all(requests.map((r) => processMatch(r.id, store)));

    expect(outcomes.filter((o) => o === "assigned")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "no-match")).toHaveLength(9);
    const assigned = (await Promise.all(requests.map((r) => request(store, r.id)))).filter((r) => r!.status === "ASSIGNED");
    expect(assigned).toHaveLength(1);
    expect((await resource(store, res.id))!.assignedRequestId).toBe(assigned[0]!.id);
  });

  it("gives every request its own resource when there are enough", async () => {
    const store = new MemoryStore();
    const resources = await Promise.all(Array.from({ length: 8 }, () => addResource(store, "food", "Zone B")));
    const requests = await Promise.all(Array.from({ length: 8 }, () => addRequest(store, "food", "Zone B")));

    const outcomes = await Promise.all(requests.map((r) => processMatch(r.id, store)));
    expect(outcomes.every((o) => o === "assigned")).toBe(true);

    const used = (await Promise.all(requests.map((r) => request(store, r.id)))).map((r) => r!.resourceId);
    expect(new Set(used).size).toBe(8);
    for (const r of resources) expect((await resource(store, r.id))!.status).toBe("ASSIGNED");
  });

  it("is safe when the same job is processed twice at once", async () => {
    const store = new MemoryStore();
    await addResource(store, "shelter", "A");
    await addResource(store, "shelter", "A");
    const req = await addRequest(store, "shelter", "A");
    const outcomes = await Promise.all([processMatch(req.id, store), processMatch(req.id, store), processMatch(req.id, store)]);
    expect(outcomes.filter((o) => o === "assigned")).toHaveLength(1);
    const claimed = (await store.list<Resource>("resource:")).filter((e) => e.value.status === "ASSIGNED");
    expect(claimed).toHaveLength(1); // no second resource got locked up by the duplicate job
  });

  it("completes an assignment that a crashed matcher left half-done", async () => {
    const store = new MemoryStore();
    const res = await addResource(store, "medicine", "A");
    const req = await addRequest(store, "medicine", "A");
    // Simulate: resource claimed for the request, but the process died before updating the request.
    await store.put(resourceKey(res.id), { ...res, status: "ASSIGNED", availability: false, assignedRequestId: req.id });
    const spare = await addResource(store, "medicine", "A");

    expect(await processMatch(req.id, store)).toBe("assigned");
    expect((await request(store, req.id))!.resourceId).toBe(res.id);
    expect((await resource(store, spare.id))!.status).toBe("AVAILABLE"); // spare not wasted
  });

  it("releases its claim if the request was cancelled while matching", async () => {
    const store = new MemoryStore();
    const res = await addResource(store, "water", "A");
    const req = await addRequest(store, "water", "A");
    // Cancel the request just after the matcher reads it but before it commits.
    const racing = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "cas") {
          return async (key: string, v: number | null, value: unknown) => {
            if (key === requestKey(req.id)) {
              await target.put(key, { ...req, status: "CANCELLED" });
            }
            return target.cas(key, v, value);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(await processMatch(req.id, racing)).toBe("skipped");
    expect((await request(store, req.id))!.status).toBe("CANCELLED");
    expect(await resource(store, res.id)).toMatchObject({ status: "AVAILABLE", availability: true, assignedRequestId: null });
  });
});

describe("sweepPending", () => {
  const old = () => new Date(Date.now() - 60_000).toISOString();

  it("re-queues pending requests that a free resource could serve", async () => {
    const store = new MemoryStore();
    await addResource(store, "water", "Zone A");
    const waiting = await addRequest(store, "water", "Zone A", old());
    const queued: string[] = [];
    expect(await sweepPending(store, async (id) => void queued.push(id), 10_000)).toBe(1);
    expect(queued).toEqual([waiting.id]);
  });

  it("skips requests that are too new, already handled, or that no resource could serve", async () => {
    const store = new MemoryStore();
    await addResource(store, "water", "Zone A");
    await addRequest(store, "water", "Zone A", new Date().toISOString()); // too new
    const done = await addRequest(store, "water", "Zone A", old());
    await store.put(requestKey(done.id), { ...done, status: "ASSIGNED" }); // already handled
    await addRequest(store, "shelter", "Zone A", old()); // wrong type
    await addRequest(store, "water", "Zone Z", old()); // nobody there
    await addRequest(store, "water", "12.97, 77.59", old()); // zone resource never serves coordinates
    const queued: string[] = [];
    expect(await sweepPending(store, async (id) => void queued.push(id), 10_000)).toBe(0);
    expect(queued).toEqual([]);
  });

  it("does not keep re-queuing unmatchable requests on every sweep", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 30; i++) await addRequest(store, "medicine", `Nowhere ${i}`, old());
    let published = 0;
    for (let sweep = 0; sweep < 5; sweep++) await sweepPending(store, async () => void published++, 0);
    expect(published).toBe(0);
  });

  it("queues a waiting request as soon as a matching resource appears", async () => {
    const store = new MemoryStore();
    const req = await addRequest(store, "food", "12.97, 77.59", old());
    const queued: string[] = [];
    expect(await sweepPending(store, async (id) => void queued.push(id), 0)).toBe(0);
    await addResource(store, "food", "12.975, 77.595"); // ~0.7 km away
    expect(await sweepPending(store, async (id) => void queued.push(id), 0)).toBe(1);
    expect(queued).toEqual([req.id]);
  });

  it("respects the matching radius", async () => {
    const store = new MemoryStore();
    await addRequest(store, "food", "12.97, 77.59", old());
    await addResource(store, "food", "12.99, 77.59"); // ~2.2 km away
    expect(await sweepPending(store, async () => {}, 0, { radiusKm: 1 })).toBe(0);
    expect(await sweepPending(store, async () => {}, 0, { radiusKm: 5 })).toBe(1);
  });

  it("re-queues a request whose resource claim was left half-finished by a crashed matcher", async () => {
    const store = new MemoryStore();
    const res = await addResource(store, "shelter", "Zone C");
    const req = await addRequest(store, "shelter", "Zone C", old());
    // The matcher claimed the resource but died before marking the request ASSIGNED.
    await store.put(resourceKey(res.id), { ...res, status: "ASSIGNED", availability: false, assignedRequestId: req.id });
    const queued: string[] = [];
    expect(await sweepPending(store, async (id) => void queued.push(id), 0)).toBe(1);
    expect(queued).toEqual([req.id]);
    expect(await processMatch(req.id, store)).toBe("assigned"); // and the next attempt completes it
  });

  it("propagates publish failures so the caller can log and retry on the next sweep", async () => {
    const store = new MemoryStore();
    await addResource(store, "water", "A");
    await addRequest(store, "water", "A", old());
    await expect(
      sweepPending(store, async () => {
        throw new Error("rabbit down");
      }, 0),
    ).rejects.toThrow("rabbit down");
  });
});

describe("distance-based matching", () => {
  it("assigns the nearest resource and records the distance", async () => {
    const store = new MemoryStore();
    await addResource(store, "water", "12.997, 77.59"); // ~3 km
    const near = await addResource(store, "water", "12.9745, 77.59"); // ~0.5 km
    const req = await addRequest(store, "water", "12.97, 77.59");
    expect(await processMatch(req.id, store)).toBe("assigned");
    const done = (await request(store, req.id))!;
    expect(done.resourceId).toBe(near.id);
    expect(done.distanceKm).toBeCloseTo(0.5, 1);
  });

  it("does not assign a resource outside the radius", async () => {
    const store = new MemoryStore();
    await addResource(store, "water", "13.5, 78.0");
    const req = await addRequest(store, "water", "12.97, 77.59");
    expect(await processMatch(req.id, store, { radiusKm: 5 })).toBe("no-match");
    expect((await request(store, req.id))!.status).toBe("PENDING");
    expect(await processMatch(req.id, store, { radiusKm: 100 })).toBe("assigned");
  });

  it("still matches zone names, with no distance", async () => {
    const store = new MemoryStore();
    const res = await addResource(store, "food", "Zone B");
    const req = await addRequest(store, "food", "zone b");
    expect(await processMatch(req.id, store)).toBe("assigned");
    const done = (await request(store, req.id))!;
    expect(done.resourceId).toBe(res.id);
    expect(done.distanceKm).toBeNull();
  });

  it("does not match a zone request with a coordinate resource", async () => {
    const store = new MemoryStore();
    await addResource(store, "food", "12.97, 77.59");
    const req = await addRequest(store, "food", "Zone B");
    expect(await processMatch(req.id, store)).toBe("no-match");
  });

  it("gives simultaneous nearby requests different resources, nearest first", async () => {
    const store = new MemoryStore();
    await Promise.all([
      addResource(store, "shelter", "12.9701, 77.59"),
      addResource(store, "shelter", "12.9702, 77.59"),
      addResource(store, "shelter", "12.9703, 77.59"),
    ]);
    const reqs = await Promise.all([1, 2, 3].map(() => addRequest(store, "shelter", "12.97, 77.59")));
    const outcomes = await Promise.all(reqs.map((r) => processMatch(r.id, store)));
    expect(outcomes.every((o) => o === "assigned")).toBe(true);
    const used = (await Promise.all(reqs.map((r) => request(store, r.id)))).map((r) => r!.resourceId);
    expect(new Set(used).size).toBe(3);
  });
});
