export const REQUEST_TYPES = ["water", "food", "medicine", "transportation", "shelter"] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const REQUEST_STATUSES = ["PENDING", "ASSIGNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const RESOURCE_STATUSES = ["AVAILABLE", "ASSIGNED", "UNAVAILABLE"] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

export interface EmergencyRequest {
  id: string;
  type: RequestType;
  location: string;
  details: string;
  status: RequestStatus;
  resourceId: string | null;
  createdAt: string;
}

export interface Resource {
  id: string;
  type: RequestType;
  location: string;
  availability: boolean;
  status: ResourceStatus;
  // Set while the resource is claimed, so a half-finished assignment can be completed or undone.
  assignedRequestId?: string | null;
}

export interface NodeConfig {
  id: string;
  shard: number;
  url: string;
}
