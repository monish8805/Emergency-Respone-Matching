import amqp, { type ConfirmChannel, type ConsumeMessage } from "amqplib";
import { matchMessageSchema } from "./schemas";

// Topology:
//   match.requests      work queue (durable)
//   match.retry         failed jobs wait here for RETRY_DELAY_MS, then dead-letter back to match.requests
//   match.requests.dlq  jobs that failed MAX_ATTEMPTS times, or could not be parsed, kept for inspection
export const MATCH_QUEUE = "match.requests";
export const RETRY_QUEUE = "match.retry";
export const DEAD_QUEUE = "match.requests.dlq";
export const MAX_ATTEMPTS = 5;
export const RETRY_DELAY_MS = 5000;

export interface MatchMessage {
  requestId: string;
}

type Conn = Awaited<ReturnType<typeof amqp.connect>>;
type Logger = Pick<Console, "log" | "error">;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface BrokerTimeouts {
  // Give up connecting after this long (a stale Kubernetes ClusterIP can swallow SYNs for minutes).
  connectTimeoutMs: number;
  // Give up waiting for the broker to confirm a publish.
  confirmTimeoutMs: number;
  // After a failure, fail immediately for this long instead of waiting on the broker again.
  backoffMs: number;
}

const DEFAULT_TIMEOUTS: BrokerTimeouts = { connectTimeoutMs: 5000, confirmTimeoutMs: 5000, backoffMs: 3000 };

// amqplib disables heartbeats unless the URL asks for them, which means a silently dead
// broker connection is never noticed. Ask for a 10 second heartbeat by default.
function withHeartbeat(url: string): string {
  try {
    const u = new URL(url);
    if (!u.searchParams.has("heartbeat")) u.searchParams.set("heartbeat", "10");
    return u.toString();
  } catch {
    return url;
  }
}

const connectBroker = (url: string, connectTimeoutMs: number) =>
  amqp.connect(withHeartbeat(url), { timeout: connectTimeoutMs });

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function assertTopology(ch: ConfirmChannel, retryDelayMs = RETRY_DELAY_MS): Promise<void> {
  await ch.assertQueue(MATCH_QUEUE, { durable: true });
  await ch.assertQueue(DEAD_QUEUE, { durable: true });
  await ch.assertQueue(RETRY_QUEUE, {
    durable: true,
    arguments: {
      "x-message-ttl": retryDelayMs,
      "x-dead-letter-exchange": "",
      "x-dead-letter-routing-key": MATCH_QUEUE,
    },
  });
}

// Sends and waits for the broker's confirm, so "published" means "safely queued".
function confirmedSend(
  ch: ConfirmChannel,
  queue: string,
  content: Buffer,
  headers?: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUTS.confirmTimeoutMs,
): Promise<void> {
  return within(
    new Promise<void>((resolve, reject) => {
      ch.sendToQueue(queue, content, { persistent: true, contentType: "application/json", headers }, (err) =>
        err ? reject(err) : resolve(),
      );
    }),
    timeoutMs,
    `publish to ${queue}`,
  );
}

// Decides where a failed job goes next. Pure so it can be tested without a broker.
export function retryRoute(
  previousAttempts: number,
  maxAttempts = MAX_ATTEMPTS,
): { queue: string; attempts: number } {
  const attempts = previousAttempts + 1;
  return { queue: attempts >= maxAttempts ? DEAD_QUEUE : RETRY_QUEUE, attempts };
}

// Publisher that connects lazily and reconnects after the broker goes away.
// Startup never fails just because RabbitMQ is not up yet, and a broker outage never makes
// callers wait: connecting and confirming are time-limited, and after a failure further
// calls fail at once for a short while instead of waiting on the broker again.
export class MatchPublisher {
  private conn: Conn | null = null;
  private ch: ConfirmChannel | null = null;
  private opening: Promise<ConfirmChannel> | null = null;
  private failedAt = 0;
  private readonly timeouts: BrokerTimeouts;

  constructor(
    private readonly url: string,
    private readonly log: Logger = console,
    timeouts: Partial<BrokerTimeouts> = {},
  ) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
  }

  private reset(): void {
    const conn = this.conn;
    this.conn = null;
    this.ch = null;
    conn?.close().catch(() => {});
  }

  private recentlyFailed(): boolean {
    return this.failedAt > 0 && Date.now() - this.failedAt < this.timeouts.backoffMs;
  }

  private open(): Promise<ConfirmChannel> {
    if (this.ch) return Promise.resolve(this.ch);
    this.opening ??= (async () => {
      try {
        const conn = await connectBroker(this.url, this.timeouts.connectTimeoutMs);
        const ch = await within(conn.createConfirmChannel(), this.timeouts.connectTimeoutMs, "opening channel");
        await within(assertTopology(ch), this.timeouts.connectTimeoutMs, "declaring queues");
        const lost = (why: string) => (err?: unknown) => {
          if (this.conn !== conn) return;
          this.log.error(`RabbitMQ publisher ${why}`, err ?? "");
          this.conn = null;
          this.ch = null;
        };
        conn.on("error", lost("connection error"));
        conn.on("close", lost("connection closed"));
        ch.on("error", lost("channel error"));
        this.conn = conn;
        this.ch = ch;
        this.failedAt = 0;
        return ch;
      } catch (err) {
        this.failedAt = Date.now();
        throw err;
      } finally {
        this.opening = null;
      }
    })();
    return this.opening;
  }

  async publish(message: MatchMessage): Promise<void> {
    if (this.recentlyFailed()) throw new Error("RabbitMQ unavailable (a recent attempt failed)");
    const content = Buffer.from(JSON.stringify(message));
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      // A second try only makes sense if the first used a connection that may have gone stale.
      const hadConnection = this.ch !== null;
      try {
        const ch = await this.open();
        await confirmedSend(ch, MATCH_QUEUE, content, undefined, this.timeouts.confirmTimeoutMs);
        return;
      } catch (err) {
        lastError = err;
        this.reset();
        if (!hadConnection) break;
      }
    }
    this.failedAt = Date.now();
    throw lastError;
  }

  // True when a broker connection can be established right now.
  async check(): Promise<boolean> {
    if (this.recentlyFailed()) return false;
    try {
      await this.open();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.reset();
  }
}

export interface MatchConsumer {
  readonly consuming: boolean;
  stop(): Promise<void>;
}

// Consumes match jobs and keeps doing so across broker restarts.
// handler resolves = ack. handler throws = the job goes to the retry queue, and after
// MAX_ATTEMPTS to the dead-letter queue. A job is only acked once its retry copy is confirmed.
export function startMatchConsumer(
  url: string,
  handler: (message: MatchMessage) => Promise<void>,
  options: { maxAttempts?: number; reconnectMs?: number; log?: Logger } = {},
): MatchConsumer {
  const { maxAttempts = MAX_ATTEMPTS, reconnectMs = 2000, log = console } = options;
  let stopped = false;
  let consuming = false;
  let conn: Conn | null = null;

  async function onMessage(ch: ConfirmChannel, msg: ConsumeMessage) {
    const headers = msg.properties.headers ?? {};
    let message: MatchMessage;
    try {
      message = matchMessageSchema.parse(JSON.parse(msg.content.toString()));
    } catch {
      log.error("malformed match message, moving to dead-letter queue");
      await settle(ch, msg, DEAD_QUEUE, { ...headers, "x-last-error": "malformed message" });
      return;
    }
    try {
      await handler(message);
      ch.ack(msg);
    } catch (err) {
      const route = retryRoute(Number(headers["x-attempts"] ?? 0), maxAttempts);
      log.error(`match job ${message.requestId} failed (attempt ${route.attempts}), sending to ${route.queue}: ${String(err)}`);
      await settle(ch, msg, route.queue, {
        ...headers,
        "x-attempts": route.attempts,
        "x-last-error": String(err).slice(0, 200),
      });
    }
  }

  async function settle(ch: ConfirmChannel, msg: ConsumeMessage, queue: string, headers: Record<string, unknown>) {
    try {
      await confirmedSend(ch, queue, msg.content, headers);
      ch.ack(msg);
    } catch (err) {
      // Could not park the job: hand it back to the broker so it is not lost.
      log.error(`could not move job to ${queue}, requeueing: ${String(err)}`);
      try {
        ch.nack(msg, false, true);
      } catch {
        // Channel already closed: the broker requeues unacked messages itself.
      }
    }
  }

  async function loop() {
    while (!stopped) {
      try {
        const c = await connectBroker(url, DEFAULT_TIMEOUTS.connectTimeoutMs);
        conn = c;
        const ch = await c.createConfirmChannel();
        await assertTopology(ch);
        await ch.prefetch(1);
        const closed = new Promise<void>((resolve) => {
          c.on("close", () => resolve());
          c.on("error", (err: unknown) => log.error(`RabbitMQ consumer connection error: ${String(err)}`));
          ch.on("error", (err: unknown) => log.error(`RabbitMQ consumer channel error: ${String(err)}`));
          ch.on("close", () => resolve());
        });
        await ch.consume(MATCH_QUEUE, (msg) => {
          if (msg) void onMessage(ch, msg);
        });
        consuming = true;
        log.log(`consuming ${MATCH_QUEUE}`);
        await closed;
        consuming = false;
        log.error("RabbitMQ connection lost, reconnecting");
      } catch (err) {
        consuming = false;
        log.log(`RabbitMQ not ready, retrying: ${String(err)}`);
      }
      if (!stopped) await sleep(reconnectMs);
    }
  }

  void loop();

  return {
    get consuming() {
      return consuming;
    },
    async stop() {
      stopped = true;
      await conn?.close().catch(() => {});
    },
  };
}
