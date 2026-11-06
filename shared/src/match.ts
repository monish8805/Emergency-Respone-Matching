import type { EmergencyRequest, Resource } from "./types";

// Returns the first available resource with the same type and location.
// Location is compared case-insensitively after trimming. A grid-cell or
// distance-based rule could replace this later.
export function findMatch(request: EmergencyRequest, resources: Resource[]): Resource | undefined {
  const wantedLocation = request.location.trim().toLowerCase();
  return resources.find(
    (r) =>
      r.availability &&
      r.status === "AVAILABLE" &&
      r.type === request.type &&
      r.location.trim().toLowerCase() === wantedLocation,
  );
}
