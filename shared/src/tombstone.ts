// A deleted key is not removed: it is overwritten with a newer-version marker. If a node simply
// forgot the key, reconciliation would copy it back from a peer that still holds the old value.
export const TOMBSTONE = Object.freeze({ __deleted: true });

export function isTombstone(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { __deleted?: unknown }).__deleted === true;
}
