import express from "express";
import { randomUUID } from "node:crypto";
import {
  createRequestSchema,
  registerResourceSchema,
  requestKey,
  requestStatusSchema,
  resourceKey,
  resourceStatusSchema,
  REQUEST_PREFIX,
  RESOURCE_PREFIX,
  StoreUnavailableError,
  UpdateConflictError,
  updateRecord,
  type EmergencyRequest,
  type KeyValueStore,
  type Resource,
} from "@emergency/shared";
import type { ZodError } from "zod";

export interface RequestAppDeps {
  store: KeyValueStore;
  publishMatch: (requestId: string) => Promise<void>;
  // Optional probes used by GET /system. When absent the component is reported as "unknown".
  checkRabbit?: () => Promise<boolean>;
  coordinatorHealth?: () => Promise<unknown>;
}

export function createRequestApp({ store, publishMatch, checkRabbit, coordinatorHealth }: RequestAppDeps) {
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  const invalid = (res: express.Response, error: ZodError) =>
    res.status(400).json({ error: "invalid request", details: error.flatten() });

  app.get("/", (_req, res) =>
    res.json({ service: "request-service", health: "/health", system: "/system", docs: "see README" }),
  );

  app.post("/requests", async (req, res) => {
    const parsed = createRequestSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error);

    const record: EmergencyRequest = {
      id: randomUUID(),
      ...parsed.data,
      status: "PENDING",
      resourceId: null,
      createdAt: new Date().toISOString(),
    };
    await store.put(requestKey(record.id), record);
    try {
      await publishMatch(record.id);
    } catch (err) {
      // The request is safely stored as PENDING. The matching service re-queues stuck
      // PENDING requests, so it is matched once RabbitMQ is back. Tell the caller.
      console.error(`could not queue request ${record.id}, the sweeper will retry: ${String(err)}`);
      res.set("x-match-queued", "false");
    }
    res.status(201).json(record);
  });

  app.get("/requests", async (_req, res) => {
    const entries = await store.list<EmergencyRequest>(REQUEST_PREFIX);
    const requests = entries.map((e) => e.value).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(requests);
  });

  app.get("/requests/:id", async (req, res) => {
    const record = await store.get<EmergencyRequest>(requestKey(req.params.id));
    if (!record) return res.status(404).json({ error: "request not found" });
    res.json(record);
  });

  app.put("/requests/:id/status", async (req, res) => {
    const parsed = requestStatusSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error);
    const updated = await updateRecord<EmergencyRequest>(store, requestKey(req.params.id), (r) =>
      r.status === parsed.data.status ? r : { ...r, status: parsed.data.status },
    );
    if (!updated) return res.status(404).json({ error: "request not found" });

    // A finished or cancelled request gives its resource back.
    if ((updated.status === "CANCELLED" || updated.status === "COMPLETED") && updated.resourceId) {
      await updateRecord<Resource>(store, resourceKey(updated.resourceId), (r) =>
        r.assignedRequestId === updated.id
          ? { ...r, status: "AVAILABLE", availability: true, assignedRequestId: null }
          : r,
      );
    }
    res.json(updated);
  });

  app.post("/resources", async (req, res) => {
    const parsed = registerResourceSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error);
    const { availability, ...rest } = parsed.data;
    const record: Resource = {
      id: randomUUID(),
      ...rest,
      availability,
      status: availability ? "AVAILABLE" : "UNAVAILABLE",
      assignedRequestId: null,
    };
    await store.put(resourceKey(record.id), record);
    res.status(201).json(record);
  });

  app.get("/resources", async (_req, res) => {
    const entries = await store.list<Resource>(RESOURCE_PREFIX);
    res.json(entries.map((e) => e.value));
  });

  app.put("/resources/:id/status", async (req, res) => {
    const parsed = resourceStatusSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error);
    const updated = await updateRecord<Resource>(store, resourceKey(req.params.id), (r) => ({
      ...r,
      status: parsed.data.status,
      availability: parsed.data.status === "AVAILABLE",
      assignedRequestId: parsed.data.status === "ASSIGNED" ? r.assignedRequestId ?? null : null,
    }));
    if (!updated) return res.status(404).json({ error: "resource not found" });
    res.json(updated);
  });

  app.post("/match/:requestId", async (req, res) => {
    const record = await store.get<EmergencyRequest>(requestKey(req.params.requestId));
    if (!record) return res.status(404).json({ error: "request not found" });
    if (record.status !== "PENDING") {
      return res.status(409).json({ error: "request is not pending", status: record.status });
    }
    try {
      await publishMatch(record.id);
    } catch (err) {
      console.error(`could not queue match for ${record.id}: ${String(err)}`);
      return res.status(503).json({ error: "message queue unavailable" });
    }
    res.json({ requestId: record.id, queued: true });
  });

  // Liveness: the process is up. Does not depend on other services.
  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Overall picture for the UI: this service, RabbitMQ, and every storage node.
  app.get("/system", async (_req, res) => {
    const [rabbit, coordinator] = await Promise.all([
      checkRabbit ? checkRabbit().catch(() => false) : Promise.resolve(undefined),
      coordinatorHealth
        ? coordinatorHealth().then(
            (h) => ({ reachable: true, ...(h as object) }),
            (e) => ({ reachable: false, error: String(e) }),
          )
        : Promise.resolve(undefined),
    ]);
    res.json({
      requestService: "up",
      rabbitmq: rabbit === undefined ? "unknown" : rabbit ? "up" : "down",
      coordinator: coordinator ?? { reachable: null },
    });
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof StoreUnavailableError) {
      console.error(String(err));
      return res.status(503).json({ error: "storage unavailable" });
    }
    if (err instanceof UpdateConflictError) {
      return res.status(409).json({ error: "too many concurrent changes, try again" });
    }
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? "internal error" : "bad request" });
  });

  return app;
}
