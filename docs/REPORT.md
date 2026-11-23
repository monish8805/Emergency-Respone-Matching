# Distributed Emergency Resource Matching System: Final Report

Cloud Computing, Infrastructure Project

## 1. Summary

The system matches emergency requests (water, food, medicine, transportation, shelter) with available resources. Requests are stored in a sharded, replicated key-value store behind a coordinator. Matching runs asynchronously through RabbitMQ. Everything is containerized with Docker and deployed on Kubernetes (minikube), with Docker Compose as an alternative. A web UI lets a user create requests, register resources, trigger matching and watch system health.

Verification done for this report:
- `npm test`: 14 test files, 190 passed, 6 skipped (the skipped tests need a live RabbitMQ broker).
- `npm run typecheck`: clean.
- Every requirement in the project brief was checked against the code (section 3).
- Not re-run for this report: the end-to-end script (`scripts/e2e.mjs`) and the live Docker and Kubernetes demos. They need a running cluster.

## 2. Architecture

```
Browser -> Web UI (TanStack Start, :3000)
              | server functions
              v
         Request Service (:3005) --publish--> RabbitMQ --consume--> Matching Service
              |                                                          |
              +-----------------------> Coordinator (:3006) <------------+
                                        hash(key) mod 3
                              +-----------+-----------+
                         Shard 0      Shard 1      Shard 2
                        3 nodes, quorum 2 ...
```

| Component | Role |
|---|---|
| Web UI | Create and manage requests and resources, trigger matching, view health. |
| Request Service | Public REST API. Validates input with Zod, stores through the coordinator, publishes match jobs. |
| Matching Service | Consumes match jobs, claims a resource atomically, and re-queues stuck `PENDING` requests. |
| Coordinator | Routes each key to `hash(key) mod 3`. Replicates each write to the shard's 3 nodes and needs 2 acknowledgements. Serializes writes per key, tracks heartbeats and reconciles recovered nodes. Two pods with Lease-based leader election on Kubernetes. |
| Storage nodes | 3 shards x 3 nodes. Versioned key-value store with on-disk persistence (`DATA_DIR`) and optional MongoDB persistence (`MONGODB_URI`). |
| RabbitMQ | Durable queue `match.requests`, delayed retry queue `match.retry`, dead-letter queue `match.requests.dlq`. |

### Key design decisions and justification
- **Sharding**: a djb2 hash of the key, mod 3 (`shared/src/hash.ts`). It is simple and deterministic, and every record has the same key on every node. The type is part of the resource key, so prefix listing is cheap.
- **Replication**: a majority quorum, 2 of 3. One node down changes nothing for clients. Two down makes the shard refuse reads and writes (503) instead of serving a single copy.
- **No double assignment**: records are versioned, and the matcher claims a resource with compare-and-set. When requests race for one resource, exactly one wins.
- **Recovery**: a returning node is `syncing`. It receives writes but serves no reads until reconciled, and the higher version wins in both directions, so a stale copy never overwrites a newer write.
- **Reliability**: idempotency keys on create calls, publisher confirms, a retry queue with 5 attempts then a dead-letter queue, and a sweeper that re-queues requests whose publish failed.
- **Matching**: same type, then the nearest resource within `MATCH_RADIUS_KM` (haversine, default 5 km) for coordinates, or an exact zone-name match.

## 3. Requirement compliance

Each row is checked against the code or manifests.

### System configuration (brief, Table 1)

| Requirement | Status | Evidence |
|---|---|---|
| 1 coordinator | Met | `services/coordinator`. Two pods on Kubernetes, but only the Lease holder is active. |
| 2-3 microservices | Met | Request Service and Matching Service. The coordinator, storage node and web UI are separate. |
| 1 RabbitMQ instance | Met | `k8s/10-rabbitmq.yaml` is a StatefulSet with 1 replica. |
| 3 storage shards | Met | `k8s/30-storage.yaml` has 3 StatefulSets. |
| At least 1 replica per shard | Met, exceeded | 3 nodes per shard. |
| Docker (mandatory) | Met | A Dockerfile per service plus `docker-compose.yml`. Containers run as user `node`. |
| Kubernetes (mandatory) | Met | `k8s/` has 12 manifests and `scripts/deploy-k8s.sh` deploys them. |
| Cloud deployment (optional) | Not done | Local minikube and Compose only. |

### Data (brief, sections 3 and 4)

| Requirement | Status | Evidence |
|---|---|---|
| Request fields: id, type, location, details, status, creation time | Met | `createRequestSchema`; `status: "PENDING"` and `createdAt` are set in `request-service/src/app.ts`. |
| Resource fields: id, type, location, availability, status | Met | `registerResourceSchema` has type, location and availability. Status is `RESOURCE_STATUSES`. |
| Data spread across shards, routed by coordinator | Met | `hash(key) mod 3`, covered by a cluster test. The client never sees the physical location. |

### Client REST API (brief, Table 2)

| Endpoint | Status |
|---|---|
| POST /requests (201) | Met |
| GET /requests/{id} (200) | Met |
| PUT /requests/{id}/status (200) | Met |
| POST /resources (201) | Met |
| GET /resources (200) | Met |
| PUT /resources/{id}/status (200) | Met |
| POST /match/{requestId} (200) | Met |

The API also returns 400 (validation), 404, 409 (invalid transition or idempotency conflict), 413 (body too large) and 503 (storage unavailable).

### Internal APIs (brief, Table 3)

| Endpoint | Status | Notes |
|---|---|---|
| POST /internal/nodes/register | Met | Registration and heartbeat share one handler. |
| POST /internal/nodes/heartbeat | Met | Storage nodes send one every 2 s. |
| PUT /internal/data/{key} | Met | |
| GET /internal/data/{key} | Met | |
| DELETE /internal/data/{key} | Met | Implemented on both the coordinator and the storage node as a versioned tombstone, so a node that was down during the delete cannot bring the key back when it recovers. Covered by 5 coordinator tests and 1 storage-node test. |

Extras beyond the brief: `POST /internal/cas/:key`, `GET /internal/list`, `/health`, `/ready` and `GET /system`.

### Asynchronous processing (brief, section 7)

All six steps are implemented. The request is stored, published to RabbitMQ and consumed by the Matching Service. A resource is identified (type and location) and assigned, and both statuses are updated. Matching can also be triggered by hand with `POST /match/{requestId}`.

### Failure handling (brief, section 8)

| Requirement | Status | Evidence |
|---|---|---|
| Detect unavailable nodes | Met | A 6 s heartbeat timeout (`HEARTBEAT_TIMEOUT_MS`) marks a node `down`. A failed call also marks it down. |
| Avoid routing to failed nodes | Met | Writes go only to live nodes. They are refused up front if fewer than 2 are reachable. |
| Use a replica when data stays accessible | Met | Quorum reads return the newest version. |
| Continue processing with enough replicas | Met | One node down changes nothing for clients. |
| Synchronize on recovery | Met | `syncing` state plus per-key reconciliation under lock. Tested with a recovery test. |
| Demonstrate by stopping and restarting a container or pod | Met, scripted | `docs/DEMO.md` steps 6-8 and the README's Docker and Kubernetes failure commands. |

### Docker and Kubernetes (brief, section 9)

| Requirement | Status | Evidence |
|---|---|---|
| Dockerfiles, images, containers, networking | Met | 5 Dockerfiles, `scripts/build-images.sh`, and Compose networking. |
| Deployments | Met | Coordinator, request-service, matching-service and web. |
| Services | Met | One per component. |
| Pod replicas | Met | Request Service 2, coordinator 2, storage 3 per shard. |
| Service-to-service communication | Met | Via cluster DNS and ConfigMap URLs, restricted by NetworkPolicies. |
| Microservice scaling | Met | `kubectl scale` and HPAs (request-service 2-6, matching 1-4, web 1-4). |
| Pod failure and automatic recovery | Met | Deployments and StatefulSets recreate pods. Demo steps 9-10. |

### Required demonstration (brief, section 10)

`docs/DEMO.md` is a 12-step script that covers every listed item: request creation, resource registration, matching, shard distribution, RabbitMQ, storage failure, node recovery, pod recovery, scaling and availability while scaling. `scripts/e2e.mjs` automates them and prints PASS or FAIL per test.

### Testing (brief, section 11)

| Required test area | Status |
|---|---|
| Request creation, retrieval, status updates | Covered by request-service tests (`app.test.ts`, `lifecycle.test.ts`). |
| Resource registration and availability updates | Covered by the same tests. |
| Correct matching | Covered by `shared/test/match.test.ts`, `geo.test.ts` and `worker.test.ts`. |
| Simultaneous requests | Covered by the concurrent-claim tests and the e2e script. |
| RabbitMQ delivery | `rabbit.test.ts`. The live-broker tests are skipped unless `RABBITMQ_URL` is set. |
| Shard selection and distribution | `hash.test.ts` and `cluster.test.ts`. |
| Replica availability during failure | `cluster.test.ts`. |
| Recovery and synchronization | `cluster.test.ts` and `nodes.test.ts`. |
| Pod failure and Kubernetes scaling | Only through `scripts/e2e.mjs` and the manual demo, which need a cluster. |

## 4. Results

- 190 automated tests pass and the typecheck is clean.
- All 7 client endpoints and all 5 example internal endpoints are implemented.
- Every item in the required demonstration has a script or an automated check.
- Beyond the brief: optional MongoDB Atlas persistence, idempotent creates, a coordinator with failover, a retry queue and dead-letter queue, NetworkPolicies, PodDisruptionBudgets, HPAs, containers dropped to non-root, and cursor pagination.

## 5. Limitations and future work

Still open:
- **No API authentication.** Anyone who can reach the request service can read and change everything. NetworkPolicies limit access inside the cluster. Add API keys or JWT.
- **Basic data model.** There is no priority, quantity, name or contact. Matching is first-come, first-served and nearest-first. Add urgency and quantity, and priority-aware matching.
- **No CI and no frontend tests.** Backend tests exist, but nothing runs on commit. Add a GitHub Actions workflow with lint, typecheck and tests.
- **One active coordinator.** The standby adds no throughput, and the API returns 503 for up to 15 s after the leader dies. Per-key locks live in the leader's memory, so ordering relies on there being exactly one leader. The storage nodes' version check limits the damage, but this is not a consensus protocol.
- **Pagination happens after a full read.** The request service reads every record from storage, then slices. It saves bandwidth but not storage reads. The UI also polls every 3 s, with no push updates.
- **Zone names are free text** unless `ZONES` is set, so `asdf` is accepted.
- **A write that fails halfway** can remain on the one node that took it. The API answers 503 and an idempotency key makes the retry safe, but a later read can return that value.
- **Matching** uses straight-line distance and one fixed radius for every request type.
- **Storage persistence** rewrites the node's snapshot on each write. This is fine for a demo, not for large data sets.
- **Kubernetes failure window.** A storage pod is recreated faster than the 6 s detection timeout, so the node may never be shown as `down` on Kubernetes. Use the Compose demo or a scale-down for a visible failure. This is documented behaviour that I did not re-measure.
- **Cloud deployment** is not done. The recommended path is a single VM with Docker Compose.
- **Tombstones are never purged.** Deleted keys stay in storage as small markers so recovery cannot resurrect them. A cleanup job would be needed at scale.

Fixed since earlier drafts, so do not list these as open: idempotency keys, coordinator failover, pagination, HPAs, non-root containers and NetworkPolicies.

## 6. MongoDB Atlas persistence (optional)

Storage nodes can persist to MongoDB Atlas instead of a local file (`services/storage-node/src/mongo.ts`). It is enabled by the optional `MONGODB_URI` setting and falls back to on-disk or in-memory storage without it. The README documents how to enable it. Note that the Atlas connection has not been exercised by the automated tests, which use in-memory nodes.

## 7. How to run

```bash
npm install && npm test && npm run typecheck
docker compose up --build            # Compose demo, UI on :3000
./scripts/deploy-k8s.sh              # Kubernetes (minikube) demo
node scripts/e2e.mjs                 # end-to-end proof against minikube
```

See `docs/DEMO.md` for the demonstration script.
