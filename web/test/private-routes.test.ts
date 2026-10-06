import { describe, expect, it } from "vitest";
import { isPrivateRoute } from "../src/navigation";

describe("sensitive route snapshots", () => {
  it.each(["/sites", "/sites/new", "/sites/defaults", "/sites/site_example", "/settings/security"])("does not animate or retain a view-transition image for %s", path => {
    expect(isPrivateRoute(path)).toBe(true);
  });
  it("keeps ordinary order-list navigation eligible for motion", () => {
    expect(isPrivateRoute("/orders")).toBe(false);
  });
});
