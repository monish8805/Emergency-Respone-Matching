# Final demonstration

Prerequisite: Docker Desktop running, then `./scripts/deploy-k8s.sh` (starts minikube, builds images, deploys everything).

Open these in separate terminals before you start:

```bash
# T1: the UI (opens a browser)
minikube service web -n emergency

# T2: watch pods live
kubectl -n emergency get pods -w

# T3: RabbitMQ management UI (login guest / guest), http://localhost:15672
kubectl -n emergency port-forward svc/rabbitmq 15672:15672

# T4: matching service log, shows each match as it happens
kubectl -n emergency logs -f deploy/matching-service
```

Handy helpers:

```bash
API=$(minikube service request-service -n emergency --url)    # leave this terminal open
COORD=$(minikube service coordinator -n emergency --url)      # separate terminal, leave open
```

## Steps

| # | Step | What to do | What to point out |
|---|------|-----------|-------------------|
| 1 | Create request | In the UI: type `water`, location `12.97, 77.59`, submit | Row appears as `PENDING` |
| 2 | Register resource | In the UI: type `water`, same location, register | Appears as `AVAILABLE` |
| 3 | RabbitMQ receives request | RabbitMQ UI → Queues → `match.requests` (message rates spike). Or `kubectl -n emergency exec deploy/rabbitmq -- rabbitmqctl list_queues name messages consumers` | Request Service publishes, queue has 1 consumer |
| 4 | Matching happens | Watch T4 and the UI | Log says `assigned`; request flips to `ASSIGNED`, resource to `ASSIGNED` |
| 5 | Data distributed across shards | `for p in storage-s{0,1,2}-0; do echo $p; kubectl -n emergency exec $p -- wget -qO- http://localhost:4000/internal/dump \| jq length; done` (create ~10 requests first so every shard has data) | Keys land on different shards (`hash(key) mod 3`); `-1` pods hold identical copies |
| 6 | Kill storage node | `kubectl -n emergency delete pod storage-s0-0 --grace-period=0 --force` | Coordinator logs `marked down`; `curl $COORD/health \| jq` shows it down |
| 7 | Replica continues serving | Refresh the UI, create another request | Everything still readable and writable via `storage-s0-1` |
| 8 | Recover storage node | Pod comes back by itself (StatefulSet). `kubectl -n emergency logs deploy/coordinator \| tail` | `recovered, syncing data` then `synced N keys`; verify with the dump command from step 5 |
| 9 | Kill Kubernetes pod | `kubectl -n emergency delete pod -l app=request-service --grace-period=0 --force` | UI keeps working through the other replica |
| 10 | Kubernetes recreates it | Watch T2 | New pod appears and goes `Running` within seconds |
| 11 | Scale service | `kubectl -n emergency scale deploy/request-service --replicas=4` then `deploy/matching-service --replicas=3` | T2 shows new pods |
| 12 | System remains available | Submit several requests in the UI while scaling | All accepted and matched |

## Automated proof

`node scripts/e2e.mjs` runs all of the above (plus multiple concurrent requests and RabbitMQ durability) and prints PASS/FAIL per test.

## Known limitations to mention honestly

- Storage is in-memory. Data survives a single node failure (via the replica) but not losing both nodes of a shard.
- The coordinator is a single pod. If it is killed, requests fail with 503 for a few seconds until it restarts.
- Matching is not atomic, so several matching-service pods can occasionally claim the same resource.
