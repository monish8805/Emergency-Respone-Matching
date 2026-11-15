import { createHash } from "node:crypto";

// Clients send "Idempotency-Key: <random string>" with a create call and reuse it when they retry
// (a double click, a timeout, a 503). The key decides the record's id, so a retry addresses the
// same record instead of creating a second one.
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

// A UUID-shaped id derived from the key: the same key always gives the same id.
export function idFromIdempotencyKey(key: string): string {
  const h = createHash("sha256").update(`idempotency:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export class InvalidCursorError extends Error {
  constructor() {
    super("cursor does not point at a known record");
  }
}

export interface Page<T> {
  items: T[];
  // Pass as ?cursor= to get the next page. null on the last page.
  nextCursor: string | null;
  // How many records match in total (all pages).
  total: number;
}

// Slices an already ordered list. The cursor is the position key of the last item the client saw,
// so records added or removed between pages never cause skipped or repeated rows.
export function paginate<T>(
  ordered: T[],
  positionOf: (item: T) => string,
  cursor: string | undefined,
  limit: number,
): Page<T> {
  let start = 0;
  if (cursor !== undefined) {
    const after = Buffer.from(cursor, "base64url").toString("utf8");
    start = ordered.findIndex((item) => positionOf(item) === after);
    if (start === -1) throw new InvalidCursorError();
    start += 1;
  }
  const items = ordered.slice(start, start + limit);
  const last = items[items.length - 1];
  const more = start + limit < ordered.length;
  return {
    items,
    nextCursor: more && last ? Buffer.from(positionOf(last), "utf8").toString("base64url") : null,
    total: ordered.length,
  };
}
