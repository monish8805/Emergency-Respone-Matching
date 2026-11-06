import express from "express";
import { randomUUID } from "node:crypto";
import {
  createRequestSchema,
  registerResourceSchema,
  requestKey,
  requestStatusSchema,
  resourceKey,
  resourceStatusSchema,
  RESOURCE_PREFIX,
  StoreUnavailableError,
  type EmergencyRequest,
  type KeyValueStore,
  type Resource,
} from "@emergency/shared";
import type { ZodError } from "zod";

export interface RequestAppDeps {
  store: KeyValueStore;
  publishMatch: (requestId: string) => Promise<void>;
}

export function createRequestApp({ store, publishMatch }: RequestAppDeps) {
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  const invalid = (res: express.Response, error: ZodError) =>
    res.status(400).json({ error: "invalid request", details: error.flatten() });

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
    } catch {
      res.status(503).json({ error: "message queue unavailable", requestId: record.id });
      return;
    }
    res.status(201).json(record);
  });

  app.get("/requests/:id", async (req, res) => {
    const record = await store.get<EmergencyRequest>(requestKey(req.params.id));
    if (!record) return res.status(404).json({ error: "request not found" });
    res.json(record);
  });

  app.put("/requests/:id/status", async (req, res) => {
    const parsed = requestStatusSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error);
    const record = await store.get<EmergencyRequest>(requestKey(req.params.id));
    if (!record) return res.status(404).json({ error: "request not found" });
    record.status = parsed.data.status;
    await store.put(requestKey(record.id), record);
    res.json(record);
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
    const record = await store.get<Resource>(resourceKey(req.params.id));
    if (!record) return res.status(404).json({ error: "resource not found" });
    record.status = parsed.data.status;
    record.availability = parsed.data.status === "AVAILABLE";
    await store.put(resourceKey(record.id), record);
    res.json(record);
  });

  app.post("/match/:requestId", async (req, res) => {
    const record = await store.get<EmergencyRequest>(requestKey(req.params.requestId));
    if (!record) return res.status(404).json({ error: "request not found" });
    if (record.status !== "PENDING") {
      return res.status(409).json({ error: "request is not pending", status: record.status });
    }
    try {
      await publishMatch(record.id);
    } catch {
      return res.status(503).json({ error: "message queue unavailable" });
    }
    res.json({ requestId: record.id, queued: true });
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof StoreUnavailableError) {
      return res.status(503).json({ error: "storage unavailable" });
    }
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? "internal error" : "bad request" });
  });

  return app;
}
