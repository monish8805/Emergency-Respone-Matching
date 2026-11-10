import { distanceKm, parseCoordinates } from "./geo";
import type { EmergencyRequest, Resource } from "./types";

// How close a resource must be to a request when both are given as coordinates.
export const DEFAULT_RADIUS_KM = 5;

export interface RankedMatch {
  resource: Resource;
  // Distance in km when both locations are coordinates, null when they matched by zone name.
  distanceKm: number | null;
}

// How well one location fits another:
//  - both are coordinates: within radiusKm, and the distance is returned
//  - otherwise: the same text (case-insensitive, trimmed), e.g. "Zone A" and "zone a"
// Returns undefined when they do not match. A zone name never matches coordinates.
function locationFit(wanted: string, offered: string, radiusKm: number): { distanceKm: number | null } | undefined {
  const a = parseCoordinates(wanted);
  const b = parseCoordinates(offered);
  if (a && b) {
    const d = distanceKm(a, b);
    return d <= radiusKm ? { distanceKm: Math.round(d * 100) / 100 } : undefined;
  }
  if (a || b) return undefined;
  return wanted.trim().toLowerCase() === offered.trim().toLowerCase() ? { distanceKm: null } : undefined;
}

// Every resource that could serve the request, nearest first (zone matches follow in list order).
// The matcher tries them in order, so losing a claim race on one falls through to the next.
export function rankMatches(
  request: EmergencyRequest,
  resources: Resource[],
  radiusKm: number = DEFAULT_RADIUS_KM,
): RankedMatch[] {
  const ranked: RankedMatch[] = [];
  for (const resource of resources) {
    if (!resource.availability || resource.status !== "AVAILABLE" || resource.type !== request.type) continue;
    const fit = locationFit(request.location, resource.location, radiusKm);
    if (fit) ranked.push({ resource, distanceKm: fit.distanceKm });
  }
  return ranked.sort((x, y) => (x.distanceKm ?? 0) - (y.distanceKm ?? 0) || x.resource.id.localeCompare(y.resource.id));
}

export function findMatches(request: EmergencyRequest, resources: Resource[], radiusKm?: number): Resource[] {
  return rankMatches(request, resources, radiusKm).map((m) => m.resource);
}

export function findMatch(request: EmergencyRequest, resources: Resource[], radiusKm?: number): Resource | undefined {
  return findMatches(request, resources, radiusKm)[0];
}
