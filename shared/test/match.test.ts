import { describe, expect, it } from "vitest";
import { findMatch, findMatches, rankMatches } from "../src/match";
import type { EmergencyRequest, Resource } from "../src/types";

const request = (location: string): EmergencyRequest => ({
  id: "r1",
  type: "water",
  location,
  details: "",
  status: "PENDING",
  resourceId: null,
  createdAt: new Date().toISOString(),
});

const resource = (overrides: Partial<Resource>): Resource => ({
  id: "x",
  type: "water",
  location: "zone a",
  availability: true,
  status: "AVAILABLE",
  ...overrides,
});

describe("zone names", () => {
  it("matches an available resource with the same type and zone, ignoring case and spaces", () => {
    expect(findMatch(request("Zone A"), [resource({ id: "ok", location: "  zone a " })])?.id).toBe("ok");
  });

  it("skips unavailable resources, wrong types, and other zones", () => {
    const resources = [
      resource({ id: "busy", availability: false, status: "ASSIGNED" }),
      resource({ id: "food", type: "food" }),
      resource({ id: "elsewhere", location: "Zone B" }),
    ];
    expect(findMatch(request("Zone A"), resources)).toBeUndefined();
  });

  it("reports no distance for a zone match", () => {
    expect(rankMatches(request("Zone A"), [resource({ id: "ok" })])[0].distanceKm).toBeNull();
  });
});

describe("coordinates", () => {
  it("matches resources within the radius and rejects farther ones", () => {
    const resources = [
      resource({ id: "near", location: "12.975, 77.595" }), // ~0.7 km
      resource({ id: "far", location: "13.2, 77.8" }), // ~30 km
    ];
    expect(findMatches(request("12.97, 77.59"), resources, 5).map((r) => r.id)).toEqual(["near"]);
  });

  it("picks the nearest resource first, with its distance", () => {
    const resources = [
      resource({ id: "b-3km", location: "12.997, 77.59" }),
      resource({ id: "a-0.5km", location: "12.9745, 77.59" }),
      resource({ id: "c-1.5km", location: "12.9835, 77.59" }),
    ];
    const ranked = rankMatches(request("12.97, 77.59"), resources, 5);
    expect(ranked.map((m) => m.resource.id)).toEqual(["a-0.5km", "c-1.5km", "b-3km"]);
    expect(ranked[0].distanceKm).toBeCloseTo(0.5, 1);
  });

  it("respects a custom radius", () => {
    const resources = [resource({ id: "r", location: "12.9745, 77.59" })]; // ~0.5 km
    expect(findMatches(request("12.97, 77.59"), resources, 0.3)).toEqual([]);
    expect(findMatches(request("12.97, 77.59"), resources, 1)).toHaveLength(1);
  });

  it("accepts different formatting of the same point", () => {
    expect(findMatch(request("12.97,77.59"), [resource({ id: "ok", location: "(12.97, 77.59)" })])?.id).toBe("ok");
  });

  it("still applies type and availability rules", () => {
    const resources = [
      resource({ id: "food", type: "food", location: "12.97, 77.59" }),
      resource({ id: "busy", location: "12.97, 77.59", status: "ASSIGNED", availability: false }),
    ];
    expect(findMatch(request("12.97, 77.59"), resources)).toBeUndefined();
  });
});

describe("mixing zone names and coordinates", () => {
  it("never matches a zone name with coordinates", () => {
    expect(findMatch(request("Zone A"), [resource({ location: "12.97, 77.59" })])).toBeUndefined();
    expect(findMatch(request("12.97, 77.59"), [resource({ location: "Zone A" })])).toBeUndefined();
  });
});
