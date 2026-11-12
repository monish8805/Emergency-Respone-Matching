import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  MemoryStore,
  REQUEST_STATUSES,
  canTransition,
  requestKey,
  resourceKey,
  type EmergencyRequest,
  type Resource,
} from "@emergency/shared";
import { createRequestApp } from "../src/app";
import { processMatch } from "../../matching-service/src/worker";

function setup() {
  const queued: string[] = [];
  const store = new MemoryStore();
  const app = createRequestApp({ store, publishMatch: async (id) => void queued.push(id) });
  return { app, store, queued };
}
type Ctx = ReturnType<typeof setup>;

async function newResource(ctx: Ctx, type = "water", location = "Zone A"): Promise<Resource> {
  return (await request(ctx.app).post("/resources").send({ type, location }).expect(201)).body;
}
async function newRequest(ctx: Ctx, type = "water", location = "Zone A"): Promise<EmergencyRequest> {
  return (await request(ctx.app).post("/requests").send({ type, location }).expect(201)).body;
}
const getRequest = (ctx: Ctx, id: string) => ctx.store.get<EmergencyRequest>(requestKey(id));
const getResource = (ctx: Ctx, id: string) => ctx.store.get<Resource>(resourceKey(id));

describe("request status rules", () => {
  // Every (from, to) pair: the API must agree with the rules in canTransition.
  const pairs = REQUEST_STATUSES.flatMap((from) => REQUEST_STATUSES.map((to) => [from, to] as const));

  it.each(pairs)("%s -> %s", async (from, to) => {
    const ctx = setup();
    const resource = await newResource(ctx);
    const req = await newRequest(ctx);
    // Put the request into the starting state the way the system would.
    const assigned = from !== "PENDING";
    await ctx.store.put(requestKey(req.id), { ...req, status: from, resourceId: assigned ? resource.id : null });
    if (assigned) {
      await ctx.store.put(resourceKey(resource.id), { ...resource, status: "ASSIGNED", availability: false, assignedRequestId: req.id });
    }

    const res = await request(ctx.app).put(`/requests/${req.id}/status`).send({ status: to });

    if (canTransition(from, to)) {
      expect(res.status).toBe(200);
      expect((await getRequest(ctx, req.id))!.status).toBe(to);
    } else {
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/cannot change/i);
      expect(res.body.allowed).toEqual(expect.any(Array));
      expect((await getRequest(ctx, req.id))!.status).toBe(from); // unchanged
    }
  });

  it("cannot assign a pending request by hand, so no request is ever ASSIGNED without a resource", async () => {
    const ctx = setup();
    const req = await newRequest(ctx, "food", "Nowhere");
    await request(ctx.app).put(`/requests/${req.id}/status`).send({ status: "ASSIGNED" }).expect(409);
    const after = (await getRequest(ctx, req.id))!;
    expect(after.status).toBe("PENDING");
    expect(after.resourceId).toBeNull();
  });

  it("cannot reopen a completed request", async () => {
    const ctx = setup();
    const req = await newRequest(ctx);
    await request(ctx.app).put(`/requests/${req.id}/status`).send({ status: "CANCELLED" }).expect(200);
    await request(ctx.app).put(`/requests/${req.id}/status`).send({ status: "PENDING" }).expect(409);
    expect((await getRequest(ctx, req.id))!.status).toBe("CANCELLED");
  });

  it("a request goes through its whole life: matched, started, completed, resource freed", async () => {
    const ctx = setup();
    const res = await newResource(ctx);
    const req = await newRequest(ctx);
    expect(await processMatch(req.id, ctx.store)).toBe("assigned");
    await request(ctx.app).put(`/requests/${req.id}/status`).send({ status: "IN_PROGRESS" }).expect(200);
    await request(ctx.app).put(`/requests/${req.id}/status`).send({ status: "COMPLETED" }).expect(200);
    expect(await getResource(ctx, res.id)).toMatchObject({ status: "AVAILABLE", availability: true, assignedRequestId: null });
  });

  it("an invalid change loses cleanly against a concurrent valid one", async () => {
    const ctx = setup();
    const req = await newRequest(ctx);
    const results = await Promise.all([
      request(ctx.app).put(`/requests/${req.id}/status`).send({ status: "CANCELLED" }),
      request(ctx.app).put(`/requests/${req.id}/status`).send({ status: "ASSIGNED" }),
      request(ctx.app).put(`/requests/${req.id}/status`).send({ status: "COMPLETED" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect((await getRequest(ctx, req.id))!.status).toBe("CANCELLED");
  });
});

describe("changing the status of an assigned resource", () => {
  async function assignedPair(ctx: Ctx) {
    const resource = await newResource(ctx);
    const req = await newRequest(ctx);
    expect(await processMatch(req.id, ctx.store)).toBe("assigned");
    return { resource, req };
  }

  it("never leaves two requests assigned to the same resource", async () => {
    const ctx = setup();
    const { resource, req: a } = await assignedPair(ctx);
    // The operator sets the resource back to AVAILABLE with the dropdown, then another request arrives.
    await request(ctx.app).put(`/resources/${resource.id}/status`).send({ status: "AVAILABLE" }).expect(200);
    const b = await newRequest(ctx);
    await processMatch(b.id, ctx.store);

    const [A, B] = [(await getRequest(ctx, a.id))!, (await getRequest(ctx, b.id))!];
    const assignedToResource = [A, B].filter((r) => r.status === "ASSIGNED" && r.resourceId === resource.id);
    expect(assignedToResource.length).toBeLessThanOrEqual(1);
  });

  it("returns the request to PENDING when its resource becomes unavailable, and queues it again", async () => {
    const ctx = setup();
    const { resource, req } = await assignedPair(ctx);
    ctx.queued.length = 0;
    const res = await request(ctx.app).put(`/resources/${resource.id}/status`).send({ status: "UNAVAILABLE" }).expect(200);

    expect(res.body).toMatchObject({ status: "UNAVAILABLE", availability: false, assignedRequestId: null, releasedRequestId: req.id });
    expect(await getRequest(ctx, req.id)).toMatchObject({ status: "PENDING", resourceId: null });
    expect(ctx.queued).toEqual([req.id]); // it will look for another resource
    // and the unavailable resource cannot be taken by anyone
    const other = await newRequest(ctx);
    expect(await processMatch(other.id, ctx.store)).toBe("no-match");
  });

  it("rematches the request once the resource is available again", async () => {
    const ctx = setup();
    const { resource, req } = await assignedPair(ctx);
    await request(ctx.app).put(`/resources/${resource.id}/status`).send({ status: "AVAILABLE" }).expect(200);
    expect((await getRequest(ctx, req.id))!.status).toBe("PENDING");
    expect(await processMatch(req.id, ctx.store)).toBe("assigned");
    expect(await getRequest(ctx, req.id)).toMatchObject({ status: "ASSIGNED", resourceId: resource.id });
    expect(await getResource(ctx, resource.id)).toMatchObject({ status: "ASSIGNED", assignedRequestId: req.id });
  });

  it("also returns an in-progress request to PENDING", async () => {
    const ctx = setup();
    const { resource, req } = await assignedPair(ctx);
    await request(ctx.app).put(`/requests/${req.id}/status`).send({ status: "IN_PROGRESS" }).expect(200);
    await request(ctx.app).put(`/resources/${resource.id}/status`).send({ status: "UNAVAILABLE" }).expect(200);
    expect(await getRequest(ctx, req.id)).toMatchObject({ status: "PENDING", resourceId: null });
  });

  it("leaves finished requests alone", async () => {
    const ctx = setup();
    const { resource, req } = await assignedPair(ctx);
    await request(ctx.app).put(`/requests/${req.id}/status`).send({ status: "COMPLETED" }).expect(200);
    const res = await request(ctx.app).put(`/resources/${resource.id}/status`).send({ status: "UNAVAILABLE" }).expect(200);
    expect(res.body.releasedRequestId).toBeUndefined();
    expect((await getRequest(ctx, req.id))!.status).toBe("COMPLETED");
  });

  it("changes a resource that is not assigned without touching any request", async () => {
    const ctx = setup();
    const resource = await newResource(ctx);
    const res = await request(ctx.app).put(`/resources/${resource.id}/status`).send({ status: "UNAVAILABLE" }).expect(200);
    expect(res.body).toMatchObject({ status: "UNAVAILABLE", availability: false });
    expect(res.body.releasedRequestId).toBeUndefined();
  });

  it("keeps the claim when a resource is set to ASSIGNED again", async () => {
    const ctx = setup();
    const { resource, req } = await assignedPair(ctx);
    await request(ctx.app).put(`/resources/${resource.id}/status`).send({ status: "ASSIGNED" }).expect(200);
    expect(await getRequest(ctx, req.id)).toMatchObject({ status: "ASSIGNED", resourceId: resource.id });
    expect((await getResource(ctx, resource.id))!.assignedRequestId).toBe(req.id);
  });
});
