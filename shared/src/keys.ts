import { REQUEST_TYPES, type RequestType } from "./types";

export const REQUEST_PREFIX = "request:";
export const RESOURCE_PREFIX = "resource:";

export const requestKey = (id: string) => `${REQUEST_PREFIX}${id}`;

// Resources are stored under "resource:<type>:<uuid>", so "resource:water:" lists only the water
// resources and the storage nodes can skip everything else. A resource id is "<type>-<uuid>", which
// carries the type, so a lookup by id alone can still build the key.
export const resourcePrefix = (type: RequestType) => `${RESOURCE_PREFIX}${type}:`;

export const newResourceId = (type: RequestType, uuid: string) => `${type}-${uuid}`;

export function parseResourceId(id: string): { type: RequestType; uuid: string } | null {
  const dash = id.indexOf("-");
  if (dash <= 0 || dash === id.length - 1) return null;
  const type = id.slice(0, dash);
  return (REQUEST_TYPES as readonly string[]).includes(type) ? { type: type as RequestType, uuid: id.slice(dash + 1) } : null;
}

// The storage key for a resource id. An id that does not carry a valid type maps to a key that
// can never exist, so lookups simply report "not found".
export function resourceKey(id: string): string {
  const parsed = parseResourceId(id);
  return parsed ? `${resourcePrefix(parsed.type)}${parsed.uuid}` : `${RESOURCE_PREFIX}unknown:${id}`;
}
