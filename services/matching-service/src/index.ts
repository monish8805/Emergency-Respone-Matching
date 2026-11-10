import express from "express";
import { CoordinatorStore, MATCH_QUEUE, MatchPublisher, startMatchConsumer } from "@emergency/shared";
import { processMatch } from "./worker";
import { sweepPending } from "./sweeper";

const port = Number(process.env.PORT ?? 3007);
const coordinatorUrl = process.env.COORDINATOR_URL ?? "http://localhost:3006";
const rabbitUrl = process.env.RABBITMQ_URL ?? "amqp://localhost:5672";
const sweepMs = Number(process.env.SWEEP_MS ?? 15000);
const radiusKm = Number(process.env.MATCH_RADIUS_KM ?? 5);
const sweepMinAgeMs = Number(process.env.SWEEP_MIN_AGE_MS ?? 10000);

const store = new CoordinatorStore(coordinatorUrl);

// Throwing here sends the job to the retry queue (and eventually the dead-letter queue).
const consumer = startMatchConsumer(rabbitUrl, async ({ requestId }) => {
  const outcome = await processMatch(requestId, store, { radiusKm });
  console.log(`request ${requestId}: ${outcome}`);
});

// Safety net: re-queue requests that are still PENDING (see sweeper.ts).
const publisher = new MatchPublisher(rabbitUrl);
let sweeping = false;
const sweepTimer = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    const queued = await sweepPending(store, (requestId) => publisher.publish({ requestId }), sweepMinAgeMs);
    if (queued > 0) console.log(`sweeper re-queued ${queued} pending request(s)`);
  } catch (err) {
    console.error(`sweeper failed: ${String(err)}`);
  } finally {
    sweeping = false;
  }
}, sweepMs);

const health = express();
health.get("/", (_req, res) => res.json({ service: "matching-service", health: "/health" }));
health.get("/health", (_req, res) => res.json({ ok: true, consuming: consumer.consuming, queue: MATCH_QUEUE }));
const server = health.listen(port, () => console.log(`matching service health on :${port}`));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    clearInterval(sweepTimer);
    server.close();
    void Promise.all([consumer.stop(), publisher.close()]).finally(() => process.exit(0));
  });
}
