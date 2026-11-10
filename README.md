# Distributed Emergency Resource Matching System

A containerized, Kubernetes-ready system that matches emergency requests (water, food, medicine, transportation, shelter) with available resources.

## Architecture

- **Web UI** (port 3000): TanStack Start + TanStack Query frontend to create requests, register resources, view both, update statuses and trigger matching. Its server functions call the Request Service (`API_URL`).
- **Request Service** (port 3005): REST API for requests and resources. Publishes match jobs to RabbitMQ.
- **Matching Service**: Consumes match jobs from RabbitMQ and assigns resources.
- **Coordinator** (port 3006): Routes storage operations with `hash(key) mod 3`. Writes to primary and replica. Tracks heartbeats and resyncs recovered nodes.
- **Storage nodes**: 3 shards, each with a primary and a replica.
- **RabbitMQ**: Asynchronous match queue `match.requests`.

## Run locally with Docker Compose

```bash
npm install
docker compose up --build
```

Open the UI at http://localhost:3000, or try the API directly:

```bash
curl -X POST localhost:3005/resources -H 'content-type: application/json' -d '{"type":"water","location":"Zone A"}'
curl -X POST localhost:3005/requests -H 'content-type: application/json' -d '{"type":"water","location":"Zone A","details":"flood"}'
curl localhost:3005/requests/<id>
```

Stop a storage node (`docker compose stop storage-s0-primary`) to see reads served by its replica. Start it again to see it resync.

## Web UI development

```bash
cd web && npm install && npm run dev   # http://localhost:3000, calls the request service at API_URL (default http://localhost:3005)
```

## Kubernetes (minikube)

```bash
./scripts/deploy-k8s.sh              # start minikube, build images, deploy, wait until ready
minikube service web -n emergency    # open the UI
node scripts/e2e.mjs                 # run the end-to-end tests (see docs/DEMO.md for the demo script)
```

Storage runs as three StatefulSets (one per shard, two pods each). Request and matching services are Deployments and can be scaled with `kubectl scale`.

## Tests

```bash
npm test
npm run typecheck
```

## Known limitations (planned)

- Storage is in-memory, so data is lost if a node restarts. Recovery copies data back from its replica.
- Matching is not atomic, so two matchers could claim the same resource at once. A compare-and-set in the coordinator fixes this.
- Requests with no match stay PENDING and are not retried yet.
# Emergency-Respone-Matching
