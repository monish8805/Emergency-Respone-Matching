import { CoordinatorStore, MatchPublisher } from "@emergency/shared";
import { createRequestApp } from "./app";

const port = Number(process.env.PORT ?? 3005);
const coordinatorUrl = process.env.COORDINATOR_URL ?? "http://localhost:3006";
const rabbitUrl = process.env.RABBITMQ_URL ?? "amqp://localhost:5672";

// The publisher connects lazily and reconnects on its own, so this service starts
// (and keeps serving reads) even while RabbitMQ is down.
const store = new CoordinatorStore(coordinatorUrl);
const publisher = new MatchPublisher(rabbitUrl);

const app = createRequestApp({
  store,
  publishMatch: (requestId) => publisher.publish({ requestId }),
  checkRabbit: () => publisher.check(),
  coordinatorHealth: () => store.health(),
});

const server = app.listen(port, () => console.log(`request service on :${port}`));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close();
    void publisher.close().finally(() => process.exit(0));
  });
}
