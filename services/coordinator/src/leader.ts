import { readFileSync } from "node:fs";

// What a leader lease looks like to the elector. `version` changes on every write and is what
// makes updates safe: an update names the version it read and fails if someone else wrote since.
export interface LeaseState {
  holder: string | null;
  version: string;
}

export interface LeaseBackend {
  read(): Promise<LeaseState | null>;
  // Both resolve to false when another coordinator won the race (the write was rejected).
  create(holder: string): Promise<boolean>;
  update(holder: string, version: string): Promise<boolean>;
}

export interface LeaderOptions {
  id: string;
  // The lease is lost by everyone else if it is not renewed for this long.
  leaseMs: number;
  // A leader that could not renew for this long stops acting as leader. Must be shorter than
  // leaseMs, so the old leader steps down before a new one can take over.
  renewDeadlineMs: number;
  retryMs: number;
  now?: () => number;
  onChange?: (leader: boolean) => void;
}

// Lease-based leader election (the same scheme Kubernetes controllers use). Only the holder of the
// lease acts as coordinator. Expiry is judged on this process's own clock from when it last saw the
// lease change, so clock differences between pods do not matter.
export class LeaderElector {
  private leader = false;
  private lastRenewed = 0;
  private observedVersion: string | null = null;
  private observedAt = 0;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly now: () => number;

  constructor(
    private readonly backend: LeaseBackend,
    private readonly options: LeaderOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  isLeader(): boolean {
    // Also checked on read: if the loop is stuck (slow API server), leadership still lapses on time.
    if (this.leader && this.now() - this.lastRenewed > this.options.renewDeadlineMs) this.set(false);
    return this.leader;
  }

  private set(value: boolean) {
    if (this.leader === value) return;
    this.leader = value;
    console.log(`coordinator ${this.options.id} is ${value ? "now the leader" : "no longer the leader"}`);
    this.options.onChange?.(value);
  }

  // One round: take the lease if it is free or expired, renew it if it is ours.
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { id, leaseMs } = this.options;
      const lease = await this.backend.read();
      const t = this.now();
      if (!lease) {
        if (await this.backend.create(id)) this.won(t);
        else this.lost();
        return;
      }
      if (lease.version !== this.observedVersion) {
        this.observedVersion = lease.version;
        this.observedAt = t;
      }
      if (lease.holder === id) {
        if (await this.backend.update(id, lease.version)) this.won(t);
        else this.lost();
        return;
      }
      const expired = lease.holder === null || t - this.observedAt > leaseMs;
      if (expired && (await this.backend.update(id, lease.version))) this.won(t);
      else this.lost();
    } catch (err) {
      // Could not reach the lease store: keep leadership only until the renew deadline passes.
      console.error(`leader election: ${String(err)}`);
      this.isLeader();
    } finally {
      this.running = false;
    }
  }

  private won(t: number) {
    this.lastRenewed = t;
    this.observedVersion = null; // our own write changed the version; re-observe on the next read
    this.set(true);
  }

  private lost() {
    this.set(false);
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.retryMs);
  }

  // Stops, and if this coordinator holds the lease gives it up right away, so another one takes
  // over within a retry interval instead of waiting for the lease to expire.
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const wasLeader = this.leader;
    this.set(false);
    if (!wasLeader) return;
    try {
      const lease = await this.backend.read();
      if (lease?.holder === this.options.id) await this.backend.update("", lease.version);
    } catch (err) {
      console.error(`could not release the lease: ${String(err)}`);
    }
  }
}

// Reads and writes a Kubernetes Lease object (coordination.k8s.io/v1) with the pod's service
// account. TLS to the API server is trusted through NODE_EXTRA_CA_CERTS (set in the manifest).
export class KubernetesLease implements LeaseBackend {
  private readonly base: string;
  private readonly token: () => string;

  constructor(
    private readonly name: string,
    private readonly namespace: string,
    private readonly leaseSeconds: number,
    apiUrl = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`,
    tokenFile = "/var/run/secrets/kubernetes.io/serviceaccount/token",
  ) {
    this.base = `${apiUrl}/apis/coordination.k8s.io/v1/namespaces/${namespace}/leases`;
    this.token = () => readFileSync(tokenFile, "utf8").trim(); // re-read: the token is rotated
  }

  private async api(path: string, method: string, body?: unknown): Promise<Response> {
    return fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token()}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
  }

  private object(holder: string, version?: string) {
    return {
      apiVersion: "coordination.k8s.io/v1",
      kind: "Lease",
      metadata: { name: this.name, namespace: this.namespace, ...(version ? { resourceVersion: version } : {}) },
      spec: { holderIdentity: holder, leaseDurationSeconds: this.leaseSeconds, renewTime: microTime() },
    };
  }

  async read(): Promise<LeaseState | null> {
    const res = await this.api(`/${this.name}`, "GET");
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`reading the lease failed with ${res.status}`);
    const lease = (await res.json()) as { metadata: { resourceVersion: string }; spec?: { holderIdentity?: string } };
    return { holder: lease.spec?.holderIdentity || null, version: lease.metadata.resourceVersion };
  }

  async create(holder: string): Promise<boolean> {
    const res = await this.api("", "POST", this.object(holder));
    if (res.status === 409) return false;
    if (!res.ok) throw new Error(`creating the lease failed with ${res.status}`);
    return true;
  }

  async update(holder: string, version: string): Promise<boolean> {
    // Naming the resourceVersion makes this a compare-and-swap: a concurrent writer gets a 409.
    const res = await this.api(`/${this.name}`, "PUT", this.object(holder, version));
    if (res.status === 409) return false;
    if (!res.ok) throw new Error(`updating the lease failed with ${res.status}`);
    return true;
  }
}

// Kubernetes MicroTime: RFC 3339 with six fractional digits.
function microTime(): string {
  return new Date().toISOString().replace("Z", "000Z");
}
