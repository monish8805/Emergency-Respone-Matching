import { createServerFn } from "@tanstack/react-start";

export const RESOURCE_TYPES = ["water", "food", "medicine", "transportation", "shelter"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const REQUEST_STATUSES = ["PENDING", "ASSIGNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const RESOURCE_STATUSES = ["AVAILABLE", "ASSIGNED", "UNAVAILABLE"] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

export interface EmergencyRequest {
  id: string;
  type: ResourceType;
  location: string;
  details: string;
  status: RequestStatus;
  resourceId: string | null;
  createdAt: string;
}

export interface Resource {
  id: string;
  type: ResourceType;
  location: string;
  availability: boolean;
  status: ResourceStatus;
}

// Server functions run on the Start server, which calls the request service.
// The browser never talks to the backend directly, so no CORS is needed.
async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const base = process.env.API_URL ?? "http://localhost:3005";
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Request service is unreachable");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `request failed (${res.status})`);
  return data as T;
}

export const listRequests = createServerFn({ method: "GET" }).handler(() =>
  call<EmergencyRequest[]>("/requests"),
);

export const listResources = createServerFn({ method: "GET" }).handler(() => call<Resource[]>("/resources"));

export const createRequest = createServerFn({ method: "POST" })
  .validator((d: { type: ResourceType; location: string; details: string }) => d)
  .handler(({ data }) => call<EmergencyRequest>("/requests", "POST", data));

export const registerResource = createServerFn({ method: "POST" })
  .validator((d: { type: ResourceType; location: string; availability: boolean }) => d)
  .handler(({ data }) => call<Resource>("/resources", "POST", data));

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
