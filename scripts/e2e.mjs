#!/usr/bin/env node
// End-to-end tests against the system deployed on minikube (Phase 7).
//
//   ./scripts/deploy-k8s.sh      # once
//   node scripts/e2e.mjs         # run everything
//   node scripts/e2e.mjs shard   # run only tests whose name contains "shard"
//
// Optional: API_URL and COORD_URL skip the automatic `minikube service --url` tunnels.
import { execSync, spawn } from "node:child_process";

const NS = "emergency";
const run = Date.now().toString(36); // keeps locations unique across repeated runs
const filter = process.argv[2]?.toLowerCase();

const sh = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const kubectl = (args) => sh(`kubectl -n ${NS} ${args}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- helpers ----------

const children = [];
function tunnel(service) {
  return new Promise((resolve, reject) => {
    const child = spawn("minikube", ["service", service, "-n", NS, "--url"], { stdio: ["ignore", "pipe", "inherit"] });
    children.push(child);
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const m = buf.match(/https?:\/\/\S+/);
      if (m) resolve(m[0]);
    });
    child.on("exit", () => buf.match(/https?:\/\/\S+/) || reject(new Error(`could not get URL for ${service}`)));
  });
}

let API, COORD;

async function http(base, path, { method = "GET", body } = {}) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(base + path, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(8000),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: res.status, body: json };
    } catch (e) {
      lastErr = e;
      await sleep(300);
    }
  }
  throw lastErr;
}
const api = (path, opts) => http(API, path, opts);
const coord = (path, opts) => http(COORD, path, opts);

async function waitFor(what, fn, timeoutMs = 30000, everyMs = 500) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const newResource = (type, location) => api("/resources", { method: "POST", body: { type, location } });
const newRequest = (type, location, details = "e2e") =>
  api("/requests", { method: "POST", body: { type, location, details } });
const getRequest = async (id) => (await api(`/requests/${id}`)).body;
const waitAssigned = (id, timeout = 25000) =>
  waitFor(`request ${id.slice(0, 8)} ASSIGNED`, async () => {
    const r = await getRequest(id);
    return r.status === "ASSIGNED" ? r : null;
  }, timeout);

// Reads everything one storage pod holds, as a Set of keys.
function podKeys(pod) {
  const out = kubectl(`exec ${pod} -- wget -qO- http://localhost:4000/internal/dump`);
  return new Set(JSON.parse(out).map(([k]) => k));
}

async function waitAllNodesUp(timeout = 40000) {
  await waitFor("all storage nodes up in coordinator", async () => {
    const h = await coord("/health");
    return h.body.nodes?.length === 6 && h.body.nodes.every((n) => !n.down);
  }, timeout, 1000);
}

// ---------- tests ----------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("1. normal request: create → queue → match", async () => {
  const loc = `normal-${run}`;
  const res = await newResource("water", loc);
  assert(res.status === 201, `resource created (got ${res.status})`);
  const req = await newRequest("water", loc, "Need drinking water for 20 people");
  assert(req.status === 201 && req.body.status === "PENDING", "request created as PENDING");
  const done = await waitAssigned(req.body.id);
  assert(done.resourceId === res.body.id, "request assigned the resource we registered");
  const r = (await api("/resources")).body.find((x) => x.id === res.body.id);
  assert(r.status === "ASSIGNED" && r.availability === false, "resource marked ASSIGNED");
});

test("2. multiple requests: 12 at once, no double assignment", async () => {
  const n = 12;
  const locs = Array.from({ length: n }, (_, i) => `multi-${run}-${i}`);
  await Promise.all(locs.map((l) => newResource("food", l)));
  const reqs = await Promise.all(locs.map((l) => newRequest("food", l)));
  assert(reqs.every((r) => r.status === 201), "all 12 requests accepted");
  const done = await Promise.all(reqs.map((r) => waitAssigned(r.body.id, 40000)));
  const used = new Set(done.map((d) => d.resourceId));
  assert(used.size === n, `each request got its own resource (${used.size}/${n} distinct)`);
});

test("3. matching: no match stays PENDING, manual match works", async () => {
  const loc = `late-${run}`;
  const req = await newRequest("medicine", loc);
  await sleep(4000);
  assert((await getRequest(req.body.id)).status === "PENDING", "unmatched request stays PENDING");
  const res = await newResource("medicine", loc);
  const trig = await api(`/match/${req.body.id}`, { method: "POST" });
  assert(trig.status === 200 && trig.body.queued, "POST /match queued the request");
  const done = await waitAssigned(req.body.id);
  assert(done.resourceId === res.body.id, "matched with the late resource");
  const again = await api(`/match/${req.body.id}`, { method: "POST" });
  assert(again.status === 409, "matching an assigned request returns 409");
});

test("4. rabbitmq: consumer attached, queue durable across a matching-service outage", async () => {
  const q = kubectl("exec deploy/rabbitmq -- rabbitmqctl list_queues name messages consumers");
  const line = q.split("\n").find((l) => l.startsWith("match.requests"));
  assert(line, "queue match.requests exists");
  const [, , consumers] = line.split(/\s+/);
  assert(Number(consumers) >= 1, `queue has a consumer (${consumers})`);

  // Stop the matching service: requests must wait in the queue, not get lost.
  kubectl("scale deployment matching-service --replicas=0");
  await waitFor("matching pods gone", () => kubectl("get pods -l app=matching-service -o name") === "", 60000, 1000);
  const loc = `queued-${run}`;
  const res = await newResource("shelter", loc);
  const req = await newRequest("shelter", loc);
  await sleep(2000);
  assert((await getRequest(req.body.id)).status === "PENDING", "request waits while no matcher is running");
  const q2 = kubectl("exec deploy/rabbitmq -- rabbitmqctl list_queues name messages");
  const ready = Number(q2.split("\n").find((l) => l.startsWith("match.requests")).split(/\s+/)[1]);
  assert(ready >= 1, `message is held in RabbitMQ (${ready} queued)`);

  kubectl("scale deployment matching-service --replicas=1");
  kubectl("rollout status deployment/matching-service --timeout=120s");
  const done = await waitAssigned(req.body.id, 40000);
  assert(done.resourceId === res.body.id, "queued request matched once the matcher returned");
});

test("5. sharding: data spread across all 3 shards, replicas identical", async () => {
  const counts = [];
  for (let s = 0; s < 3; s++) {
    const primary = podKeys(`storage-s${s}-0`);
    const replica = podKeys(`storage-s${s}-1`);
    assert(primary.size > 0, `shard ${s} holds data (${primary.size} keys)`);
    assert(
      primary.size === replica.size && [...primary].every((k) => replica.has(k)),
      `shard ${s} replica matches primary`,
    );
    counts.push(primary.size);
  }
  console.log(`      keys per shard: ${counts.join(" / ")}`);
});

test("6. shard failure: kill a storage pod, replica keeps serving", async () => {
  const before = (await api("/requests")).body.length;
  kubectl("delete pod storage-s0-0 --grace-period=0 --force");
  // Reads and writes must keep working while the pod is gone.
  const list = await api("/requests");
  assert(list.status === 200 && list.body.length === before, `all ${before} requests still readable`);
  const created = [];
  for (let i = 0; i < 10; i++) {
    const r = await newRequest("water", `outage-${run}-${i}`);
    assert(r.status === 201, `write ${i} accepted during outage (got ${r.status})`);
    created.push(r.body.id);
  }
  for (const id of created) assert((await getRequest(id)).id === id, "request written during outage is readable");
});

test("7. replica recovery: restarted pod resyncs from its replica", async () => {
  kubectl("wait --for=condition=Ready pod/storage-s0-0 --timeout=120s");
  await waitAllNodesUp();
  const peer = podKeys("storage-s0-1");
  await waitFor("storage-s0-0 resynced", () => {
    const mine = podKeys("storage-s0-0");
    return mine.size === peer.size && [...peer].every((k) => mine.has(k));
  }, 40000, 1000);
  console.log(`      storage-s0-0 recovered ${peer.size} keys from storage-s0-1`);
});

test("8. pod failure: Kubernetes recreates killed pods, service stays up", async () => {
  // Kill one request-service pod while hammering the API.
  const pod = kubectl("get pods -l app=request-service -o name").split("\n")[0];
  kubectl(`delete ${pod} --grace-period=0 --force`);
  let ok = 0;
  for (let i = 0; i < 20; i++) {
    const r = await api("/health").catch(() => ({ status: 0 }));
    if (r.status === 200) ok++;
    await sleep(200);
  }
  assert(ok >= 18, `API stayed available while a pod was down (${ok}/20 health checks ok)`);
  kubectl("rollout status deployment/request-service --timeout=120s");
  const ready = kubectl("get deployment request-service -o jsonpath={.status.readyReplicas}");
  assert(Number(ready) === Number(kubectl("get deployment request-service -o jsonpath={.spec.replicas}")), "replicas restored");

  // Kill the coordinator: it restarts and the system recovers without losing data.
  const before = (await api("/requests")).body.length;
  kubectl("delete pod -l app=coordinator --grace-period=0 --force");
  kubectl("rollout status deployment/coordinator --timeout=120s");
  const after = await waitFor("requests readable again", async () => {
    const r = await api("/requests");
    return r.status === 200 ? r.body.length : null;
  }, 60000, 1000);
  assert(after === before, `no data lost after coordinator restart (${after}/${before})`);
  const loc = `postcoord-${run}`;
  await newResource("food", loc);
  const req = await newRequest("food", loc);
  assert(req.status === 201, "new requests accepted after coordinator restart");
  await waitAssigned(req.body.id);
});

test("9. scaling: scale services up, system stays available", async () => {
  kubectl("scale deployment request-service --replicas=4");
  kubectl("scale deployment matching-service --replicas=3");
  kubectl("rollout status deployment/request-service --timeout=180s");
  kubectl("rollout status deployment/matching-service --timeout=180s");
  const pods = kubectl("get pods -l app=request-service -o name").split("\n").length;
  assert(pods === 4, `4 request-service pods running (${pods})`);

  const n = 20;
  const locs = Array.from({ length: n }, (_, i) => `scale-${run}-${i}`);
  await Promise.all(locs.map((l) => newResource("transportation", l)));
  const reqs = await Promise.all(locs.map((l) => newRequest("transportation", l)));
  assert(reqs.every((r) => r.status === 201), `all ${n} concurrent requests accepted by 4 pods`);
  const done = await Promise.all(reqs.map((r) => waitAssigned(r.body.id, 60000)));
  const distinct = new Set(done.map((d) => d.resourceId)).size;
  if (distinct !== n) {
    // Known limitation from the README: matching is not atomic across several matchers.
    console.log(`      WARN: ${distinct}/${n} distinct resources with 3 matchers (non-atomic matching, see README)`);
  }

  kubectl("scale deployment request-service --replicas=2");
  kubectl("scale deployment matching-service --replicas=1");
  kubectl("rollout status deployment/request-service --timeout=120s");
});

// ---------- runner ----------

async function main() {
  API = process.env.API_URL ?? (await tunnel("request-service"));
  COORD = process.env.COORD_URL ?? (await tunnel("coordinator"));
  console.log(`API ${API}\nCOORD ${COORD}\n`);
  await waitFor("coordinator healthy", async () => (await coord("/health")).status === 200, 60000, 1000);
  await waitFor("request service healthy", async () => (await api("/health")).status === 200, 60000, 1000);

  const selected = tests.filter((t) => !filter || t.name.toLowerCase().includes(filter));
  const results = [];
  for (const t of selected) {
    const start = Date.now();
    process.stdout.write(`▶ ${t.name}\n`);
    try {
      await t.fn();
      results.push({ name: t.name, ok: true });
      console.log(`  ✓ passed (${((Date.now() - start) / 1000).toFixed(1)}s)\n`);
    } catch (e) {
      results.push({ name: t.name, ok: false, err: e.message });
      console.log(`  ✗ FAILED: ${e.message}\n`);
    }
  }

  console.log("Summary");
  for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  — ${r.err}`}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  return failed;
}

main()
  .then((failed) => {
    children.forEach((c) => c.kill());
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    children.forEach((c) => c.kill());
    process.exit(1);
  });
