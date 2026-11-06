export class StoreUnavailableError extends Error {}

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  list<T>(prefix: string): Promise<Array<{ key: string; value: T }>>;
}

// Talks to the coordinator over HTTP. Services never see storage nodes directly.
export class CoordinatorStore implements KeyValueStore {
  constructor(private readonly baseUrl: string) {}

  private async send(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(3000) });
    } catch (err) {
      throw new StoreUnavailableError(`coordinator unreachable: ${String(err)}`);
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    const res = await this.send(`/internal/data/${encodeURIComponent(key)}`);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new StoreUnavailableError(`GET ${key} failed with ${res.status}`);
    return (await res.json()) as T;
  }

  async put(key: string, value: unknown): Promise<void> {
    const res = await this.send(`/internal/data/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    if (!res.ok) throw new StoreUnavailableError(`PUT ${key} failed with ${res.status}`);
  }

  async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    const res = await this.send(`/internal/list?prefix=${encodeURIComponent(prefix)}`);
    if (!res.ok) throw new StoreUnavailableError(`LIST ${prefix} failed with ${res.status}`);
    return (await res.json()) as Array<{ key: string; value: T }>;
  }
}

// In-memory store for unit tests.
export class MemoryStore implements KeyValueStore {
  private data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.has(key) ? (structuredClone(this.data.get(key)) as T) : undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    return [...this.data.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value: structuredClone(value) as T }));
  }
}
