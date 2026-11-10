export class StoreUnavailableError extends Error {}

export interface VersionedValue<T> {
  value: T;
  version: number;
}

export interface ListEntry<T> {
  key: string;
  value: T;
  version: number;
}

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  getWithVersion<T>(key: string): Promise<VersionedValue<T> | undefined>;
  put(key: string, value: unknown): Promise<void>;
  // Compare-and-set: writes only if the key is still at `expectedVersion`
  // (null means "must not exist yet"). Returns false when someone else changed it first.
  cas(key: string, expectedVersion: number | null, value: unknown): Promise<boolean>;
  list<T>(prefix: string): Promise<Array<ListEntry<T>>>;
}

export class UpdateConflictError extends Error {}

// Read-modify-write that is safe against concurrent writers: retries on CAS conflicts.
// `change` returns the new value, or the same object to leave the record untouched.
// Resolves to undefined when the key does not exist.
export async function updateRecord<T>(
  store: KeyValueStore,
  key: string,
  change: (current: T) => T,
  attempts = 10,
): Promise<T | undefined> {
  for (let i = 0; i < attempts; i++) {
    const current = await store.getWithVersion<T>(key);
    if (!current) return undefined;
    const next = change(current.value);
    if (next === current.value) return next;
    if (await store.cas(key, current.version, next)) return next;
  }
  throw new UpdateConflictError(`could not update ${key}: too many concurrent changes`);
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

  async getWithVersion<T>(key: string): Promise<VersionedValue<T> | undefined> {
    const res = await this.send(`/internal/data/${encodeURIComponent(key)}`);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new StoreUnavailableError(`GET ${key} failed with ${res.status}`);
    return { value: (await res.json()) as T, version: Number(res.headers.get("x-version") ?? 0) };
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await this.getWithVersion<T>(key))?.value;
  }

  async put(key: string, value: unknown): Promise<void> {
    const res = await this.send(`/internal/data/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    if (!res.ok) throw new StoreUnavailableError(`PUT ${key} failed with ${res.status}`);
  }

  async cas(key: string, expectedVersion: number | null, value: unknown): Promise<boolean> {
    const res = await this.send(`/internal/cas/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion, value }),
    });
    if (res.status === 409) return false;
    if (!res.ok) throw new StoreUnavailableError(`CAS ${key} failed with ${res.status}`);
    return true;
  }

  async list<T>(prefix: string): Promise<Array<ListEntry<T>>> {
    const res = await this.send(`/internal/list?prefix=${encodeURIComponent(prefix)}`);
    if (!res.ok) throw new StoreUnavailableError(`LIST ${prefix} failed with ${res.status}`);
    return (await res.json()) as Array<ListEntry<T>>;
  }

  // Cluster health as reported by the coordinator (used by the status page).
  async health(): Promise<unknown> {
    const res = await this.send("/health");
    if (!res.ok) throw new StoreUnavailableError(`health failed with ${res.status}`);
    return res.json();
  }
}

// In-memory store for unit tests. Operations are atomic, like the coordinator's.
export class MemoryStore implements KeyValueStore {
  private data = new Map<string, VersionedValue<unknown>>();
  private counter = 0;

  async getWithVersion<T>(key: string): Promise<VersionedValue<T> | undefined> {
    const entry = this.data.get(key);
    return entry ? { value: structuredClone(entry.value) as T, version: entry.version } : undefined;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await this.getWithVersion<T>(key))?.value;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, { value: structuredClone(value), version: ++this.counter });
  }

  async cas(key: string, expectedVersion: number | null, value: unknown): Promise<boolean> {
    const current = this.data.get(key)?.version ?? null;
    if (current !== expectedVersion) return false;
    this.data.set(key, { value: structuredClone(value), version: ++this.counter });
    return true;
  }

  async list<T>(prefix: string): Promise<Array<ListEntry<T>>> {
    return [...this.data.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, e]) => ({ key, value: structuredClone(e.value) as T, version: e.version }));
  }
}
