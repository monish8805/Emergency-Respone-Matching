import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { shardFor, type NodeConfig } from "@emergency/shared";
import { createStorageApp } from "../../storage-node/src/app";
import { createCoordinatorApp } from "../src/app";
import { NodeRegistry } from "../src/nodes";

// These tests run the real coordinator against six real storage servers over HTTP
// (3 shards, each with a primary and a replica). Nothing is mocked.

interface Storage {
  config: NodeConfig;
  server: Server;
  data: Map<string, { value: unknown; version: number }>;
  bootId: string;
}

let storages: Storage[] = [];
let coordinator: ReturnType<typeof createCoordinatorApp>;
let registry: NodeRegistry;
let bootCounter = 0;

function listen(app: import("express").Express, port = 0): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(port, () => resolve(server));
  });
}

const stop = (server: Server) =>
  new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });

async function startStorage(id: string, shard: number, port = 0): Promise<Storage> {
  const { app, data } = createStorageApp(id, shard);
  const server = await listen(app, port);
  const actualPort = (server.address() as AddressInfo).port;
  return {
    config: { id, shard, url: `http://127.0.0.1:${actualPort}` },
    server,
    data,
    bootId: `boot-${++bootCounter}`,
  };
}

const heartbeat = (s: Storage) =>
  request(coordinator).post("/internal/nodes/heartbeat").send({ id: s.config.id, bootId: s.bootId });

async function waitUntil(what: string, fn: () => Promise<boolean> | boolean, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const statusOf = (id: string) => registry.statusOf(id);
const primaryOf = (shard: number) => storages.find((s) => s.config.shard === shard && s.config.id.endsWith("-primary"))!;
const replicaOf = (shard: number) => storages.find((s) => s.config.shard === shard && s.config.id.endsWith("-replica"))!;

function putKey(key: string, value: unknown) {
  return request(coordinator).put(`/internal/data/${encodeURIComponent(key)}`).send(value as object);
}
const getKey = (key: string) => request(coordinator).get(`/internal/data/${encodeURIComponent(key)}`);

beforeEach(async () => {
  storages = [];
  for (let shard = 0; shard < 3; shard++) {
    storages.push(await startStorage(`s${shard}-primary`, shard));
    storages.push(await startStorage(`s${shard}-replica`, shard));
  }
  registry = new NodeRegistry(
    storages.map((s) => s.config),
    60_000,
  );
  coordinator = createCoordinatorApp(registry);
  for (const s of storages) await heartbeat(s);
  await waitUntil("all nodes up", () => storages.every((s) => statusOf(s.config.id) === "up"));
});

afterEach(async () => {
  await Promise.all(storages.map((s) => stop(s.server)));
});

describe("sharding and replication", () => {
  it("routes every key to hash(key) mod 3 and stores it only there", async () => {
    const keys = Array.from({ length: 30 }, (_, i) => `request:key-${i}`);
    for (const key of keys) await putKey(key, { key }).expect(200);

    const usedShards = new Set<number>();
    for (const key of keys) {
      const shard = shardFor(key, 3);
      usedShards.add(shard);
      for (const s of storages) {
        expect(s.data.has(key), `${key} on ${s.config.id}`).toBe(s.config.shard === shard);
      }
    }
    expect(usedShards.size).toBe(3);
  });

  it("writes each key to both the primary and the replica with the same version", async () => {
    const key = "resource:replicated";
    const shard = shardFor(key, 3);
    const res = await putKey(key, { v: 1 }).expect(200);
    expect(res.body.replicasWritten).toBe(2);
    const [p, r] = [primaryOf(shard).data.get(key)!, replicaOf(shard).data.get(key)!];
    expect(p.value).toEqual({ v: 1 });
    expect(r).toEqual(p);
  });

  it("reads data back through the coordinator with its version", async () => {
    await putKey("request:abc", { status: "PENDING" });
    const res = await getKey("request:abc").expect(200);
    expect(res.body).toEqual({ status: "PENDING" });
    expect(Number(res.headers["x-version"])).toBeGreaterThan(0);
    await getKey("request:missing").expect(404);
  });

  it("lists keys by prefix across all shards, with versions", async () => {
    for (let i = 0; i < 12; i++) await putKey(`request:l-${i}`, { i });
    await putKey("resource:other", { x: 1 });
    const res = await request(coordinator).get("/internal/list").query({ prefix: "request:" }).expect(200);
    expect(res.body).toHaveLength(12);
    expect(res.body.every((e: { version: number }) => e.version > 0)).toBe(true);
  });
});

describe("compare-and-set", () => {
  it("lets exactly one of many concurrent claims win", async () => {
    const key = "resource:contested";
    await putKey(key, { status: "AVAILABLE" });
    const { headers } = await getKey(key);
    const version = Number(headers["x-version"]);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        request(coordinator).post(`/internal/cas/${encodeURIComponent(key)}`).send({
          expectedVersion: version,
          value: { status: "ASSIGNED", by: i },
        }),
      ),
    );
    const winners = results.filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    const final = await getKey(key);
    expect(final.body.by).toBe(results.findIndex((r) => r.status === 200));
  });

  it("creates a key only if it does not exist yet", async () => {
    const url = `/internal/cas/${encodeURIComponent("request:new")}`;
    await request(coordinator).post(url).send({ expectedVersion: null, value: { n: 1 } }).expect(200);
    await request(coordinator).post(url).send({ expectedVersion: null, value: { n: 2 } }).expect(409);
    expect((await getKey("request:new")).body).toEqual({ n: 1 });
  });

  it("serializes concurrent plain writes so replicas never disagree", async () => {
    const key = "request:race";
    const shard = shardFor(key, 3);
    await Promise.all(Array.from({ length: 25 }, (_, i) => putKey(key, { i })));
    expect(replicaOf(shard).data.get(key)).toEqual(primaryOf(shard).data.get(key));
  });
});

describe("failure detection and replica fallback", () => {
  it("keeps serving reads and writes from the replica when the primary dies", async () => {
    const key = "request:failover";
    const shard = shardFor(key, 3);
    await putKey(key, { v: "before" });

    await stop(primaryOf(shard).server);

    expect((await getKey(key).expect(200)).body).toEqual({ v: "before" });
    const write = await putKey(key, { v: "during" }).expect(200);
    expect(write.body.replicasWritten).toBe(1);
    expect((await getKey(key)).body).toEqual({ v: "during" });
    expect(statusOf(primaryOf(shard).config.id)).toBe("down");
  });

  it("keeps serving when a replica dies", async () => {
    const key = "request:replica-down";
    const shard = shardFor(key, 3);
    await putKey(key, { v: 1 });
    await stop(replicaOf(shard).server);
    expect((await getKey(key).expect(200)).body).toEqual({ v: 1 });
    await putKey(key, { v: 2 }).expect(200);
    expect((await getKey(key)).body).toEqual({ v: 2 });
  });

  it("reports 503 when both nodes of a shard are gone", async () => {
    const key = "request:total-loss";
    const shard = shardFor(key, 3);
    await putKey(key, { v: 1 });
    await stop(primaryOf(shard).server);
    await stop(replicaOf(shard).server);
    await getKey(key).expect(503);
    await putKey(key, { v: 2 }).expect(503);
  });

  it("detects a missing heartbeat as a failure", () => {
    let now = 0;
    const reg = new NodeRegistry([{ id: "x", shard: 0, url: "http://x" }], 6000, () => now);
    reg.heartbeat("x", "b");
    reg.markSynced("x", "b");
    now = 5000;
    expect(reg.checkTimeouts()).toEqual([]);
    now = 7000;
    expect(reg.checkTimeouts()).toEqual(["x"]);
  });

  it("exposes node and shard health", async () => {
    await stop(primaryOf(1).server);
    await getKey(`request:poke-${Math.random()}`); // any call touching the dead node marks it down
    for (let i = 0; i < 20 && statusOf("s1-primary") !== "down"; i++) {
      await request(coordinator).get("/internal/list").query({ prefix: "x" });
    }
    const res = await request(coordinator).get("/health").expect(200);
    expect(res.body.nodes).toHaveLength(6);
    expect(res.body.nodes.find((n: { id: string }) => n.id === "s1-primary").down).toBe(true);
    expect(res.body.shards[1]).toEqual({ shard: 1, live: 1, total: 2 });
    expect(res.body.ok).toBe(true);
  });
});

describe("recovery and synchronization", () => {
  it("resyncs a restarted, empty node from its replica, including writes made during the outage", async () => {
    const shard = 0;
    const keys = Array.from({ length: 40 }, (_, i) => `request:r-${i}`).filter((k) => shardFor(k, 3) === shard);
    expect(keys.length).toBeGreaterThan(3);
    const [before, during] = [keys.slice(0, 2), keys.slice(2)];
    for (const k of before) await putKey(k, { k, phase: "before" });

    const old = primaryOf(shard);
    const port = Number(new URL(old.config.url).port);
    await stop(old.server);
    for (const k of during) await putKey(k, { k, phase: "during" }).expect(200);

    // The node restarts with no data (memory-only) and a new bootId.
    const fresh = await startStorage(old.config.id, shard, port);
    storages[storages.indexOf(old)] = fresh;
    await heartbeat(fresh);
    await waitUntil("node back up", () => statusOf(fresh.config.id) === "up");

    for (const k of keys) expect(fresh.data.has(k), `${k} restored`).toBe(true);
    expect(fresh.data.get(during[0])!.value).toEqual({ k: during[0], phase: "during" });
  });

  it("does not serve reads from a recovering node until it has caught up", async () => {
    const key = "request:syncing";
    const shard = shardFor(key, 3);
    await putKey(key, { v: 1 });
    const old = primaryOf(shard);
    const port = Number(new URL(old.config.url).port);
    await stop(old.server);
    await putKey(key, { v: 2 }).expect(200);

    const fresh = await startStorage(old.config.id, shard, port);
    storages[storages.indexOf(old)] = fresh;
    // Registered but not yet reconciled: it is empty, so it must not answer reads.
    registry.heartbeat(fresh.config.id, fresh.bootId);
    expect(statusOf(fresh.config.id)).toBe("syncing");
    expect((await getKey(key).expect(200)).body).toEqual({ v: 2 });
  });

  it("does not let an older copy overwrite a newer one during sync", async () => {
    const key = "request:newer-wins";
    const shard = shardFor(key, 3);
    await putKey(key, { v: "old" });
    const [p, r] = [primaryOf(shard), replicaOf(shard)];

    // The replica alone saw a later write (e.g. it took writes while the primary was away).
    const newer = { value: { v: "newer" }, version: Date.now() + 100_000 };
    r.data.set(key, newer);

    // Primary restarts and reconciles with the replica: the newer copy must win everywhere.
    registry.markDown(p.config.id);
    p.bootId = `boot-${++bootCounter}`;
    await heartbeat(p);
    await waitUntil("primary up", () => statusOf(p.config.id) === "up");
    expect(p.data.get(key)).toEqual(newer);
    expect(r.data.get(key)).toEqual(newer);
  });

  it("brings a node back after a transient outage with the same process (no data loss)", async () => {
    const key = "request:transient";
    const shard = shardFor(key, 3);
    const p = primaryOf(shard);
    await putKey(key, { v: 1 });
    registry.markDown(p.config.id); // coordinator lost contact, node kept running
    await putKey(key, { v: 2 }).expect(200); // goes to the replica only
    expect(p.data.get(key)!.value).toEqual({ v: 1 }); // primary is now stale
    await heartbeat(p);
    await waitUntil("primary up", () => statusOf(p.config.id) === "up");
    expect(p.data.get(key)!.value).toEqual({ v: 2 });
  });
});
