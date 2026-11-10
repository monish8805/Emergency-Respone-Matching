import {
  DEFAULT_RADIUS_KM,
  rankMatches,
  requestKey,
  resourceKey,
  RESOURCE_PREFIX,
  updateRecord,
  type EmergencyRequest,
  type KeyValueStore,
  type Resource,
} from "@emergency/shared";

export type MatchOutcome = "assigned" | "no-match" | "skipped";

// Handles one match job. Only PENDING requests are processed, so a redelivered or
// duplicate job is harmless.
//
// Safe under concurrency: a resource is claimed with compare-and-set, so when two
// matchers race for the same resource exactly one wins and the other moves on to the
// next candidate. The claim records which request owns the resource, so a matcher that
// crashed between claiming and finishing is completed by the next attempt instead of
// leaking the resource.
export async function processMatch(
  requestId: string,
  store: KeyValueStore,
  options: { radiusKm?: number } = {},
): Promise<MatchOutcome> {
  const current = await store.getWithVersion<EmergencyRequest>(requestKey(requestId));
  if (!current || current.value.status !== "PENDING") return "skipped";
  const request = current.value;

  const entries = await store.list<Resource>(RESOURCE_PREFIX);

  // A previous attempt may have claimed a resource and died before updating the request.
  const claimed = entries.find((e) => e.value.assignedRequestId === request.id && e.value.status === "ASSIGNED");
  if (claimed) {
    const fit = rankMatches({ ...request }, [{ ...claimed.value, status: "AVAILABLE", availability: true }], Infinity)[0];
    return finish(store, current.version, request, claimed.value, fit?.distanceKm ?? null);
  }

  // Nearest resource first; zone-name matches have no distance.
  const candidates = rankMatches(
    request,
    entries.map((e) => e.value),
    options.radiusKm ?? DEFAULT_RADIUS_KM,
  );
  for (const { resource: candidate, distanceKm } of candidates) {
    const version = entries.find((e) => e.value.id === candidate.id)!.version;
    const won = await store.cas(resourceKey(candidate.id), version, {
      ...candidate,
      status: "ASSIGNED",
      availability: false,
      assignedRequestId: request.id,
    });
    if (won) return finish(store, current.version, request, candidate, distanceKm);
    // Someone else claimed it first: try the next resource.
  }
  return "no-match";
}

async function finish(
  store: KeyValueStore,
  requestVersion: number,
  request: EmergencyRequest,
  resource: Resource,
  distanceKm: number | null,
): Promise<MatchOutcome> {
  const ok = await store.cas(requestKey(request.id), requestVersion, {
    ...request,
    status: "ASSIGNED",
    resourceId: resource.id,
    distanceKm,
  });
  if (ok) return "assigned";

  // The request changed under us (cancelled, or matched by another worker). Undo the claim.
  await updateRecord<Resource>(store, resourceKey(resource.id), (r) =>
    r.assignedRequestId === request.id
      ? { ...r, status: "AVAILABLE", availability: true, assignedRequestId: null }
      : r,
  );
  return "skipped";
}
