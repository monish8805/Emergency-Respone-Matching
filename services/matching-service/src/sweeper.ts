import {
  DEFAULT_RADIUS_KM,
  REQUEST_PREFIX,
  RESOURCE_PREFIX,
  rankMatches,
  type EmergencyRequest,
  type KeyValueStore,
  type Resource,
} from "@emergency/shared";

// Safety net: re-queues requests that are still PENDING after minAgeMs, so a job that was never
// published (broker down) or got lost is not stuck forever, and a request that waited for a
// resource gets matched once one is registered.
//
// It only queues a request when queueing can achieve something:
//  - a free resource could serve it now, or
//  - a crashed matcher left a half-finished claim for it (the next match attempt completes it).
// Requests nobody can serve yet are skipped, so unmatchable requests cost nothing instead of
// being matched again and again on every sweep (which grew with pending requests x matchers).
// Duplicates are harmless: matching is idempotent.
export async function sweepPending(
  store: KeyValueStore,
  publish: (requestId: string) => Promise<void>,
  minAgeMs: number,
  options: { radiusKm?: number; now?: () => number } = {},
): Promise<number> {
  const { radiusKm = DEFAULT_RADIUS_KM, now = Date.now } = options;
  const requests = (await store.list<EmergencyRequest>(REQUEST_PREFIX))
    .map((e) => e.value)
    .filter((r) => r.status === "PENDING" && now() - Date.parse(r.createdAt) >= minAgeMs);
  if (requests.length === 0) return 0;

  const resources = (await store.list<Resource>(RESOURCE_PREFIX)).map((e) => e.value);
  let queued = 0;
  for (const request of requests) {
    const halfClaimed = resources.some((r) => r.assignedRequestId === request.id && r.status === "ASSIGNED");
    if (!halfClaimed && rankMatches(request, resources, radiusKm).length === 0) continue;
    await publish(request.id);
    queued++;
  }
  return queued;
}
