import express from "express";
import { shardFor, type NodeConfig } from "@emergency/shared";
import type { NodeRegistry } from "./nodes";

export function createCoordinatorApp(registry: NodeRegistry) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Calls one storage node. Network errors mark the node down.
  async function call(node: NodeConfig, method: string, path: string, body?: unknown): Promise<Response | null> {
    try {
      return await fetch(`${node.url}${path}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      registry.markDown(node.id);
      return null;
    }
  }

  // Copies all data from a live peer in the same shard onto a recovered node.
  async function syncNode(node: NodeConfig): Promise<void> {
    const peer = registry.liveNodes(node.shard).find((n) => n.id !== node.id);
    if (!peer) return;
    const dump = await call(peer, "GET", "/internal/dump");
    if (!dump || !dump.ok) return;
    const entries = (await dump.json()) as Array<[string, unknown]>;
    for (const [key, value] of entries) {
      const res = await call(node, "PUT", `/internal/data/${encodeURIComponent(key)}`, value);
      if (!res || !res.ok) return;
    }
    console.log(`synced ${entries.length} keys to ${node.id} from ${peer.id}`);
  }

  // Storage nodes call these to say they are alive.
  app.post(["/internal/nodes/register", "/internal/nodes/heartbeat"], (req, res) => {
    const id = req.body?.id;
    if (typeof id !== "string") {
      res.status(400).json({ error: "id is required" });
      return;
    }
    const bootId = typeof req.body?.bootId === "string" ? req.body.bootId : undefined;
    const { known, recovered } = registry.heartbeat(id, bootId);
    if (!known) {
      res.status(404).json({ error: "unknown node" });
      return;
    }
    if (recovered) {
      console.log(`node ${id} recovered, syncing data`);
      const node = registry.get(id);
      if (node) void syncNode(node);
    }
    res.json({ ok: true, recovered });
  });

  // Writes go to every live node in the key's shard (primary and replicas).
  app.put("/internal/data/:key", async (req, res) => {
    const key = req.params.key;
    const value = req.body;
    if (value === undefined) {
      res.status(400).json({ error: "JSON body required" });
      return;
    }
    const shard = shardFor(key, registry.shardCount());
    const targets = registry.liveNodes(shard);
    if (targets.length === 0) {
      res.status(503).json({ error: `no live nodes for shard ${shard}` });
      return;
    }
    const results = await Promise.all(
      targets.map((n) => call(n, "PUT", `/internal/data/${encodeURIComponent(key)}`, value)),
    );
    let accepted = 0;
    results.forEach((r, i) => {
      if (r?.ok) accepted++;
      else registry.markDown(targets[i].id);
    });
    if (accepted === 0) {
      res.status(503).json({ error: "no replica accepted the write" });
      return;
    }
    res.json({ ok: true, shard, replicasWritten: accepted });
  });

  // Reads try each live node in the shard until one has the key.
  app.get("/internal/data/:key", async (req, res) => {
    const key = req.params.key;
    const shard = shardFor(key, registry.shardCount());
    const targets = registry.liveNodes(shard);
    if (targets.length === 0) {
      res.status(503).json({ error: `no live nodes for shard ${shard}` });
      return;
    }
    let missing = false;
    for (const node of targets) {
      const r = await call(node, "GET", `/internal/data/${encodeURIComponent(key)}`);
      if (!r) continue;
      if (r.status === 404) {
        missing = true;
        continue;
      }
      if (r.ok) {
        res.json(await r.json());
        return;
      }
      registry.markDown(node.id);
    }
    if (missing) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.status(503).json({ error: "no replica could serve the read" });
  });

  // Lists all keys with a prefix, across every shard.
  app.get("/internal/list", async (req, res) => {
    const prefix = typeof req.query.prefix === "string" ? req.query.prefix : "";
    const found = new Map<string, unknown>();
    for (let shard = 0; shard < registry.shardCount(); shard++) {
      let answered = false;
      for (const node of registry.liveNodes(shard)) {
        const r = await call(node, "GET", "/internal/dump");
        if (!r || !r.ok) continue;
        const entries = (await r.json()) as Array<[string, unknown]>;
        for (const [key, value] of entries) {
          if (key.startsWith(prefix)) found.set(key, value);
        }
        answered = true;
        break;
      }
      if (!answered) {
        res.status(503).json({ error: `shard ${shard} unavailable` });
        return;
      }
    }
    res.json([...found].map(([key, value]) => ({ key, value })));
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, nodes: registry.statuses() });
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? "internal error" : "bad request" });
  });

  return app;
}
