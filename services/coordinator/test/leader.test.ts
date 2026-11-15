import { describe, expect, it } from "vitest";
import { LeaderElector, type LeaseBackend, type LeaseState } from "../src/leader";

// An in-memory lease with the same compare-and-swap rules as the Kubernetes one.
class FakeLease implements LeaseBackend {
  state: { holder: string | null; version: number } | null = null;
  unreachable = false;
  private guard() {
    if (this.unreachable) throw new Error("api server unreachable");
  }
  async read(): Promise<LeaseState | null> {
    this.guard();
    return this.state && { holder: this.state.holder, version: String(this.state.version) };
  }
  async create(holder: string) {
    this.guard();
    if (this.state) return false;
    this.state = { holder, version: 1 };
    return true;
  }
  async update(holder: string, version: string) {
    this.guard();
    if (!this.state || String(this.state.version) !== version) return false;
    this.state = { holder: holder || null, version: this.state.version + 1 };
    return true;
  }
}

function pair() {
  const lease = new FakeLease();
  let now = 0;
  const make = (id: string) =>
    new LeaderElector(lease, { id, leaseMs: 15_000, renewDeadlineMs: 9_000, retryMs: 2_000, now: () => now });
  return { lease, a: make("a"), b: make("b"), advance: (ms: number) => (now += ms) };
}

describe("leader election", () => {
  it("exactly one of two coordinators becomes leader, and keeps it while renewing", async () => {
    const { a, b, advance } = pair();
    await a.tick();
    await b.tick();
    expect([a.isLeader(), b.isLeader()]).toEqual([true, false]);
    for (let i = 0; i < 20; i++) {
      advance(2_000);
      await a.tick();
      await b.tick();
    }
    expect([a.isLeader(), b.isLeader()]).toEqual([true, false]);
  });

  it("a follower takes over only after the lease has gone unrenewed for the full lease time", async () => {
    const { a, b, advance } = pair();
    await a.tick();
    await b.tick();
    // a stops renewing (crashed). b watches the lease not change.
    advance(10_000);
    await b.tick();
    expect(b.isLeader()).toBe(false);
    advance(6_000);
    await b.tick();
    expect(b.isLeader()).toBe(true);
  });

  it("a leader that cannot reach the lease store steps down before a follower can take over", async () => {
    const { lease, a, b, advance } = pair();
    await a.tick();
    await b.tick();
    lease.unreachable = true;
    advance(5_000);
    await a.tick();
    expect(a.isLeader()).toBe(true); // within the renew deadline
    advance(5_000); // 10 s since the last renewal, deadline is 9 s
    await a.tick();
    expect(a.isLeader()).toBe(false);
    // The follower needs 15 s of an unchanged lease, so there was never a moment with two leaders.
    expect(b.isLeader()).toBe(false);
  });

  it("two racing candidates cannot both win", async () => {
    const { a, b } = pair();
    await Promise.all([a.tick(), b.tick()]);
    expect([a.isLeader(), b.isLeader()].filter(Boolean)).toHaveLength(1);
  });

  it("a leader that shuts down hands over at once", async () => {
    const { a, b } = pair();
    await a.tick();
    await b.tick();
    await a.stop();
    expect(a.isLeader()).toBe(false);
    await b.tick();
    expect(b.isLeader()).toBe(true);
  });

  it("reports leadership changes", async () => {
    const lease = new FakeLease();
    const seen: boolean[] = [];
    const e = new LeaderElector(lease, { id: "x", leaseMs: 1000, renewDeadlineMs: 600, retryMs: 100, onChange: (l) => seen.push(l) });
    await e.tick();
    await e.stop();
    expect(seen).toEqual([true, false]);
  });
});
