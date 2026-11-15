import type { NodeConfig } from "@emergency/shared";
import { createCoordinatorApp } from "./app";
import { KubernetesLease, LeaderElector } from "./leader";
import { NodeRegistry } from "./nodes";

const port = Number(process.env.PORT ?? 3006);
const timeoutMs = Number(process.env.HEARTBEAT_TIMEOUT_MS ?? 6000);
const configs = JSON.parse(process.env.STORAGE_NODES ?? "[]") as NodeConfig[];

const registry = new NodeRegistry(configs, timeoutMs);

// LEADER_ELECTION=kubernetes runs several coordinators with one active leader (see k8s/20-coordinator.yaml).
// Without it this process is the only coordinator and always acts as leader (Docker Compose).
let elector: LeaderElector | undefined;
if (process.env.LEADER_ELECTION === "kubernetes") {
  const leaseSeconds = Number(process.env.LEASE_SECONDS ?? 15);
  elector = new LeaderElector(
    new KubernetesLease(
      process.env.LEASE_NAME ?? "coordinator",
      process.env.POD_NAMESPACE ?? "emergency",
      leaseSeconds,
    ),
    {
      id: process.env.POD_NAME ?? `coordinator-${process.pid}`,
      leaseMs: leaseSeconds * 1000,
      renewDeadlineMs: Math.floor(leaseSeconds * 1000 * 0.6),
      retryMs: Number(process.env.LEASE_RETRY_MS ?? 2000),
      // Heartbeats were going to the previous leader, so start from "nobody is trusted yet" and let
      // every storage node re-register and be reconciled, exactly like after a restart.
      onChange: (leader) => leader && registry.reset(),
    },
  );
}

const app = createCoordinatorApp(registry, { isLeader: () => (elector ? elector.isLeader() : true) });

setInterval(() => {
  if (elector && !elector.isLeader()) return;
  for (const id of registry.checkTimeouts()) {
    console.log(`node ${id} marked down (no heartbeat)`);
  }
}, 2000);

const server = app.listen(port, () => {
  console.log(`coordinator on :${port} with ${configs.length} storage nodes${elector ? " (leader election on)" : ""}`);
  elector?.start();
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    // A leader that is shutting down hands the lease over at once instead of making others wait.
    server.close();
    void (elector?.stop() ?? Promise.resolve()).finally(() => process.exit(0));
  });
}
