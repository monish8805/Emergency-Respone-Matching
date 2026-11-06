import express from "express";

// One storage node: an in-memory key-value store exposed over HTTP.
export function createStorageApp(nodeId: string, shard: number) {
  const data = new Map<string, unknown>();
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, nodeId, shard, keys: data.size });
  });

  // Used by the coordinator to copy data to a node that has just recovered.
  app.get("/internal/dump", (_req, res) => {
    res.json([...data.entries()]);
  });

  app.get("/internal/data/:key", (req, res) => {
    if (!data.has(req.params.key)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(data.get(req.params.key));
  });

  app.put("/internal/data/:key", (req, res) => {
    if (req.body === undefined) {
      res.status(400).json({ error: "JSON body required" });
      return;
    }
    data.set(req.params.key, req.body);
    res.json({ ok: true });
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    res.status(status).json({ error: status === 500 ? "internal error" : "bad request" });
  });

  return { app, data };
}
