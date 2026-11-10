import type { NodeConfig } from "@emergency/shared";

// up      in sync, serves reads and writes
// syncing alive but not yet verified: receives writes (so it misses nothing) but serves no reads
// down    no heartbeat, or unreachable: gets nothing until it heartbeats again
export type NodeStatus = "up" | "syncing" | "down";

interface NodeState {
  config: NodeConfig;
  lastSeen: number;
  status: NodeStatus;
  bootId?: string;
}

// Tracks which storage nodes are alive, based on heartbeats.
// Every node starts as "syncing": after a coordinator restart nobody is trusted
// until it has been reconciled with its shard peer.
export class NodeRegistry {
  private nodes = new Map<string, NodeState>();

  constructor(
    configs: NodeConfig[],
    private readonly timeoutMs: number,
    private readonly now: () => number = Date.now,
  ) {
    const start = now();
    for (const config of configs) {
      this.nodes.set(config.id, { config, lastSeen: start, status: "syncing" });
    }
  }

  shardCount(): number {
    let max = -1;
    for (const s of this.nodes.values()) max = Math.max(max, s.config.shard);
    return max + 1;
  }

  get(id: string): NodeConfig | undefined {
    return this.nodes.get(id)?.config;
  }

  statusOf(id: string): NodeStatus | undefined {
    return this.nodes.get(id)?.status;
  }

  private inShard(shard: number, accept: (s: NodeState) => boolean): NodeConfig[] {
    return [...this.nodes.values()].filter((s) => s.config.shard === shard && accept(s)).map((s) => s.config);
  }

  // Nodes that may serve reads, in config order (the first one is the shard's primary).
  liveNodes(shard: number): NodeConfig[] {
    return this.inShard(shard, (s) => s.status === "up");
  }

  // Nodes that must receive writes: everything alive, including nodes still catching up.
  writeNodes(shard: number): NodeConfig[] {
    return this.inShard(shard, (s) => s.status !== "down");
  }

  // Nodes this node can reconcile with: its shard peers that are not down.
  peersOf(id: string): NodeConfig[] {
    const self = this.nodes.get(id);
    if (!self) return [];
    return this.inShard(self.config.shard, (s) => s.config.id !== id && s.status !== "down");
  }

  // Records a heartbeat. A node that was down, or restarted (new bootId), goes back to
  // "syncing" and needs reconciling. "recovered" is true while the node is not yet "up".
  heartbeat(id: string, bootId?: string): { known: boolean; recovered: boolean; status?: NodeStatus } {
    const s = this.nodes.get(id);
    if (!s) return { known: false, recovered: false };
    const restarted = s.bootId !== undefined && bootId !== undefined && s.bootId !== bootId;
    if (s.status === "down" || restarted) s.status = "syncing";
    s.lastSeen = this.now();
    s.bootId = bootId ?? s.bootId;
    return { known: true, recovered: s.status === "syncing", status: s.status };
  }

  bootIdOf(id: string): string | undefined {
    return this.nodes.get(id)?.bootId;
  }

  // Called when reconciliation finished. Ignored if the node restarted or went down meanwhile,
  // because the work was done against a previous incarnation.
  markSynced(id: string, bootId: string | undefined): boolean {
    const s = this.nodes.get(id);
    if (!s || s.status !== "syncing" || s.bootId !== bootId) return false;
    s.status = "up";
    return true;
  }

  markDown(id: string): void {
    const s = this.nodes.get(id);
    if (s) s.status = "down";
  }

  // Marks nodes down when their heartbeats stop. Returns newly downed node ids.
  checkTimeouts(): string[] {
    const downed: string[] = [];
    for (const [id, s] of this.nodes) {
      if (s.status !== "down" && this.now() - s.lastSeen > this.timeoutMs) {
        s.status = "down";
        downed.push(id);
      }
    }
    return downed;
  }

  statuses() {
    return [...this.nodes.values()].map((s) => ({
      id: s.config.id,
      shard: s.config.shard,
      status: s.status,
      down: s.status === "down",
      lastSeen: new Date(s.lastSeen).toISOString(),
    }));
  }
}
