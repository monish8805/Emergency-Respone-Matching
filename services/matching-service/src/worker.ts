import {
  findMatch,
  requestKey,
  resourceKey,
  RESOURCE_PREFIX,
  type EmergencyRequest,
  type KeyValueStore,
  type Resource,
} from "@emergency/shared";

export type MatchOutcome = "assigned" | "no-match" | "skipped";

// Handles one match message. Only PENDING requests are processed, so a
// redelivered message is harmless.
// Known limitation: the read-then-write below is not atomic, so two matchers
// could claim the same resource at once. A compare-and-set in the coordinator
// would fix this; it is a planned next step.
export async function processMatch(requestId: string, store: KeyValueStore): Promise<MatchOutcome> {
  const request = await store.get<EmergencyRequest>(requestKey(requestId));
  if (!request || request.status !== "PENDING") return "skipped";

  const resources = (await store.list<Resource>(RESOURCE_PREFIX)).map((e) => e.value);
  const match = findMatch(request, resources);
  if (!match) return "no-match";

  await store.put(resourceKey(match.id), { ...match, status: "ASSIGNED", availability: false });
  await store.put(requestKey(request.id), { ...request, status: "ASSIGNED", resourceId: match.id });
  return "assigned";
}
