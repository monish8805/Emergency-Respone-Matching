import { z } from "zod";
import { REQUEST_TYPES, REQUEST_STATUSES, RESOURCE_STATUSES } from "./types";
import { parseCoordinates } from "./geo";

// A location is valid coordinates ("12.97, 77.59") or a zone name made of letters, digits, spaces
// and . ' _ - that starts with a letter. Anything that merely looks like coordinates but is out of
// range ("91, 10") or that has no letters at all ("123", "!!!") is rejected, so it can never be
// stored as a zone name nobody will match.
export const ZONE_NAME = /^\p{L}[\p{L}\p{N} ._'-]{0,59}$/u;

export function locationProblem(text: string): string | null {
  if (parseCoordinates(text)) return null;
  if (!/\p{L}/u.test(text)) {
    return "must be a zone name or valid coordinates: latitude -90 to 90, longitude -180 to 180";
  }
  if (!ZONE_NAME.test(text)) {
    return "a zone name starts with a letter, uses letters, digits, spaces and . ' _ -, and has at most 60 characters";
  }
  return null;
}

export const locationSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .superRefine((text, ctx) => {
    const problem = locationProblem(text);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

export const createRequestSchema = z.object({
  type: z.enum(REQUEST_TYPES),
  location: locationSchema,
  details: z.string().max(2000).default(""),
});

export const requestStatusSchema = z.object({
  status: z.enum(REQUEST_STATUSES),
});

export const registerResourceSchema = z.object({
  type: z.enum(REQUEST_TYPES),
  location: locationSchema,
  availability: z.boolean().default(true),
});

export const resourceStatusSchema = z.object({
  status: z.enum(RESOURCE_STATUSES),
});

export const matchMessageSchema = z.object({
  requestId: z.string().min(1),
});
