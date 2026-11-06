import { CoordinatorStore, MATCH_QUEUE, connectChannel, type MatchMessage } from "@emergency/shared";
import { createRequestApp } from "./app";

const port = Number(process.env.PORT ?? 3005);
const coordinatorUrl = process.env.COORDINATOR_URL ?? "http://localhost:3006";
const rabbitUrl = process.env.RABBITMQ_URL ?? "amqp://localhost:5672";

async function main() {
  const { ch } = await connectChannel(rabbitUrl);
  const store = new CoordinatorStore(coordinatorUrl);

  const publishMatch = async (requestId: string) => {
    const message: MatchMessage = { requestId };
    ch.sendToQueue(MATCH_QUEUE, Buffer.from(JSON.stringify(message)), { persistent: true });
  };

  const app = createRequestApp({ store, publishMatch });
  app.listen(port, () => console.log(`request service on :${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
