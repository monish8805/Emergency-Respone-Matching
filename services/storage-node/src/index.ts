import { randomUUID } from "node:crypto";
import { createStorageApp, type StorageOptions } from "./app";
import { connectMongo } from "./mongo";

const nodeId = process.env.NODE_ID ?? "node-local";
const shard = Number(process.env.SHARD ?? 0);
const port = Number(process.env.PORT ?? 4000);
const coordinatorUrl = process.env.COORDINATOR_URL ?? "http://localhost:3006";
const heartbeatMs = Number(process.env.HEARTBEAT_MS ?? 2000);
// Optional: keep data on disk (mount a volume here) so a restart does not lose it.
const dataDir = process.env.DATA_DIR;
// Optional: keep data in MongoDB (Atlas). Takes priority over DATA_DIR when set.
const mongoUri = process.env.MONGODB_URI;
const mongoDb = process.env.MONGODB_DB ?? "emergency";

// A new bootId on every start lets the coordinator notice a restart and resync.
const bootId = randomUUID();

const options: StorageOptions = {};
if (mongoUri) {
  const mongo = await connectMongo(mongoUri, mongoDb, nodeId, shard);
  options.initial = mongo.initial;
  options.onWrite = mongo.onWrite;
  options.backend = "mongodb";
} else if (dataDir) {
  options.dataFile = `${dataDir}/${nodeId}.json`;
}

const { app } = createStorageApp(nodeId, shard, options);
app.listen(port, () =>
  console.log(
    `storage ${nodeId} (shard ${shard}) on :${port}, ` +
      (mongoUri ? `persisting to MongoDB db "${mongoDb}" collection shard_${shard}` : dataDir ? `persisting to ${dataDir}` : "memory only"),
  ),
);

setInterval(async () => {
  try {
    await fetch(`${coordinatorUrl}/internal/nodes/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: nodeId, bootId }),
      signal: AbortSignal.timeout(1000),
    });
  } catch (err) {
    console.error(`heartbeat to ${coordinatorUrl} failed: ${String(err)}`);
  }
}, heartbeatMs);
