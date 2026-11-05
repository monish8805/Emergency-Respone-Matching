# Distributed Emergency Resource Matching System

A containerized, Kubernetes-ready system that matches emergency requests (water, food, medicine, transportation, shelter) with available resources.

## Architecture

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

Try it:

```bash
curl -X POST localhost:3005/resources -H 'content-type: application/json' -d '{"type":"water","location":"Zone A"}'
curl -X POST localhost:3005/requests -H 'content-type: application/json' -d '{"type":"water","location":"Zone A","details":"flood"}'
curl localhost:3005/requests/<id>
```

Stop a storage node (`docker compose stop storage-s0-primary`) to see reads served by its replica. Start it again to see it resync.

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
