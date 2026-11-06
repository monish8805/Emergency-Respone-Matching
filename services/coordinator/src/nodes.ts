import type { NodeConfig } from "@emergency/shared";

interface NodeState {
  config: NodeConfig;
  lastSeen: number;
  down: boolean;
  bootId?: string;
}

// Tracks which storage nodes are alive, based on heartbeats.
export class NodeRegistry {
  private nodes = new Map<string, NodeState>();

  constructor(
    configs: NodeConfig[],
    private readonly timeoutMs: number,
    private readonly now: () => number = Date.now,
  ) {
    const start = now();
    for (const config of configs) {
      this.nodes.set(config.id, { config, lastSeen: start, down: false });
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

  liveNodes(shard: number): NodeConfig[] {
    return [...this.nodes.values()]
      .filter((s) => s.config.shard === shard && !s.down)
      .map((s) => s.config);
  }

  // Records a heartbeat. "recovered" is true when the node was marked down
  // or restarted (new bootId), meaning its data may be stale and needs a sync.
  heartbeat(id: string, bootId?: string): { known: boolean; recovered: boolean } {
    const s = this.nodes.get(id);
    if (!s) return { known: false, recovered: false };
    const restarted = s.bootId !== undefined && bootId !== undefined && s.bootId !== bootId;
    const recovered = s.down || restarted;
    s.lastSeen = this.now();
    s.down = false;
    s.bootId = bootId ?? s.bootId;
    return { known: true, recovered };
  }

  markDown(id: string): void {
    const s = this.nodes.get(id);
    if (s) s.down = true;
  }

  // Marks nodes down when their heartbeats stop. Returns newly downed node ids.
  checkTimeouts(): string[] {
    const downed: string[] = [];
    for (const [id, s] of this.nodes) {
      if (!s.down && this.now() - s.lastSeen > this.timeoutMs) {
        s.down = true;
        downed.push(id);
      }
    }
    return downed;
  }

  statuses() {
    return [...this.nodes.values()].map((s) => ({
      id: s.config.id,
      shard: s.config.shard,
      down: s.down,
      lastSeen: new Date(s.lastSeen).toISOString(),
    }));
  }
}
