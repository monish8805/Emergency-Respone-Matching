import type { RequestStatus } from "./types";

// Which status a request may move to by hand. The matcher is the only thing that assigns, so
// PENDING can only be cancelled, and a finished request (COMPLETED / CANCELLED) stays finished.
//
//   PENDING ──matcher──► ASSIGNED ──► IN_PROGRESS ──► COMPLETED
//      │                    │              │
//      └────────────────────┴──────────────┴──────► CANCELLED
//
// A request also goes back to PENDING (not through this table) when its resource becomes
// unavailable, so that it can be matched again.
export const REQUEST_TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  PENDING: ["CANCELLED"],
  ASSIGNED: ["IN_PROGRESS", "COMPLETED", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

// Setting the status a request already has is always fine (a harmless no-op).
export const canTransition = (from: RequestStatus, to: RequestStatus): boolean =>
  from === to || REQUEST_TRANSITIONS[from].includes(to);

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: RequestStatus,
    readonly to: RequestStatus,
  ) {
    super(`cannot change a ${from} request to ${to}`);
  }
}
