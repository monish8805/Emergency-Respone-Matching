import { randomUUID } from "node:crypto";
import { createStorageApp } from "./app";

const nodeId = process.env.NODE_ID ?? "node-local";
const shard = Number(process.env.SHARD ?? 0);
const port = Number(process.env.PORT ?? 4000);
const coordinatorUrl = process.env.COORDINATOR_URL ?? "http://localhost:3006";
const heartbeatMs = Number(process.env.HEARTBEAT_MS ?? 2000);

// A new bootId on every start lets the coordinator notice a restart and resync.
const bootId = randomUUID();

const { app } = createStorageApp(nodeId, shard);
app.listen(port, () => console.log(`storage ${nodeId} (shard ${shard}) on :${port}`));

setInterval(async () => {
  try {
    await fetch(`${coordinatorUrl}/internal/nodes/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: nodeId, bootId }),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    // Coordinator not reachable yet; the next heartbeat will try again.
  }
}, heartbeatMs);
