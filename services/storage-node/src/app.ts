import express from "express";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface Entry {
  value: unknown;
  version: number;
}

export interface StorageOptions {
  // When set, the data is written here on every change and reloaded on start.
  dataFile?: string;
}

// One storage node: a versioned key-value store exposed over HTTP.
// Every write carries a version from the coordinator. A write older than what the
// node already holds is ignored, so a late or replayed write can never undo a newer one.
export function createStorageApp(nodeId: string, shard: number, options: StorageOptions = {}) {
  const data = new Map<string, Entry>();
  const { dataFile } = options;

  if (dataFile) {
    mkdirSync(dirname(dataFile), { recursive: true });
    if (existsSync(dataFile)) {
      const saved = JSON.parse(readFileSync(dataFile, "utf8")) as Array<[string, Entry]>;
      for (const [key, entry] of saved) data.set(key, entry);
    }
  }

  // Writes are serialized and go through a temp file + rename, so a crash never leaves a torn file.
  let writing: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    if (!dataFile) return Promise.resolve();
    const snapshot = JSON.stringify([...data.entries()]);
    const next = writing.then(async () => {
      await writeFile(`${dataFile}.tmp`, snapshot);
      await rename(`${dataFile}.tmp`, dataFile);
    });
    writing = next.catch(() => {});
    return next;
  };

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, nodeId, shard, keys: data.size, persistent: Boolean(dataFile) });
  });

  // Used by the coordinator to reconcile a node that has just recovered: [key, value, version].
  app.get("/internal/dump", (_req, res) => {
    res.json([...data.entries()].map(([key, e]) => [key, e.value, e.version]));
  });

  app.get("/internal/data/:key", (req, res) => {
    const entry = data.get(req.params.key);
    if (!entry) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.set("x-version", String(entry.version));
    res.json(entry.value);
  });

  app.put("/internal/data/:key", async (req, res) => {
    if (req.body === undefined) {
      res.status(400).json({ error: "JSON body required" });
      return;
    }
    const version = Number(req.header("x-version"));
    if (!Number.isFinite(version)) {
      res.status(400).json({ error: "x-version header required" });
      return;
    }
    const existing = data.get(req.params.key);
    if (existing && existing.version > version) {
      res.json({ ok: true, applied: false, version: existing.version });
      return;
    }
    data.set(req.params.key, { value: req.body, version });
    await persist();
    res.json({ ok: true, applied: true, version });
  });

  app.get("/", (_req, res) => res.json({ service: "storage-node", nodeId, shard }));

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? "internal error" : "bad request" });
  });

  return { app, data };
}
