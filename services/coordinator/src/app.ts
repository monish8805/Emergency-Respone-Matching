import express from "express";
import { shardFor, type NodeConfig } from "@emergency/shared";
import type { NodeRegistry } from "./nodes";

type Entry = { value: unknown; version: number };

export function createCoordinatorApp(registry: NodeRegistry) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Calls one storage node. Network errors mark the node down.
  async function call(
    node: NodeConfig,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response | null> {
    try {
      return await fetch(`${node.url}${path}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json", ...headers } : headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(2000),
      });
    } catch (err) {
      console.error(`node ${node.id} unreachable (${method} ${path}): ${String(err)}`);
      registry.markDown(node.id);
      return null;
    }
  }

  // ---- ordering ----
  // All changes to one key run one at a time, so reads-then-writes (CAS, resync) are atomic.
  // This relies on a single coordinator instance.
  const locks = new Map<string, Promise<unknown>>();
  async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (locks.get(key) === tail) locks.delete(key);
    }
  }

  // Versions only go up, even across coordinator restarts (they follow the clock).
  let lastVersion = 0;
  const nextVersion = () => (lastVersion = Math.max(lastVersion + 1, Date.now()));

  // ---- single-key operations ----

  async function readEntry(shard: number, key: string): Promise<Entry | "missing" | "unavailable"> {
    const targets = registry.liveNodes(shard);
    if (targets.length === 0) return "unavailable";
    let missing = false;
    for (const node of targets) {
      const r = await call(node, "GET", `/internal/data/${encodeURIComponent(key)}`);
      if (!r) continue;
      if (r.status === 404) {
        missing = true;
        continue;
      }
      if (r.ok) return { value: await r.json(), version: Number(r.headers.get("x-version") ?? 0) };
      registry.markDown(node.id);
    }
    return missing ? "missing" : "unavailable";
  }

  // Writes to every node of the shard that is alive (primary, replica, and nodes catching up).
  async function writeEntry(shard: number, key: string, value: unknown): Promise<{ ok: boolean; replicas: number; version: number }> {
    const targets = registry.writeNodes(shard);
    const version = nextVersion();
    const results = await Promise.all(
      targets.map((n) =>
        call(n, "PUT", `/internal/data/${encodeURIComponent(key)}`, value, { "x-version": String(version) }),
      ),
    );
    let accepted = 0;
    results.forEach((r, i) => {
      if (r?.ok) accepted++;
      else registry.markDown(targets[i].id);
    });
    return { ok: accepted > 0, replicas: accepted, version };
  }

  // ---- resync ----
  // Brings a recovered node and its peer to the same data. For each key the copy with the
  // higher version wins, in both directions, one key at a time under that key's lock, so a
  // write that arrives mid-sync can never be overwritten by an older copy.
  const syncing = new Set<string>();

  async function dumpOf(node: NodeConfig): Promise<Array<[string, unknown, number]> | null> {
    const r = await call(node, "GET", "/internal/dump");
    return r?.ok ? ((await r.json()) as Array<[string, unknown, number]>) : null;
  }

  async function entryOf(node: NodeConfig, key: string): Promise<Entry | null | undefined> {
    const r = await call(node, "GET", `/internal/data/${encodeURIComponent(key)}`);
    if (!r) return undefined; // unreachable
    if (r.status === 404) return null;
    if (!r.ok) return undefined;
    return { value: await r.json(), version: Number(r.headers.get("x-version") ?? 0) };
  }

  async function copyEntry(to: NodeConfig, key: string, entry: Entry): Promise<boolean> {
    const r = await call(to, "PUT", `/internal/data/${encodeURIComponent(key)}`, entry.value, {
      "x-version": String(entry.version),
    });
    return Boolean(r?.ok);
  }

  async function syncNode(node: NodeConfig): Promise<void> {
    if (syncing.has(node.id)) return;
    syncing.add(node.id);
    const bootId = registry.bootIdOf(node.id);
    try {
      const peer = registry.peersOf(node.id)[0];
      const peerDump = peer ? await dumpOf(peer) : null;
      if (peer && peerDump) {
        const nodeDump = await dumpOf(node);
        if (!nodeDump) return; // node is unreachable; it stays out until its next heartbeat
        const keys = new Set([...peerDump.map((e) => e[0]), ...nodeDump.map((e) => e[0])]);
        let copied = 0;
        for (const key of keys) {
          const ok = await withLock(key, async () => {
            const [theirs, mine] = [await entryOf(peer, key), await entryOf(node, key)];
            if (theirs === undefined || mine === undefined) return false;
            if (theirs && (!mine || theirs.version > mine.version)) {
              copied++;
              return copyEntry(node, key, theirs);
            }
            if (mine && (!theirs || mine.version > theirs.version)) {
              copied++;
              return copyEntry(peer, key, mine);
            }
            return true;
          });
          if (!ok) return; // stay "syncing"; the next heartbeat retries
        }
        console.log(`reconciled ${node.id} with ${peer.id}: ${copied} of ${keys.size} keys differed`);
      } else {
        console.log(`${node.id} has no reachable peer, serving its own data`);
      }
      if (registry.markSynced(node.id, bootId)) console.log(`node ${node.id} is up`);
    } catch (err) {
      console.error(`sync of ${node.id} failed: ${String(err)}`);
    } finally {
      syncing.delete(node.id);
    }
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
      const node = registry.get(id);
      if (node && !syncing.has(id)) {
        console.log(`node ${id} is back, reconciling`);
        void syncNode(node);
      }
    }
    res.json({ ok: true, recovered });
  });

  // ---- data API (used by the services, not meant for browsers) ----

  app.put("/internal/data/:key", async (req, res) => {
    const key = req.params.key;
    if (req.body === undefined) {
      res.status(400).json({ error: "JSON body required" });
      return;
    }
    const shard = shardFor(key, registry.shardCount());
    const result = await withLock(key, () => writeEntry(shard, key, req.body));
    if (!result.ok) {
      res.status(503).json({ error: `no replica of shard ${shard} accepted the write` });
      return;
    }
    res.json({ ok: true, shard, replicasWritten: result.replicas, version: result.version });
  });

  app.get("/internal/data/:key", async (req, res) => {
    const key = req.params.key;
    const shard = shardFor(key, registry.shardCount());
    const entry = await readEntry(shard, key);
    if (entry === "missing") {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (entry === "unavailable") {
      res.status(503).json({ error: `no live node of shard ${shard} could serve the read` });
      return;
    }
    res.set("x-version", String(entry.version));
    res.json(entry.value);
  });

  // Compare-and-set: succeeds only if the key is still at expectedVersion (null = must not exist).
  app.post("/internal/cas/:key", async (req, res) => {
    const key = req.params.key;
    const { expectedVersion, value } = req.body ?? {};
    if (value === undefined || !(expectedVersion === null || typeof expectedVersion === "number")) {
      res.status(400).json({ error: "expectedVersion (number or null) and value are required" });
      return;
    }
    const shard = shardFor(key, registry.shardCount());
    const outcome = await withLock(key, async () => {
      const current = await readEntry(shard, key);
      if (current === "unavailable") return { code: 503 as const };
      const currentVersion = current === "missing" ? null : current.version;
      if (currentVersion !== expectedVersion) return { code: 409 as const, currentVersion };
      const written = await writeEntry(shard, key, value);
      return written.ok ? { code: 200 as const, version: written.version } : { code: 503 as const };
    });
    if (outcome.code === 200) res.json({ ok: true, version: outcome.version });
    else if (outcome.code === 409) res.status(409).json({ error: "version mismatch", currentVersion: outcome.currentVersion });
    else res.status(503).json({ error: `shard ${shard} unavailable` });
  });

  // Lists all keys with a prefix, across every shard.
  app.get("/internal/list", async (req, res) => {
    const prefix = typeof req.query.prefix === "string" ? req.query.prefix : "";
    const found: Array<{ key: string; value: unknown; version: number }> = [];
    for (let shard = 0; shard < registry.shardCount(); shard++) {
      let answered = false;
      for (const node of registry.liveNodes(shard)) {
        const dump = await dumpOf(node);
        if (!dump) continue;
        for (const [key, value, version] of dump) {
          if (key.startsWith(prefix)) found.push({ key, value, version });
        }
        answered = true;
        break;
      }
      if (!answered) {
        res.status(503).json({ error: `shard ${shard} unavailable` });
        return;
      }
    }
    res.json(found);
  });

  app.get("/health", (_req, res) => {
    const nodes = registry.statuses();
    const shards = Array.from({ length: registry.shardCount() }, (_, shard) => ({
      shard,
      live: registry.liveNodes(shard).length,
      total: nodes.filter((n) => n.shard === shard).length,
    }));
    res.json({ ok: shards.every((s) => s.live > 0), nodes, shards });
  });

  app.get("/", (_req, res) => res.json({ service: "coordinator", health: "/health" }));

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? "internal error" : "bad request" });
  });

  return app;
}
