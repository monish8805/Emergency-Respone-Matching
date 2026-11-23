import express from "express";
import { httpErrorMessage, isTombstone, shardFor, TOMBSTONE, type NodeConfig } from "@emergency/shared";
import type { NodeRegistry } from "./nodes";

type Entry = { value: unknown; version: number };

export interface CoordinatorOptions {
  // With several coordinators only one (the leader) may handle data. Defaults to always true.
  isLeader?: () => boolean;
}

export function createCoordinatorApp(registry: NodeRegistry, { isLeader = () => true }: CoordinatorOptions = {}) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // A coordinator that is not the leader answers nothing under /internal: its in-memory locks and
  // node health would be a second, conflicting view. Kubernetes also keeps it out of the Service
  // (the /ready probe fails), so callers normally never reach it.
  app.use("/internal", (_req, res, next) => {
    if (isLeader()) return next();
    res.status(503).json({ error: "not the leader" });
  });

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

  // Versions follow the clock and only ever go up while this process runs. After a restart
  // the clock may be behind versions already stored: writeEntry notices when a node refuses a
  // write as stale and jumps past the newer version, so a write is never silently lost.
  let lastVersion = 0;
  const nextVersion = (atLeast = 0) => (lastVersion = Math.max(lastVersion + 1, Date.now(), atLeast));

  // ---- single-key operations ----

  // Quorum read: ask every node that is up, require a majority of the shard to have answered, and
  // take the newest version. A majority always overlaps the majority that acknowledged the latest
  // write, so the newest acknowledged value is never missed, even with a minority of nodes down.
  async function readEntry(shard: number, key: string): Promise<Entry | "missing" | "unavailable"> {
    const targets = registry.liveNodes(shard);
    if (targets.length < registry.quorum(shard)) return "unavailable";
    const answers = await Promise.all(
      targets.map(async (node): Promise<Entry | null | undefined> => {
        const r = await call(node, "GET", `/internal/data/${encodeURIComponent(key)}`);
        if (!r) return undefined;
        if (r.status === 404) return null;
        if (r.ok) return { value: await r.json(), version: Number(r.headers.get("x-version") ?? 0) };
        registry.markDown(node.id);
        return undefined;
      }),
    );
    const answered = answers.filter((a): a is Entry | null => a !== undefined);
    if (answered.length < registry.quorum(shard)) return "unavailable";
    let newest: Entry | undefined;
    for (const a of answered) if (a && (!newest || a.version > newest.version)) newest = a;
    // A tombstone is the newest version: the key was deleted.
    if (!newest || isTombstone(newest.value)) return "missing";
    return newest;
  }

  // Writes to every node of the shard that is alive (including nodes catching up). The write only
  // counts as done when a majority of the shard accepted it; otherwise the caller gets a 503 (a
  // minority may still hold the value, which is why creates carry an idempotency key).
  // A node answers { applied: false, version } when it already holds a NEWER version, which means
  // our version is too low (clock behind after a restart). Then we move past it and write again,
  // instead of reporting success for a write that was thrown away.
  async function writeEntry(
    shard: number,
    key: string,
    value: unknown,
    atLeast = 0,
  ): Promise<{ ok: boolean; replicas: number; version: number }> {
    const targets = registry.writeNodes(shard);
    // Not enough nodes to ever reach a majority: refuse before sending anything, so a write that is
    // going to be answered 503 is not left behind on the one node that was reachable.
    if (targets.length < registry.quorum(shard)) return { ok: false, replicas: 0, version: lastVersion };
    let minimum = atLeast;
    for (let attempt = 0; attempt < 3; attempt++) {
      const version = nextVersion(minimum);
      const results = await Promise.all(
        targets.map((n) =>
          call(n, "PUT", `/internal/data/${encodeURIComponent(key)}`, value, { "x-version": String(version) }),
        ),
      );
      let accepted = 0;
      let newest = 0;
      for (const [i, r] of results.entries()) {
        if (!r?.ok) {
          registry.markDown(targets[i].id);
          continue;
        }
        const reply = (await r.json().catch(() => ({}))) as { applied?: boolean; version?: number };
        if (reply.applied === false) newest = Math.max(newest, Number(reply.version) || 0);
        else accepted++;
      }
      if (newest === 0) return { ok: accepted >= registry.quorum(shard), replicas: accepted, version };
      console.warn(`write to ${key} was older than stored version ${newest}, retrying above it`);
      minimum = newest + 1;
    }
    return { ok: false, replicas: 0, version: lastVersion };
  }

  // ---- resync ----
  // Brings a recovered node and its peer to the same data. For each key the copy with the
  // higher version wins, in both directions, one key at a time under that key's lock, so a
  // write that arrives mid-sync can never be overwritten by an older copy.
  const syncing = new Set<string>();

  async function dumpOf(node: NodeConfig, prefix = ""): Promise<Array<[string, unknown, number]> | null> {
    const r = await call(node, "GET", `/internal/dump${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ""}`);
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
      // Reconcile with every reachable node of the shard, not just one: the newest copy of each
      // key wins and is pushed to all the others.
      const peers: NodeConfig[] = [];
      const keys = new Set<string>();
      for (const peer of registry.peersOf(node.id)) {
        const dump = await dumpOf(peer);
        if (!dump) continue;
        peers.push(peer);
        for (const e of dump) keys.add(e[0]);
      }
      if (peers.length > 0) {
        const nodeDump = await dumpOf(node);
        if (!nodeDump) return; // node is unreachable; it stays out until its next heartbeat
        for (const e of nodeDump) keys.add(e[0]);
        const group = [node, ...peers];
        let copied = 0;
        for (const key of keys) {
          const ok = await withLock(key, async () => {
            const entries = await Promise.all(group.map((n) => entryOf(n, key)));
            if (entries.some((e) => e === undefined)) return false;
            let best: Entry | undefined;
            for (const e of entries) if (e && (!best || e.version > best.version)) best = e;
            if (!best) return true;
            for (const [i, e] of entries.entries()) {
              if (e && e.version >= best.version) continue;
              copied++;
              if (!(await copyEntry(group[i], key, best))) return false;
            }
            return true;
          });
          if (!ok) return; // stay "syncing"; the next heartbeat retries
        }
        console.log(`reconciled ${node.id} with ${peers.map((p) => p.id).join(", ")}: ${copied} copies of ${keys.size} keys`);
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

  // Delete = write a tombstone one version above the current value, under the key's lock and with
  // the same quorum rules as any write. 404 if the key does not exist (or is already deleted).
  app.delete("/internal/data/:key", async (req, res) => {
    const key = req.params.key;
    const shard = shardFor(key, registry.shardCount());
    const outcome = await withLock(key, async () => {
      const current = await readEntry(shard, key);
      if (current === "unavailable") return { code: 503 as const };
      if (current === "missing") return { code: 404 as const };
      const written = await writeEntry(shard, key, TOMBSTONE, current.version + 1);
      return written.ok ? { code: 200 as const, written } : { code: 503 as const };
    });
    if (outcome.code === 200) res.json({ ok: true, shard, replicasWritten: outcome.written.replicas, version: outcome.written.version });
    else if (outcome.code === 404) res.status(404).json({ error: "not found" });
    else res.status(503).json({ error: `shard ${shard} unavailable` });
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
      const written = await writeEntry(shard, key, value, (currentVersion ?? 0) + 1);
      return written.ok ? { code: 200 as const, version: written.version } : { code: 503 as const };
    });
    if (outcome.code === 200) res.json({ ok: true, version: outcome.version });
    else if (outcome.code === 409) res.status(409).json({ error: "version mismatch", currentVersion: outcome.currentVersion });
    else res.status(503).json({ error: `shard ${shard} unavailable` });
  });

  // Lists all keys with a prefix, across every shard. Each shard answers from a majority of its
  // nodes and the newest version of every key wins.
  app.get("/internal/list", async (req, res) => {
    const prefix = typeof req.query.prefix === "string" ? req.query.prefix : "";
    const found: Array<{ key: string; value: unknown; version: number }> = [];
    for (let shard = 0; shard < registry.shardCount(); shard++) {
      const nodes = registry.liveNodes(shard);
      // The node applies the prefix itself, so only matching records cross the network.
      const dumps = (await Promise.all(nodes.map((n) => dumpOf(n, prefix)))).filter((d) => d !== null);
      if (dumps.length < registry.quorum(shard)) {
        res.status(503).json({ error: `shard ${shard} unavailable` });
        return;
      }
      const newest = new Map<string, { key: string; value: unknown; version: number }>();
      for (const dump of dumps) {
        for (const [key, value, version] of dump) {
          const have = newest.get(key);
          if (!have || version > have.version) newest.set(key, { key, value, version });
        }
      }
      found.push(...[...newest.values()].filter((e) => !isTombstone(e.value)));
    }
    res.json(found);
  });

  app.get("/health", (_req, res) => {
    const nodes = registry.statuses();
    const shards = Array.from({ length: registry.shardCount() }, (_, shard) => ({
      shard,
      live: registry.liveNodes(shard).length,
      total: nodes.filter((n) => n.shard === shard).length,
      quorum: registry.quorum(shard),
    }));
    res.json({ ok: shards.every((s) => s.live >= s.quorum), leader: isLeader(), nodes, shards });
  });

  // Readiness: only the leader is ready, so the Kubernetes Service sends traffic (and the storage
  // nodes' heartbeats) to exactly one coordinator. Liveness stays /health.
  app.get("/ready", (_req, res) => {
    res.status(isLeader() ? 200 : 503).json({ leader: isLeader() });
  });

  app.get("/", (_req, res) => res.json({ service: "coordinator", health: "/health" }));

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: httpErrorMessage(status, "1mb") });
  });

  return app;
}
