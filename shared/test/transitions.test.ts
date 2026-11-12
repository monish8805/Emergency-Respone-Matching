import { describe, expect, it } from "vitest";
import { REQUEST_TRANSITIONS, canTransition } from "../src/transitions";
import { REQUEST_STATUSES } from "../src/types";

describe("request status transitions", () => {
  it("lets a request move forward through its life", () => {
    expect(canTransition("PENDING", "CANCELLED")).toBe(true);
    expect(canTransition("ASSIGNED", "IN_PROGRESS")).toBe(true);
    expect(canTransition("ASSIGNED", "COMPLETED")).toBe(true);
    expect(canTransition("IN_PROGRESS", "COMPLETED")).toBe(true);
    expect(canTransition("IN_PROGRESS", "CANCELLED")).toBe(true);
  });

  it("only the matcher can assign: a pending request cannot be assigned or started by hand", () => {
    expect(canTransition("PENDING", "ASSIGNED")).toBe(false);
    expect(canTransition("PENDING", "IN_PROGRESS")).toBe(false);
    expect(canTransition("PENDING", "COMPLETED")).toBe(false);
  });

  it("finished requests stay finished", () => {
    for (const from of ["COMPLETED", "CANCELLED"] as const) {
      for (const to of REQUEST_STATUSES) expect(canTransition(from, to), `${from} -> ${to}`).toBe(to === from);
      expect(REQUEST_TRANSITIONS[from]).toEqual([]);
    }
  });

  it("never moves backwards", () => {
    expect(canTransition("ASSIGNED", "PENDING")).toBe(false);
    expect(canTransition("IN_PROGRESS", "ASSIGNED")).toBe(false);
    expect(canTransition("IN_PROGRESS", "PENDING")).toBe(false);
  });

  it("treats setting the same status again as a harmless no-op", () => {
    for (const status of REQUEST_STATUSES) expect(canTransition(status, status)).toBe(true);
  });
});
