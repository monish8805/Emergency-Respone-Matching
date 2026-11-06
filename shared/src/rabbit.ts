import amqp from "amqplib";

export const MATCH_QUEUE = "match.requests";

export interface MatchMessage {
  requestId: string;
}

// Connects to RabbitMQ, retrying while the broker starts up.
export async function connectChannel(url: string, attempts = 30, delayMs = 2000) {
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const conn = await amqp.connect(url);
      const ch = await conn.createChannel();
      await ch.assertQueue(MATCH_QUEUE, { durable: true });
      return { conn, ch };
    } catch (err) {
      lastError = err;
      console.log(`RabbitMQ not ready (attempt ${i}/${attempts}), retrying...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
