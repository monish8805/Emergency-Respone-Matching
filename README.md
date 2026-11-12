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
                        primary+replica  …            …
```

| Component | Role |
|---|---|
| **Web UI** (3000) | Create requests, register resources, view and update both, trigger matching, see service/shard health. Its server functions call the Request Service, so the browser never talks to the backend directly. |
| **Request Service** (3005) | Public REST API. Validates with Zod, stores via the coordinator, publishes match jobs to RabbitMQ. |
| **Matching Service** | Consumes match jobs, claims resources atomically, and periodically re-queues requests that are still `PENDING`. |
| **Coordinator** (3006) | Routes every key to `hash(key) mod 3`, replicates each write to the shard's primary and replica, serializes changes per key, offers compare-and-set, tracks heartbeats and reconciles recovered nodes. Internal: bound to localhost in Compose, ClusterIP-only in Kubernetes. |
| **Storage nodes** | 3 shards × (primary + replica). Versioned key-value store with optional on-disk persistence. |
| **RabbitMQ** | Durable queue `match.requests`, delayed retry queue `match.retry`, dead-letter queue `match.requests.dlq`. |

### Locations and matching

A location is either a **zone name** (`Zone A`) or **coordinates** (`12.97, 77.59`; `12.97,77.59` and `(12.97, 77.59)` also work).

- Coordinates match resources of the same type **within `MATCH_RADIUS_KM`** (default 5 km). The nearest resource is chosen first, and the distance is shown in the UI.
- A zone name matches only the same zone name (case-insensitive).
- A zone name never matches coordinates, and the other way round.

### How the hard parts work

- **No double assignment.** The coordinator versions every record. The matcher claims a resource with compare-and-set (`POST /internal/cas/:key`), so when requests race for one resource exactly one wins and the others move on. The claim stores the owning request id, so a matcher that crashes mid-assignment is completed (not leaked) by the next attempt.
- **Replication and failover.** Writes go to every live node in the shard. Reads use the first live node (the primary), falling back to the replica. A failed call or missing heartbeat marks the node `down`.
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
docker kill $(docker compose ps -q storage-s0-primary)   # the replica keeps serving reads and writes
curl localhost:3005/system | jq '.coordinator.shards'
docker compose start storage-s0-primary         # it reconciles with its replica, then rejoins
# Note: `docker kill` counts as a manual stop, so Docker will NOT restart it for you. A real crash is restarted automatically.
docker compose logs coordinator | tail          # "reconciled ... node ... is up"
```

## Kubernetes (minikube)

```bash
./scripts/deploy-k8s.sh              # start minikube, build images into it, deploy, wait until ready
minikube service web -n emergency    # open the UI
```

Storage is three StatefulSets (one per shard, two pods each, each with a volume). RabbitMQ is a StatefulSet with a volume. The Request Service, Matching Service and Web are Deployments and scale with `kubectl scale`. The coordinator is a single replica by design. Non-secret settings live in a ConfigMap. The RabbitMQ credentials are a Secret that `scripts/deploy-k8s.sh` creates with a random password the first time it runs (and keeps afterwards), so no password is stored in git. Storage nodes prefer different machines (soft anti-affinity) and PodDisruptionBudgets stop a node drain from taking both nodes of a shard down.

Simulate failures:

```bash
kubectl -n emergency delete pod storage-s0-0 --force --grace-period=0   # shard failure, replica serves
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

- **Single coordinator.** It serializes writes per key and holds node health in memory. If it is down, the API returns 503 until it restarts (storage data is unaffected). Running several coordinators would need a consensus layer.
- **No quorum.** With replication factor 2, if one node is down the other is the only copy and serves alone. Two simultaneous node losses in one shard make that shard unavailable (data is safe on disk and returns when the nodes do).
- **Last-write-wins versions** follow the coordinator's clock, so a clock that jumps backwards across a coordinator restart could briefly confuse ordering.
- Distance matching uses a straight-line (haversine) distance, not road distance, and one fixed radius for every request type.
- Storage persistence rewrites the node's snapshot on each write: fine for a demo, not for large data sets.
- Changing the RabbitMQ queue topology on an existing broker with old queues requires deleting those queues.
