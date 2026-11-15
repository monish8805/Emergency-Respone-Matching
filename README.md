# Distributed Emergency Resource Matching System 

A containerized system that matches emergency requests (water, food, medicine, transportation, shelter) with available resources. Storage is sharded and replicated, matching runs asynchronously through RabbitMQ, and the whole thing runs on Docker Compose or Kubernetes (minikube).

## Architecture

```
Browser ─► Web UI (TanStack Start, :3000)
              │ server functions
              ▼
         Request Service (:3005) ──publish──► RabbitMQ ──consume──► Matching Service (:3007 health)
              │                                                          │
              └──────────────────────► Coordinator (:3006) ◄─────────────┘
                                        hash(key) mod 3
                              ┌───────────┼───────────┐
                         Shard 0      Shard 1      Shard 2
                        3 nodes, quorum 2  …     …
```

| Component | Role |
|---|---|
| **Web UI** (3000) | Create requests, register resources, view and update both, trigger matching, see service/shard health. Its server functions call the Request Service, so the browser never talks to the backend directly. |
| **Request Service** (3005) | Public REST API. Validates with Zod (locations, sizes, idempotency keys), stores via the coordinator, publishes match jobs to RabbitMQ. |
| **Matching Service** | Consumes match jobs, claims resources atomically, and periodically re-queues requests that are still `PENDING`. |
| **Coordinator** (3006) | Routes every key to `hash(key) mod 3`, replicates each write to the shard's three nodes and needs a majority (2 of 3) to acknowledge it, serializes changes per key, offers compare-and-set, tracks heartbeats and reconciles recovered nodes. Internal: bound to localhost in Compose, ClusterIP-only in Kubernetes. Kubernetes runs two with leader election (one active). |
| **Storage nodes** | 3 shards × 3 nodes. Versioned key-value store with optional on-disk persistence. |
| **RabbitMQ** | Durable queue `match.requests`, delayed retry queue `match.retry`, dead-letter queue `match.requests.dlq`. |

### Locations and matching

A location is either a **zone name** (`Zone A`) or **coordinates** (`12.97, 77.59`; `12.97,77.59` and `(12.97, 77.59)` also work).

- Coordinates match resources of the same type **within `MATCH_RADIUS_KM`** (default 5 km). The nearest resource is chosen first, and the distance is shown in the UI.
- A zone name matches only the same zone name (case-insensitive).
- A zone name never matches coordinates, and the other way round.

### How data is keyed

Requests are stored as `request:<uuid>`. Resources are stored as `resource:<type>:<uuid>`, and a resource id is `<type>-<uuid>` (for example `water-9f3a…`), so the type is part of the key and an id alone is enough to find it. Listing takes a key prefix and each storage node applies it itself, so the matcher asks for `resource:water:` and receives only water resources instead of every record on every shard. (The resource list in the UI asks for all types.) Data written with the older `resource:<uuid>` keys is not found by the new code: reset the volumes (`docker compose down -v`, or delete the namespace on Kubernetes) after upgrading.

### Status rules

A request moves forward only: `PENDING → ASSIGNED` is done by the matcher (never by hand), then `IN_PROGRESS`, `COMPLETED`, and any non-finished request can be `CANCELLED`. `COMPLETED` and `CANCELLED` are final. The API answers `409` with the allowed next statuses for anything else, and the UI only offers valid choices.

If a resource that is serving a request is set to `AVAILABLE` or `UNAVAILABLE`, that request goes back to `PENDING` and is queued to be matched again, so a resource can never be assigned to two requests at once.

### How the hard parts work

- **No double assignment.** The coordinator versions every record. The matcher claims a resource with compare-and-set (`POST /internal/cas/:key`), so when requests race for one resource exactly one wins and the others move on. The claim stores the owning request id, so a matcher that crashes mid-assignment is completed (not leaked) by the next attempt.
- **Quorum replication.** Every shard has three nodes. A write goes to all live nodes and is acknowledged only when 2 of 3 hold it. A read asks every live node, needs 2 of 3 to answer and returns the newest version, so it always sees the latest acknowledged write. One node down changes nothing for clients. Two down makes the shard refuse reads and writes (503) instead of answering from a single copy; nothing is lost, the data is on disk and the shard returns when a node does. A failed call or missing heartbeat marks a node `down`. A write is refused up front when fewer than 2 nodes are reachable, so it is not left behind on the one node that was.
- **Coordinator failover.** Kubernetes runs two coordinators that compete for a `Lease` object. Only the holder is Ready, so the Service (and every heartbeat) goes to it. If it dies, the other takes the lease after at most 15 seconds, starts with every node marked `syncing` and reconciles them, exactly like a restart. A leader that cannot renew steps down after 9 seconds, before the lease can be taken, and a shutting-down leader hands the lease over immediately. Compose runs a single coordinator.
- **Safe retries (idempotency).** `POST /requests` and `POST /resources` accept an `Idempotency-Key` header (8-100 characters of letters, digits, `_`, `-`). The key decides the record's id and the record is created with a create-only write, so repeating a call with the same key never makes a second record: it returns the existing one with `200` and `idempotent-replay: true`. This covers a double click, a client that retries after a timeout, and a 503 whose write nevertheless reached some nodes. The UI sends a fresh key per submission, disables the button while sending, and reuses the key if it has to retry after an error. The same key with a different body is `409`.
- **Pagination.** `GET /requests` and `GET /resources` return `{ items, nextCursor, total }`. Use `?limit=` (1-200, default 50) and pass `nextCursor` back as `?cursor=`. Requests are newest first, resources are ordered by id, and `GET /resources?type=water` lists one type. Cursors name the last record seen, so rows added between pages are never skipped or repeated. The UI shows 25 per page and polls only the page on screen.
- **Input checks.** A location must be valid coordinates (`-90..90`, `-180..180`) or a zone name: starts with a letter, letters/digits/spaces and `. ' _ -`, at most 60 characters. `91, 10`, `123` or `!!!` are rejected with `400`. Optionally set `ZONES="Zone A,Zone B"` on the request service to accept only those zones (plus coordinates), which is the only way to refuse a plausible but unknown name like `asdf`. Bodies are capped at 100 KB (`413 request body too large (limit 100 KB)`); malformed JSON gets `400 malformed request body`.
- **Recovery without stale reads.** A node that comes back is `syncing`: it receives new writes but serves no reads until it has been reconciled with its peer. Reconciliation runs per key under that key's lock and the higher version wins in both directions, so an old copy can never overwrite a newer write.
- **Durability.** With `DATA_DIR` set (Compose volumes / Kubernetes PVCs) each node persists its data, so even losing both nodes of a shard at once loses nothing.
- **Reliable messaging.** Publishes wait for broker confirms and reconnect after broker restarts. Failed jobs go to a delayed retry queue (5 attempts) then the dead-letter queue. If a publish fails, the request stays `PENDING` and the matcher's sweeper re-queues it, so nothing is stuck. Connecting and confirming are time-limited and heartbeats are on, so a broker outage never makes the API hang: it answers at once with `x-match-queued: false`. The sweeper only re-queues requests a free resource could actually serve, so unmatchable requests cost nothing.

## Run with Docker Compose

```bash
npm install
docker compose up --build          # set WEB_PORT=3100 if port 3000 is taken
```

Open http://localhost:3000. Or use the API:

```bash
curl -X POST localhost:3005/resources -H 'content-type: application/json' -d '{"type":"water","location":"Zone A"}'
curl -X POST localhost:3005/requests  -H 'content-type: application/json' -d '{"type":"water","location":"Zone A","details":"flood"}'
curl localhost:3005/requests           # list
curl localhost:3005/system             # health of request service, RabbitMQ, coordinator and every storage node
```

API: `POST/GET /requests`, `GET /requests/:id`, `PUT /requests/:id/status`, `POST/GET /resources`, `PUT /resources/:id/status`, `POST /match/:requestId`, `GET /health`, `GET /system`.

### Simulate shard failure and recovery

```bash
docker kill $(docker compose ps -q storage-s0-a)   # the other two nodes keep serving reads and writes
curl localhost:3005/system | jq '.coordinator.shards'
docker compose start storage-s0-a                 # it reconciles with its peers, then rejoins
# Note: `docker kill` counts as a manual stop, so Docker will NOT restart it for you. A real crash is restarted automatically.
docker compose logs coordinator | tail          # "reconciled ... node ... is up"
```

## Kubernetes (minikube)

```bash
./scripts/deploy-k8s.sh              # start minikube, build images into it, deploy, wait until ready
minikube service web -n emergency    # open the UI
```

Storage is three StatefulSets (one per shard, three pods each, each with a volume). RabbitMQ is a StatefulSet with a volume. The Request Service, Matching Service and Web are Deployments and scale with `kubectl scale`. The coordinator runs two pods with leader election (`k8s/21-coordinator-rbac.yaml` gives them access to one Lease). Non-secret settings live in a ConfigMap. The RabbitMQ credentials are a Secret that `scripts/deploy-k8s.sh` creates with a random password the first time it runs (and keeps afterwards), so no password is stored in git. Storage nodes prefer different machines (soft anti-affinity) and PodDisruptionBudgets stop a node drain from taking more than one node of a shard (or one coordinator) down.

**Hardening and scaling.** Every container built here runs as the unprivileged `node` user (uid 1000) with all Linux capabilities dropped and privilege escalation off; Compose does the same (`cap_drop`, `no-new-privileges`) and RabbitMQ runs as uid 999. `k8s/80-network-policies.yaml` denies all ingress by default and opens only the real paths (the UI and API from outside; coordinator only from the services and storage nodes; storage only from the coordinator; RabbitMQ's AMQP port only from the two services, not its management port). NetworkPolicy needs a network plugin that enforces it, so `deploy-k8s.sh` starts minikube with Calico and warns if the cluster has none. `k8s/70-autoscaling.yaml` scales the request service (2-6), matching service (1-4) and web (1-4) on CPU through metrics-server, which the script enables.

Simulate failures:

```bash
kubectl -n emergency delete pod storage-s0-0 --force --grace-period=0   # shard failure, the other two nodes serve
kubectl -n emergency delete pod -l app=request-service                  # pod failure, Kubernetes recreates it
kubectl -n emergency scale deploy/request-service --replicas=4          # scaling
```

## Tests

```bash
npm test                    # unit + integration (real storage servers, no mocks for the cluster tests)
npm run typecheck
RABBITMQ_URL=amqp://localhost:5672 npm test      # also runs the live-broker tests (needs RabbitMQ)
MODE=compose node scripts/e2e.mjs                # end-to-end against the running Compose stack
node scripts/e2e.mjs                             # end-to-end against minikube (includes scaling)
```

See `docs/DEMO.md` for the demonstration script.

## Limitations

- **One active coordinator.** Two run on Kubernetes, but only the lease holder works; the other is a standby, so there is no extra throughput. For up to 15 seconds after the leader dies the API returns 503. Per-key locking and node health live in the leader's memory, so ordering relies on there being exactly one leader: the lease and the 9 s step-down keep that true unless a pod is frozen for longer than the lease and clocks misbehave. The storage nodes' version check limits the damage but is not a consensus protocol. Compose runs a single coordinator.
- **Quorum is per shard, majority of three.** One node may be down; two make the shard unavailable. A write that fails halfway (a node believed up that fails mid-write) can still be stored on the one node that took it. The API answers 503 in that case, and an `Idempotency-Key` makes the retry safe, but a read can later return that value once the nodes are back.
- **Idempotency is opt-in per call.** Without the header every call creates a new record, as before. Pagination is applied by the Request Service after it reads the list from the coordinator, so it saves the browser's bandwidth but each page request still reads all records from storage.
- **Zone names are free text** unless `ZONES` is set: `asdf` is a well-formed zone name and is accepted by default.
- Record versions follow the coordinator's clock. If a restarted coordinator's clock is behind the stored versions, it detects the refused write and moves past the newer version, so no write is lost (covered by tests). Ordering between *different* coordinators is not defined: run one.
- Listing still asks every shard (the type is in the key, not in the hash), so a lookup touches all three shards but each returns only the matching records. Placing a type on one shard would avoid that, at the cost of hotspots.
- Distance matching uses a straight-line (haversine) distance, not road distance, and one fixed radius for every request type.
- Storage persistence rewrites the node's snapshot on each write: fine for a demo, not for large data sets.
- Changing the RabbitMQ queue topology on an existing broker with old queues requires deleting those queues.
