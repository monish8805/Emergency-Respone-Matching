import { describe, expect, it } from "vitest";
import amqp from "amqplib";
import net from "node:net";
import {
  DEAD_QUEUE,
  MATCH_QUEUE,
  MatchPublisher,
  RETRY_QUEUE,
  RETRY_DELAY_MS,
  assertTopology,
  retryRoute,
  startMatchConsumer,
  type MatchMessage,
} from "../src/rabbit";

describe("retryRoute", () => {
  it("retries until the attempt limit, then dead-letters", () => {
    expect(retryRoute(0, 3)).toEqual({ queue: RETRY_QUEUE, attempts: 1 });
    expect(retryRoute(1, 3)).toEqual({ queue: RETRY_QUEUE, attempts: 2 });
    expect(retryRoute(2, 3)).toEqual({ queue: DEAD_QUEUE, attempts: 3 });
  });
});

const silent = { log: () => {}, error: () => {} };

describe("MatchPublisher when the broker is unreachable or never answers", () => {
  it("gives up quickly on a broker that accepts connections but never speaks AMQP", async () => {
    // Like a stale Kubernetes ClusterIP: the TCP connection opens, nothing ever comes back.
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => void sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    const publisher = new MatchPublisher(`amqp://127.0.0.1:${port}`, silent, {
      connectTimeoutMs: 300,
      confirmTimeoutMs: 300,
      backoffMs: 1000,
    });
    try {
      const start = Date.now();
      await expect(publisher.publish({ requestId: "x" })).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(2500);
    } finally {
      sockets.forEach((socket) => socket.destroy());
      server.close();
    }
  });

  it("fails immediately for a short while after a failure instead of waiting again", async () => {
    const publisher = new MatchPublisher("amqp://127.0.0.1:1", silent, { backoffMs: 500 });
    await expect(publisher.publish({ requestId: "x" })).rejects.toThrow();
    const start = Date.now();
    await expect(publisher.publish({ requestId: "y" })).rejects.toThrow(/recent attempt failed/);
    expect(await publisher.check()).toBe(false);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("tries to connect again once the back-off has passed", async () => {
    const publisher = new MatchPublisher("amqp://127.0.0.1:1", silent, { backoffMs: 150 });
    await expect(publisher.publish({ requestId: "x" })).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 200));
    // Not the fast-fail error any more: it really attempted to reach the broker.
    await expect(publisher.publish({ requestId: "y" })).rejects.not.toThrow(/recent attempt failed/);
  });
});

// These need a real broker. Run with: RABBITMQ_URL=amqp://localhost:5672 npm test
const url = process.env.RABBITMQ_URL;
const quiet = { log: () => {}, error: () => {} };

async function withChannel<T>(fn: (ch: amqp.ConfirmChannel) => Promise<T>): Promise<T> {
  const conn = await amqp.connect(url!);
  try {
    const ch = await conn.createConfirmChannel();
    await assertTopology(ch);
    return await fn(ch);
  } finally {
    await conn.close();
  }
}
const purgeAll = () =>
  withChannel(async (ch) => {
    for (const q of [MATCH_QUEUE, RETRY_QUEUE, DEAD_QUEUE]) await ch.purgeQueue(q);
  });
const depth = (queue: string) => withChannel(async (ch) => (await ch.checkQueue(queue)).messageCount);
const until = async (what: string, fn: () => boolean | Promise<boolean>, ms = 20000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe.skipIf(!url)("RabbitMQ (live broker)", () => {
  it("delivers a confirmed, persistent message to the consumer", async () => {
    await purgeAll();
    const got: MatchMessage[] = [];
    const consumer = startMatchConsumer(url!, async (m) => void got.push(m), { log: quiet });
    const publisher = new MatchPublisher(url!, quiet);
    try {
      await publisher.publish({ requestId: "r1" });
      await until("delivery", () => got.length === 1);
      expect(got[0]).toEqual({ requestId: "r1" });
    } finally {
      await consumer.stop();
      await publisher.close();
    }
  });

  it("keeps messages while no consumer is running and delivers them later", async () => {
    await purgeAll();
    const publisher = new MatchPublisher(url!, quiet);
    await publisher.publish({ requestId: "waiting" });
    await publisher.close();
    expect(await depth(MATCH_QUEUE)).toBe(1);

    const got: string[] = [];
    const consumer = startMatchConsumer(url!, async (m) => void got.push(m.requestId), { log: quiet });
    try {
      await until("late delivery", () => got.includes("waiting"));
    } finally {
      await consumer.stop();
    }
  });

  it("retries a failing job after a delay and then succeeds", async () => {
    await purgeAll();
    let calls = 0;
    const consumer = startMatchConsumer(
      url!,
      async () => {
        if (++calls === 1) throw new Error("storage down");
      },
      { log: quiet },
    );
    const publisher = new MatchPublisher(url!, quiet);
    try {
      await publisher.publish({ requestId: "flaky" });
      await until("second attempt", () => calls === 2, RETRY_DELAY_MS + 15000);
      expect(await depth(DEAD_QUEUE)).toBe(0);
    } finally {
      await consumer.stop();
      await publisher.close();
    }
  }, 40000);

  it("moves a job that keeps failing to the dead-letter queue", async () => {
    await purgeAll();
    let calls = 0;
    const consumer = startMatchConsumer(
      url!,
      async () => {
        calls++;
        throw new Error("always fails");
      },
      { maxAttempts: 2, log: quiet },
    );
    const publisher = new MatchPublisher(url!, quiet);
    try {
      await publisher.publish({ requestId: "doomed" });
      await until("dead letter", async () => (await depth(DEAD_QUEUE)) === 1, RETRY_DELAY_MS + 15000);
      expect(calls).toBe(2);
      expect(await depth(MATCH_QUEUE)).toBe(0);
    } finally {
      await consumer.stop();
      await publisher.close();
    }
  }, 40000);

  it("dead-letters malformed messages instead of dropping them", async () => {
    await purgeAll();
    const consumer = startMatchConsumer(url!, async () => {}, { log: quiet });
    try {
      await withChannel(async (ch) => {
        ch.sendToQueue(MATCH_QUEUE, Buffer.from("not json"), { persistent: true });
        await ch.waitForConfirms();
      });
      await until("dead letter", async () => (await depth(DEAD_QUEUE)) === 1);
    } finally {
      await consumer.stop();
    }
  });

  it("publisher reports false when the broker is unreachable, without throwing at startup", async () => {
    const publisher = new MatchPublisher("amqp://127.0.0.1:1", quiet);
    expect(await publisher.check()).toBe(false);
    await expect(publisher.publish({ requestId: "x" })).rejects.toThrow();
  });
});
