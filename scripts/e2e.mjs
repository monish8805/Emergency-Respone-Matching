#!/usr/bin/env node
// End-to-end tests against the running system. Real services, real HTTP, real failures.
//
//   MODE=compose node scripts/e2e.mjs            # docker compose stack (default API http://localhost:3005)
//   node scripts/e2e.mjs                         # minikube (MODE=k8s)
//   node scripts/e2e.mjs shard                   # only tests whose name contains "shard"
//
// Env: MODE=compose|k8s, API_URL (skip the minikube tunnel), NS (k8s namespace, default "emergency").
import { execSync, spawn } from "node:child_process";

const MODE = process.env.MODE ?? "k8s";
const NS = process.env.NS ?? "emergency";
const run = Date.now().toString(36); // keeps locations unique across repeated runs
const filter = process.argv[2]?.toLowerCase();

const sh = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- platform adapter: the only place that knows compose from kubernetes ----------

const k = (args) => sh(`kubectl -n ${NS} ${args}`);
const c = (args) => sh(`docker compose ${args}`);

const platform =
  MODE === "compose"
    ? {
        name: "docker compose",
        // Three nodes per shard (index 0..2); any two are a quorum.
        storage: (shard, i) => `storage-s${shard}-${"abc"[i]}`,
        exec: (svc, cmd) => c(`exec -T ${svc} ${cmd}`),
        kill: (svc) => c(`kill ${svc}`),
        // `docker kill` counts as a manual stop, so the restart policy does NOT bring the container
        // back (a crash does). Start it explicitly.
        recover: (svc) => c(`start ${svc}`),
        waitReady: (svc) => waitHealthyCompose(svc),
        stop: (svc) => c(`stop ${svc}`),
        start: (svc) => c(`start ${svc}`),
        rabbit: "rabbitmq",
        matching: "matching-service",
        stopMatching: () => c("stop matching-service"),
        startMatching: () => c("start matching-service"),
        killApi: () => c("kill request-service"),
        recoverApi: () => c("start request-service"),
        canScale: false,
      }
    : {
        name: "kubernetes",
        storage: (shard, i) => `storage-s${shard}-${i}`,
        exec: (pod, cmd) => k(`exec ${pod} -- ${cmd}`),
        kill: (pod) => k(`delete pod ${pod} --grace-period=0 --force`),
        recover: () => "", // the StatefulSet recreates it by itself
        waitReady: (pod) => k(`wait --for=condition=Ready pod/${pod} --timeout=120s`),
        stop: (name) => k(`scale statefulset ${name} --replicas=0`),
        start: (name) => k(`scale statefulset ${name} --replicas=1`),
        rabbit: "rabbitmq",
        matching: "matching-service",
        stopMatching: () => k("scale deployment matching-service --replicas=0"),
        startMatching: () => {
          k("scale deployment matching-service --replicas=1");
          k("rollout status deployment/matching-service --timeout=120s");
        },
        killApi: () => k("delete pod -l app=request-service --grace-period=0 --force"),
        recoverApi: () => k("rollout status deployment/request-service --timeout=120s"),
        canScale: true,
      };

function waitHealthyCompose(svc, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const id = c(`ps -q ${svc}`);
      if (id && sh(`docker inspect -f '{{.State.Health.Status}}' ${id}`) === "healthy") return;
    } catch {
      // not there yet
    }
    execSync("sleep 1");
  }
  throw new Error(`${svc} did not become healthy`);
}

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

let API;

async function http(path, { method = "GET", body } = {}) {
  // Only reads are retried. Replaying a write after a timeout can create it twice (the server may
  // have stored it before the client gave up), which silently corrupts what a test is checking.
  const attempts = method === "GET" ? 4 : 1;
  const timeoutMs = method === "GET" ? 8000 : 30000;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(API + path, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: res.status, body: json, headers: res.headers };
    } catch (e) {
      lastErr = e;
      await sleep(300);
    }
  }
  throw lastErr;
}
const api = http;

async function waitFor(what, fn, timeoutMs = 30000, everyMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // keep trying until the timeout
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// The list endpoints are paginated: follow the cursors to get every row.
async function listAll(path) {
  const items = [];
  let cursor;
  do {
    const res = await api(`${path}?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (res.status !== 200) throw new Error(`GET ${path} failed with ${res.status}`);
    items.push(...res.body.items);
    cursor = res.body.nextCursor;
  } while (cursor);
  return items;
}

const newResource = (type, location) => api("/resources", { method: "POST", body: { type, location } });
const newRequest = (type, location, details = "e2e") => api("/requests", { method: "POST", body: { type, location, details } });
const getRequest = async (id) => (await api(`/requests/${id}`)).body;
const waitAssigned = (id, timeout = 25000) =>
  waitFor(`request ${id.slice(0, 8)} ASSIGNED`, async () => {
    const r = await getRequest(id);
    return r.status === "ASSIGNED" ? r : null;
  }, timeout);

// Everything one storage node holds, as a Map key -> version.
function nodeEntries(node) {
  const out = platform.exec(node, "wget -qO- http://localhost:4000/internal/dump");
  return new Map(JSON.parse(out).map(([key, , version]) => [key, version]));
}
const sameEntries = (a, b) => a.size === b.size && [...a].every(([key, v]) => b.get(key) === v);

const system = async () => (await api("/system")).body;

async function waitAllNodesUp(timeout = 60000) {
  await waitFor("all 9 storage nodes up", async () => {
    const s = await system();
    return s.coordinator?.nodes?.length === 9 && s.coordinator.nodes.every((n) => n.status === "up");
  }, timeout, 1000);
}

const rabbitQueues = () => {
  const cmd = "rabbitmqctl list_queues name messages consumers";
  const out = MODE === "compose" ? platform.exec("rabbitmq", cmd) : platform.exec("rabbitmq-0", cmd);
  const rows = {};
  for (const line of out.split("\n")) {
    const [name, messages, consumers] = line.trim().split(/\s+/);
    if (name?.startsWith("match.")) rows[name] = { messages: Number(messages), consumers: Number(consumers) };
  }
  return rows;
};

// ---------- tests ----------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("1. normal request: create → queue → match → statuses updated", async () => {
  const loc = `normal-${run}`;
  const res = await newResource("water", loc);
  assert(res.status === 201, `resource created (got ${res.status})`);
  const req = await newRequest("water", loc, "Need drinking water for 20 people");
  assert(req.status === 201 && req.body.status === "PENDING", "request created as PENDING");
  const done = await waitAssigned(req.body.id);
  assert(done.resourceId === res.body.id, "request assigned the resource we registered");
  const r = (await listAll("/resources")).find((x) => x.id === res.body.id);
  assert(r.status === "ASSIGNED" && r.availability === false && r.assignedRequestId === req.body.id, "resource marked ASSIGNED to this request");
  const list = await listAll("/requests");
  assert(list.some((x) => x.id === req.body.id), "request appears in GET /requests");
});

test("2. multiple requests: 12 at once, each gets its own resource", async () => {
  const n = 12;
  const locs = Array.from({ length: n }, (_, i) => `multi-${run}-${i}`);
  await Promise.all(locs.map((l) => newResource("food", l)));
  const reqs = await Promise.all(locs.map((l) => newRequest("food", l)));
  assert(reqs.every((r) => r.status === 201), "all 12 requests accepted");
  const done = await Promise.all(reqs.map((r) => waitAssigned(r.body.id, 40000)));
  assert(new Set(done.map((d) => d.resourceId)).size === n, "every request got a distinct resource");
});

test("3. concurrent claim: 10 requests race for ONE resource, exactly one wins", async () => {
  const loc = `race-${run}`;
  const res = await newResource("medicine", loc);
  const reqs = await Promise.all(Array.from({ length: 10 }, () => newRequest("medicine", loc)));
  assert(reqs.every((r) => r.status === 201), "all 10 requests accepted");
  await waitFor("one winner", async () => {
    const all = await Promise.all(reqs.map((r) => getRequest(r.body.id)));
    return all.some((r) => r.status === "ASSIGNED");
  }, 30000);
  await sleep(4000); // give any (wrong) second assignment time to show up
  const all = await Promise.all(reqs.map((r) => getRequest(r.body.id)));
  const winners = all.filter((r) => r.status === "ASSIGNED");
  assert(winners.length === 1, `exactly one request assigned (got ${winners.length})`);
  assert(winners[0].resourceId === res.body.id, "winner holds the resource");
  assert(all.filter((r) => r.status === "PENDING").length === 9, "other 9 stay PENDING");
  const resource = (await listAll("/resources")).find((x) => x.id === res.body.id);
  assert(resource.assignedRequestId === winners[0].id, "resource points back at the winner");
});

test("3b. distance matching: nearest resource within the radius wins, zone names still work", async () => {
  // A point unique to this run so leftovers from earlier runs cannot interfere.
  const lat = 20 + (Date.now() % 100000) / 5000;
  const at = (dLat) => `${(lat + dLat).toFixed(5)}, 70.00000`; // 0.01 degrees of latitude is about 1.1 km
  const near = await newResource("food", at(0.0045)); // ~0.5 km
  const mid = await newResource("food", at(0.027)); // ~3 km
  const far = await newResource("food", at(0.5)); // ~55 km
  const req = await newRequest("food", at(0));
  const done = await waitAssigned(req.body.id);
  assert(done.resourceId === near.body.id, "nearest resource chosen over the 3 km and 55 km ones");
  assert(done.distanceKm > 0.3 && done.distanceKm < 0.7, `distance recorded (${done.distanceKm} km)`);

  const second = await newRequest("food", at(0));
  const done2 = await waitAssigned(second.body.id);
  assert(done2.resourceId === mid.body.id, "next request gets the next-nearest within 5 km");

  const third = await newRequest("food", at(0));
  await sleep(5000);
  assert((await getRequest(third.body.id)).status === "PENDING", "request stays PENDING when only a 55 km resource is left");
  assert(far.status === 201, "far resource exists but is out of range");

  const zone = `zone-${run}`;
  const zr = await newResource("shelter", zone.toUpperCase());
  const zq = await newRequest("shelter", zone);
  const zd = await waitAssigned(zq.body.id);
  assert(zd.resourceId === zr.body.id && zd.distanceKm == null, "zone names still match, case-insensitively, with no distance");

  const mixed = await newRequest("shelter", at(0));
  await sleep(4000);
  assert((await getRequest(mixed.body.id)).status === "PENDING", "a coordinate request never matches a zone-name resource");
});

test("3c. status rules: no manual assigning, finished stays finished, a lost resource returns the request", async () => {
  const loc = `rules-${run}`;
  const put = (path, status) => api(path, { method: "PUT", body: { status } });

  // A pending request cannot be assigned or completed by hand (only the matcher assigns).
  const lone = await newRequest("food", `${loc}-nobody`);
  assert((await put(`/requests/${lone.body.id}/status`, "ASSIGNED")).status === 409, "PENDING -> ASSIGNED by hand is refused");
  assert((await put(`/requests/${lone.body.id}/status`, "COMPLETED")).status === 409, "PENDING -> COMPLETED is refused");
  assert((await getRequest(lone.body.id)).resourceId === null, "no request is ever ASSIGNED without a resource");

  // Taking a resource away sends its request back to be matched again, never leaving two on one resource.
  const res = await newResource("water", `${loc}-w`);
  const first = await newRequest("water", `${loc}-w`);
  await waitAssigned(first.body.id);
  const off = await put(`/resources/${res.body.id}/status`, "UNAVAILABLE");
  assert(off.status === 200 && off.body.releasedRequestId === first.body.id, "response says which request was released");
  assert((await getRequest(first.body.id)).status === "PENDING", "its request went back to PENDING");
  const second = await newRequest("water", `${loc}-w`);
  await sleep(4000);
  assert((await getRequest(second.body.id)).status === "PENDING", "an unavailable resource cannot be taken by another request");

  // Both now compete for the one resource: exactly one wins.
  await put(`/resources/${res.body.id}/status`, "AVAILABLE");
  await waitFor("one winner", async () => {
    const both = await Promise.all([first, second].map((r) => getRequest(r.body.id)));
    return both.some((r) => r.status === "ASSIGNED");
  }, 60000);
  await sleep(3000);
  const both = await Promise.all([first, second].map((r) => getRequest(r.body.id)));
  assert(both.filter((r) => r.status === "ASSIGNED").length === 1, "exactly one request holds the resource");

  // A finished request stays finished.
  const winner = both.find((r) => r.status === "ASSIGNED");
  assert((await put(`/requests/${winner.id}/status`, "COMPLETED")).status === 200, "ASSIGNED -> COMPLETED is allowed");
  assert((await put(`/requests/${winner.id}/status`, "PENDING")).status === 409, "COMPLETED -> PENDING is refused");
});

test("4. matching: late resource is matched automatically, 409 on re-match, cancel frees the resource", async () => {
  const loc = `late-${run}`;
  const req = await newRequest("shelter", loc);
  await sleep(3000);
  assert((await getRequest(req.body.id)).status === "PENDING", "unmatched request stays PENDING");
  const res = await newResource("shelter", loc);
  // The sweeper re-queues stuck PENDING requests, so no manual action is needed (default ≤ ~30s).
  const done = await waitAssigned(req.body.id, 60000);
  assert(done.resourceId === res.body.id, "matched with the late resource automatically");
  assert((await api(`/match/${req.body.id}`, { method: "POST" })).status === 409, "matching an assigned request returns 409");

  const cancelled = await api(`/requests/${req.body.id}/status`, { method: "PUT", body: { status: "CANCELLED" } });
  assert(cancelled.status === 200, "request cancelled");
  const freed = (await listAll("/resources")).find((x) => x.id === res.body.id);
  assert(freed.status === "AVAILABLE" && freed.availability === true, "cancelling released the resource");
});

test("5. rabbitmq: durable queue, consumer attached, jobs survive a matcher outage", async () => {
  const q = rabbitQueues();
  assert(q["match.requests"], "queue match.requests exists");
  assert(q["match.requests"].consumers >= 1, `queue has a consumer (${q["match.requests"].consumers})`);
  assert(q["match.retry"] && q["match.requests.dlq"], "retry and dead-letter queues exist");

  platform.stopMatching();
  await sleep(2000);
  const loc = `queued-${run}`;
  const res = await newResource("transportation", loc);
  const req = await newRequest("transportation", loc);
  await sleep(2500);
  assert((await getRequest(req.body.id)).status === "PENDING", "request waits while no matcher is running");
  const held = rabbitQueues()["match.requests"].messages;
  assert(held >= 1, `job is held in RabbitMQ (${held} queued)`);

  platform.startMatching();
  const done = await waitAssigned(req.body.id, 60000);
  assert(done.resourceId === res.body.id, "queued job was matched once the matcher returned");
});

test("6. rabbitmq outage: requests are still accepted and get matched after the broker returns", async () => {
  platform.stop(platform.rabbit);
  await sleep(2000);
  const loc = `broker-down-${run}`;
  await newResource("water", loc);
  const req = await newRequest("water", loc);
  assert(req.status === 201, `request accepted while RabbitMQ is down (got ${req.status})`);
  assert(req.headers.get("x-match-queued") === "false", "response flags that it was not queued");
  assert((await system()).rabbitmq === "down", "/system reports RabbitMQ down");
  assert((await getRequest(req.body.id)).status === "PENDING", "request is stored as PENDING");

  platform.start(platform.rabbit);
  // Publisher, consumer and sweeper all have to reconnect by themselves.
  await waitFor("rabbitmq up again", async () => (await system()).rabbitmq === "up", 120000, 2000);
  const done = await waitAssigned(req.body.id, 90000);
  assert(done.status === "ASSIGNED", "request matched after the broker came back");
  const after = await newRequest("water", `after-${run}`);
  assert(after.status === 201 && after.headers.get("x-match-queued") !== "false", "new requests are queued normally again");
});

test("6b. rabbitmq restart: jobs already queued survive a restart of the broker itself", async () => {
  // Stop the matcher (and its sweeper) so nothing can re-create the jobs: only the broker's
  // own storage can keep them.
  platform.stopMatching();
  await sleep(2000);
  const loc = `broker-restart-${run}`;
  const n = 3;
  const resources = [];
  for (let i = 0; i < n; i++) resources.push(await newResource("shelter", `${loc}-${i}`));
  const reqs = [];
  for (let i = 0; i < n; i++) reqs.push(await newRequest("shelter", `${loc}-${i}`));
  assert(reqs.every((r) => r.status === 201 && r.headers.get("x-match-queued") !== "false"), "all jobs queued");
  await sleep(1500);
  assert(rabbitQueues()["match.requests"].messages >= n, "jobs are waiting in the queue");

  platform.stop(platform.rabbit);
  await sleep(2000);
  platform.start(platform.rabbit);
  await waitFor("broker back", async () => (await system()).rabbitmq === "up", 120000, 2000);
  await waitFor("queue readable", () => rabbitQueues()["match.requests"] !== undefined, 60000, 2000);
  const held = rabbitQueues()["match.requests"].messages;
  assert(held >= n, `the ${n} queued jobs survived the broker restart (${held} in the queue)`);

  platform.startMatching();
  const done = await Promise.all(reqs.map((r) => waitAssigned(r.body.id, 90000)));
  assert(new Set(done.map((d) => d.resourceId)).size === n, "every queued job was matched after the restart");
});

test("7. sharding: data spread across all 3 shards, all 3 copies identical", async () => {
  const counts = [];
  for (let s = 0; s < 3; s++) {
    const [first, ...others] = [0, 1, 2].map((i) => nodeEntries(platform.storage(s, i)));
    assert(first.size > 0, `shard ${s} holds data (${first.size} keys)`);
    assert(others.every((o) => sameEntries(first, o)), `shard ${s}: all three nodes hold the same keys and versions`);
    counts.push(first.size);
  }
  console.log(`      keys per shard: ${counts.join(" / ")}`);
});

test("8. shard failure: kill a storage node, the other two (a quorum) keep serving reads and writes", async () => {
  const victim = platform.storage(0, 0);
  const before = (await listAll("/requests")).length;
  platform.kill(victim);
  const list = await listAll("/requests");
  assert(list.length === before, `all ${before} requests still readable`);
  const created = [];
  for (let i = 0; i < 10; i++) {
    const r = await newRequest("water", `outage-${run}-${i}`);
    assert(r.status === 201, `write ${i} accepted during outage (got ${r.status})`);
    created.push(r.body.id);
  }
  for (const id of created) assert((await getRequest(id)).id === id, "request written during outage is readable");
  const s = await waitFor("failure detected", async () => {
    const sys = await system();
    return sys.coordinator.nodes.find((n) => n.id === "s0-a" || n.id === "storage-s0-0")?.status === "down" ? sys : null;
  }, 20000, 500).catch(() => null);
  console.log(`      failure detected by coordinator: ${s ? "yes" : "not observed (node already replaced)"}`);
});

test("9. replica recovery: restarted node catches up with writes it missed", async () => {
  const victim = platform.storage(0, 0);
  platform.recover(victim);
  platform.waitReady(victim);
  await waitAllNodesUp();
  const peer = nodeEntries(platform.storage(0, 1));
  await waitFor("node resynced", () => sameEntries(nodeEntries(victim), peer), 40000, 1000);
  console.log(`      ${victim} holds all ${peer.size} keys, same versions as its peer`);
});

test("9b. quorum: with two of three nodes of a shard down, writes are refused instead of stored", async () => {
  // Compose only: Kubernetes recreates a killed pod within seconds, so the outage is too short to observe.
  if (MODE !== "compose") return "skipped";
  const [a, b] = [platform.storage(1, 0), platform.storage(1, 1)];
  platform.kill(a);
  platform.kill(b);
  await sleep(1000);
  // Requests hash to different shards; some will hit shard 1 and must be refused, never half-stored.
  const attempts = [];
  for (let i = 0; i < 12; i++) attempts.push(await newRequest("food", `no-quorum-${run}-${i}`));
  const refused = attempts.filter((r) => r.status === 503);
  assert(refused.length > 0, "writes that route to the broken shard answer 503");
  assert(attempts.every((r) => r.status === 201 || r.status === 503), "every other answer is a clean 201");
  platform.recover(a);
  platform.recover(b);
  platform.waitReady(a);
  platform.waitReady(b);
  await waitAllNodesUp();
  // Retrying a refused create with a key stores it exactly once, whether or not the first try landed.
  const key = `e2e-retry-${run}`;
  const send = () =>
    fetch(`${API}/requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ type: "food", location: `retry-${run}`, details: "e2e" }),
    });
  const [x, y] = await Promise.all([send(), send()]);
  assert([x.status, y.status].every((c) => c === 200 || c === 201), "both attempts succeed");
  const rows = (await listAll("/requests")).filter((r) => r.location === `retry-${run}`);
  assert(rows.length === 1, `one record after two attempts with the same key (${rows.length})`);
});

test("9c. input handling: bad locations, oversized bodies, pagination", async () => {
  for (const location of ["91, 10", "123", "!!!"]) {
    const r = await newRequest("water", location);
    assert(r.status === 400, `location ${JSON.stringify(location)} is rejected (got ${r.status})`);
  }
  const big = await api("/requests", { method: "POST", body: { type: "water", location: "A", details: "x".repeat(200000) } });
  assert(big.status === 413 && /too large/.test(big.body.error), `oversized body gets 413 with a clear message (${big.body.error})`);
  const page = await api("/requests?limit=2");
  assert(page.status === 200 && page.body.items.length <= 2 && page.body.total >= page.body.items.length, "limit is honoured");
  if (page.body.nextCursor) {
    const next = await api(`/requests?limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`);
    assert(next.status === 200 && !next.body.items.some((r) => page.body.items.some((p) => p.id === r.id)), "next page has no repeats");
  }
});

test("10. service failure: killed request-service comes back, no data lost", async () => {
  const before = (await listAll("/requests")).length;
  platform.killApi();
  if (MODE === "k8s") {
    let ok = 0;
    for (let i = 0; i < 20; i++) {
      const r = await api("/health").catch(() => ({ status: 0 }));
      if (r.status === 200) ok++;
      await sleep(200);
    }
    assert(ok >= 18, `API stayed available through the other replica (${ok}/20)`);
  }
  platform.recoverApi();
  const after = await waitFor("requests readable again", async () => {
    const r = await api("/requests?limit=1");
    return r.status === 200 ? r.body.total : null;
  }, 90000, 1000);
  assert(after >= before, `no data lost (${after} ≥ ${before})`);
  const loc = `after-api-${run}`;
  await newResource("food", loc);
  const req = await newRequest("food", loc);
  assert(req.status === 201, "new requests accepted again");
  await waitAssigned(req.body.id);
});

test("11. scaling (kubernetes): scale services up, system stays available", async () => {
  if (!platform.canScale) {
    return "skipped";
  }
  k("scale deployment request-service --replicas=4");
  k("scale deployment matching-service --replicas=3");
  k("rollout status deployment/request-service --timeout=180s");
  k("rollout status deployment/matching-service --timeout=180s");
  const pods = k("get pods -l app=request-service -o name").split("\n").length;
  assert(pods === 4, `4 request-service pods running (${pods})`);

  const n = 20;
  const locs = Array.from({ length: n }, (_, i) => `scale-${run}-${i}`);
  await Promise.all(locs.map((l) => newResource("transportation", l)));
  const reqs = await Promise.all(locs.map((l) => newRequest("transportation", l)));
  assert(reqs.every((r) => r.status === 201), `all ${n} concurrent requests accepted by 4 pods`);
  const done = await Promise.all(reqs.map((r) => waitAssigned(r.body.id, 60000)));
  assert(new Set(done.map((d) => d.resourceId)).size === n, "with 3 matchers, still one resource per request");

  k("scale deployment request-service --replicas=2");
  k("scale deployment matching-service --replicas=1");
  k("rollout status deployment/request-service --timeout=120s");
});

// ---------- runner ----------

async function main() {
  API = process.env.API_URL ?? (MODE === "compose" ? "http://localhost:3005" : await tunnel("request-service"));
  console.log(`mode: ${platform.name}\nAPI:  ${API}\n`);
  await waitFor("request service healthy", async () => (await api("/health")).status === 200, 60000, 1000);
  await waitAllNodesUp();

  const selected = tests.filter((t) => !filter || t.name.toLowerCase().includes(filter));
  const results = [];
  for (const t of selected) {
    const start = Date.now();
    process.stdout.write(`▶ ${t.name}\n`);
    try {
      const outcome = await t.fn();
      results.push({ name: t.name, ok: true, skipped: outcome === "skipped" });
      console.log(outcome === "skipped" ? "  - skipped \n" : `  ✓ passed (${((Date.now() - start) / 1000).toFixed(1)}s)\n`);
    } catch (e) {
      results.push({ name: t.name, ok: false, err: e.message });
      console.log(`  ✗ FAILED: ${e.message}\n`);
    }
  }

  console.log("Summary");
  for (const r of results) console.log(`  ${r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  — ${r.err}`}`);
  const failed = results.filter((r) => !r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
  return failed;
}

main()
  .then((failed) => {
    children.forEach((ch) => ch.kill());
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    children.forEach((ch) => ch.kill());
    process.exit(1);
  });
