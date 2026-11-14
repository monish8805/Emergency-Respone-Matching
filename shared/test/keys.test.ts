import { describe, expect, it } from "vitest";
import { newResourceId, parseResourceId, resourceKey, resourcePrefix, RESOURCE_PREFIX } from "../src";

describe("resource keys", () => {
  it("stores a resource under its type, so one type can be listed on its own", () => {
    const id = newResourceId("water", "abc-123");
    expect(id).toBe("water-abc-123");
    expect(resourceKey(id)).toBe("resource:water:abc-123");
    expect(resourceKey(id).startsWith(resourcePrefix("water"))).toBe(true);
    expect(resourceKey(id).startsWith(resourcePrefix("food"))).toBe(false);
  });

  it("reads the type back out of an id", () => {
    expect(parseResourceId("medicine-9f3a")).toEqual({ type: "medicine", uuid: "9f3a" });
    expect(parseResourceId("not-a-type-9f3a")).toBeNull();
    expect(parseResourceId("water-")).toBeNull();
    expect(parseResourceId("")).toBeNull();
  });

  it("maps an id without a valid type to a key that cannot exist", () => {
    expect(resourceKey("garbage")).toBe(`${RESOURCE_PREFIX}unknown:garbage`);
    expect(resourceKey("garbage").startsWith(resourcePrefix("water"))).toBe(false);
  });
});
