import { describe, expect, it } from "vitest";
import { findMatch } from "../src/match";
import type { EmergencyRequest, Resource } from "../src/types";

const request: EmergencyRequest = {
  id: "r1",
  type: "water",
  location: "Zone A",
  details: "",
  status: "PENDING",
  resourceId: null,
  createdAt: new Date().toISOString(),
};

const resource = (overrides: Partial<Resource>): Resource => ({
  id: "x",
  type: "water",
  location: "zone a",
  availability: true,
  status: "AVAILABLE",
  ...overrides,
});

describe("findMatch", () => {
  it("matches an available resource with the same type and location", () => {
    expect(findMatch(request, [resource({ id: "ok" })])?.id).toBe("ok");
  });

  it("skips unavailable resources, wrong types, and wrong locations", () => {
    const resources = [
      resource({ id: "busy", availability: false, status: "ASSIGNED" }),
      resource({ id: "food", type: "food" }),
      resource({ id: "elsewhere", location: "Zone B" }),
    ];
    expect(findMatch(request, resources)).toBeUndefined();
  });
});
