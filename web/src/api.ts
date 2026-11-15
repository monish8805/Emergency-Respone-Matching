import { createServerFn } from "@tanstack/react-start";

export const RESOURCE_TYPES = ["water", "food", "medicine", "transportation", "shelter"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const REQUEST_STATUSES = ["PENDING", "ASSIGNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

// What a request may be changed to by hand. Keep in sync with REQUEST_TRANSITIONS in
// shared/src/transitions.ts (the API enforces it; this only decides what the dropdown offers).
export const REQUEST_NEXT: Record<RequestStatus, readonly RequestStatus[]> = {
  PENDING: ["CANCELLED"],
  ASSIGNED: ["IN_PROGRESS", "COMPLETED", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export const RESOURCE_STATUSES = ["AVAILABLE", "ASSIGNED", "UNAVAILABLE"] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

export interface EmergencyRequest {
  id: string;
  type: ResourceType;
  location: string;
  details: string;
  status: RequestStatus;
  resourceId: string | null;
  distanceKm?: number | null;
  createdAt: string;
}

export interface Resource {
  id: string;
  type: ResourceType;
  location: string;
  availability: boolean;
  status: ResourceStatus;
  assignedRequestId?: string | null;
  // Set when this change sent the request that was using the resource back to PENDING.
  releasedRequestId?: string;
}

// Turns the API's error body into a readable message, including which fields were invalid.
function describeError(data: unknown, status: number): string {
  const body = data as { error?: string; details?: { fieldErrors?: Record<string, string[] | undefined> } };
  const fields = Object.entries(body.details?.fieldErrors ?? {})
    .filter(([, messages]) => messages?.length)
    .map(([field, messages]) => `${field}: ${messages!.join(", ")}`);
  const base = body.error ?? `request failed (${status})`;
  return fields.length ? `${base} (${fields.join("; ")})` : base;
}

// Server functions run on the Start server, which calls the request service.
// The browser never talks to the backend directly, so no CORS is needed.
async function call<T>(path: string, method = "GET", body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const base = process.env.API_URL ?? "http://localhost:3005";
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extraHeaders },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Request service is unreachable");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(describeError(data, res.status));
  return data as T;
}

export interface SystemStatus {
  requestService: string;
  rabbitmq: "up" | "down" | "unknown";
  coordinator: {
    reachable: boolean | null;
    ok?: boolean;
    error?: string;
    nodes?: Array<{ id: string; shard: number; status: "up" | "syncing" | "down" }>;
    shards?: Array<{ shard: number; live: number; total: number; quorum?: number }>;
    leader?: boolean;
  };
}

export const getSystem = createServerFn({ method: "GET" }).handler(() => call<SystemStatus>("/system"));

export const PAGE_SIZE = 25;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

export const listRequests = createServerFn({ method: "GET" })
  .validator((d: { cursor?: string }) => d)
  .handler(({ data }) =>
    call<Page<EmergencyRequest>>(`/requests?limit=${PAGE_SIZE}${data.cursor ? `&cursor=${encodeURIComponent(data.cursor)}` : ""}`),
  );

export const listResources = createServerFn({ method: "GET" })
  .validator((d: { cursor?: string }) => d)
  .handler(({ data }) =>
    call<Page<Resource>>(`/resources?limit=${PAGE_SIZE}${data.cursor ? `&cursor=${encodeURIComponent(data.cursor)}` : ""}`),
  );

// The idempotency key is made once per submission by the form and sent again on every retry of the
// same submission, so a double click or a retry after an error never creates a second record.
export const createRequest = createServerFn({ method: "POST" })
  .validator((d: { type: ResourceType; location: string; details: string; idempotencyKey: string }) => d)
  .handler(({ data: { idempotencyKey, ...body } }) =>
    call<EmergencyRequest>("/requests", "POST", body, { "idempotency-key": idempotencyKey }),
  );

export const registerResource = createServerFn({ method: "POST" })
  .validator((d: { type: ResourceType; location: string; availability: boolean; idempotencyKey: string }) => d)
  .handler(({ data: { idempotencyKey, ...body } }) =>
    call<Resource>("/resources", "POST", body, { "idempotency-key": idempotencyKey }),
  );

export const setRequestStatus = createServerFn({ method: "POST" })
  .validator((d: { id: string; status: RequestStatus }) => d)
  .handler(({ data }) =>
    call<EmergencyRequest>(`/requests/${encodeURIComponent(data.id)}/status`, "PUT", { status: data.status }),
  );

export const setResourceStatus = createServerFn({ method: "POST" })
  .validator((d: { id: string; status: ResourceStatus }) => d)
  .handler(({ data }) =>
    call<Resource>(`/resources/${encodeURIComponent(data.id)}/status`, "PUT", { status: data.status }),
  );

export const triggerMatch = createServerFn({ method: "POST" })
  .validator((d: { id: string }) => d)
  .handler(({ data }) => call<{ queued: boolean }>(`/match/${encodeURIComponent(data.id)}`, "POST"));
