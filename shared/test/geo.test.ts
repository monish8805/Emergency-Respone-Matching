import { describe, expect, it } from "vitest";
import { distanceKm, parseCoordinates } from "../src/geo";

describe("parseCoordinates", () => {
  it.each([
    ["12.97, 77.59", { lat: 12.97, lng: 77.59 }],
    ["12.97,77.59", { lat: 12.97, lng: 77.59 }],
    ["12.97 77.59", { lat: 12.97, lng: 77.59 }],
    ["  (12.97, 77.59) ", { lat: 12.97, lng: 77.59 }],
    ["-33.86, 151.21", { lat: -33.86, lng: 151.21 }],
    ["0, 0", { lat: 0, lng: 0 }],
  ])("reads %j", (text, expected) => {
    expect(parseCoordinates(text)).toEqual(expected);
  });

  it.each(["Zone A", "zone b", "", "12.97", "12.97, abc", "91, 10", "10, 181", "Block 12, 5"])(
    "does not treat %j as coordinates",
    (text) => {
      expect(parseCoordinates(text)).toBeNull();
    },
  );
});

describe("distanceKm", () => {
  it("is zero for the same point", () => {
    expect(distanceKm({ lat: 12.97, lng: 77.59 }, { lat: 12.97, lng: 77.59 })).toBe(0);
  });

  it("matches known distances", () => {
    // Bengaluru to Chennai is about 290 km in a straight line.
    const d = distanceKm({ lat: 12.9716, lng: 77.5946 }, { lat: 13.0827, lng: 80.2707 });
    expect(d).toBeGreaterThan(285);
    expect(d).toBeLessThan(295);
    // One degree of latitude is about 111 km.
    expect(distanceKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111.19, 1);
  });

  it("is symmetric", () => {
    const [a, b] = [{ lat: 12.9, lng: 77.5 }, { lat: 13.1, lng: 77.7 }];
    expect(distanceKm(a, b)).toBeCloseTo(distanceKm(b, a), 10);
  });
});
