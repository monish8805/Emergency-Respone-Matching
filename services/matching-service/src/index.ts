import express from "express";
import { CoordinatorStore, MATCH_QUEUE, connectChannel, type MatchMessage } from "@emergency/shared";
import { processMatch } from "./worker";

const port = Number(process.env.PORT ?? 3007);
const coordinatorUrl = process.env.COORDINATOR_URL ?? "http://localhost:3006";
const rabbitUrl = process.env.RABBITMQ_URL ?? "amqp://localhost:5672";

async function main() {
  const store = new CoordinatorStore(coordinatorUrl);
  const { ch } = await connectChannel(rabbitUrl);
  ch.prefetch(1);

  ch.consume(MATCH_QUEUE, async (msg) => {
    if (!msg) return;

    let message: MatchMessage;
    try {
      message = JSON.parse(msg.content.toString()) as MatchMessage;
    } catch {
      console.error("dropping malformed message");
      ch.ack(msg);
      return;
    }

    try {
      const outcome = await processMatch(message.requestId, store);
      console.log(`request ${message.requestId}: ${outcome}`);
      ch.ack(msg);
    } catch (err) {
      // Storage is unavailable: retry the message after a short pause.
      console.error(`match failed for ${message.requestId}, will retry`, err);
      setTimeout(() => ch.nack(msg, false, true), 1000);
    }
  });

  const health = express();
  health.get("/health", (_req, res) => res.json({ ok: true }));
  health.listen(port, () => console.log(`matching service consuming ${MATCH_QUEUE}, health on :${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
