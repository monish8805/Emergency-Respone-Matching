import type { NodeConfig } from "@emergency/shared";
import { createCoordinatorApp } from "./app";
import { NodeRegistry } from "./nodes";

const port = Number(process.env.PORT ?? 3006);
const timeoutMs = Number(process.env.HEARTBEAT_TIMEOUT_MS ?? 6000);
const configs = JSON.parse(process.env.STORAGE_NODES ?? "[]") as NodeConfig[];

const registry = new NodeRegistry(configs, timeoutMs);
const app = createCoordinatorApp(registry);

setInterval(() => {
  for (const id of registry.checkTimeouts()) {
    console.log(`node ${id} marked down (no heartbeat)`);
  }
}, 2000);

app.listen(port, () => console.log(`coordinator on :${port} with ${configs.length} storage nodes`));
