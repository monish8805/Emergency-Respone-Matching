import { REQUEST_PREFIX, type EmergencyRequest, type KeyValueStore } from "@emergency/shared";

// Re-queues requests that are still PENDING after minAgeMs. This covers jobs that were never
// published (broker was down), requests with no match yet (a resource may have been added
// since), and jobs lost for any other reason. Duplicates are harmless: matching is idempotent.
export async function sweepPending(
  store: KeyValueStore,
  publish: (requestId: string) => Promise<void>,
  minAgeMs: number,
  now: () => number = Date.now,
): Promise<number> {
  const entries = await store.list<EmergencyRequest>(REQUEST_PREFIX);
  const stale = entries
    .map((e) => e.value)
    .filter((r) => r.status === "PENDING" && now() - Date.parse(r.createdAt) >= minAgeMs);
  let queued = 0;
  for (const request of stale) {
    await publish(request.id);
    queued++;
  }
  return queued;
}
