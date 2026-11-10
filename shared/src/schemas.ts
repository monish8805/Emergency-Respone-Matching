import { z } from "zod";
import { REQUEST_TYPES, REQUEST_STATUSES, RESOURCE_STATUSES } from "./types";

export const createRequestSchema = z.object({
  type: z.enum(REQUEST_TYPES),
  location: z.string().trim().min(1),
  details: z.string().default(""),
});

export const requestStatusSchema = z.object({
  status: z.enum(REQUEST_STATUSES),
});

export const registerResourceSchema = z.object({
  type: z.enum(REQUEST_TYPES),
  location: z.string().trim().min(1),
  availability: z.boolean().default(true),
});

export const resourceStatusSchema = z.object({
  status: z.enum(RESOURCE_STATUSES),
});

export const matchMessageSchema = z.object({
  requestId: z.string().min(1),
});
