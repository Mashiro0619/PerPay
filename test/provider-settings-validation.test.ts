import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { providerSettingsInputSchema } from "../src/settings/model.ts";

const valid = {
  revision: 0, environment: "PRODUCTION", app_id: "test-app", timeout_milliseconds: 8_000,
  scan_interval_seconds: 30, active_scan_interval_seconds: 5,
  safety_lag_seconds: 10, maximum_success_age_seconds: 60,
};

describe("adaptive provider timing validation", () => {
  it("accepts distinct or equal intervals and legacy requests", () => {
    assert.deepEqual(providerSettingsInputSchema.parse(valid), valid);
    assert.equal(providerSettingsInputSchema.safeParse({ ...valid, active_scan_interval_seconds: 30 }).success, true);
    const { active_scan_interval_seconds: _active, ...legacy } = valid;
    assert.deepEqual(providerSettingsInputSchema.parse(legacy), legacy);
    assert.equal(providerSettingsInputSchema.safeParse({ ...valid,
      scan_interval_seconds: 3600, active_scan_interval_seconds: 3600, maximum_success_age_seconds: 7200,
    }).success, true);
  });

  for (const active of [0, 4, 5.5, 31, 3601, NaN, Infinity, "5", null]) {
    it("rejects invalid active interval " + active, () => {
      const parsed = providerSettingsInputSchema.safeParse({ ...valid, active_scan_interval_seconds: active });
      assert.equal(parsed.success, false);
      if (!parsed.success) assert.ok(parsed.error.issues.some((issue) => issue.path[0] === "active_scan_interval_seconds"));
    });
  }

  it("uses the normal interval, not the active interval, for freshness validation", () => {
    const parsed = providerSettingsInputSchema.safeParse({ ...valid, maximum_success_age_seconds: 59 });
    assert.equal(parsed.success, false);
    if (!parsed.success) assert.equal(parsed.error.issues[0]?.path[0], "maximum_success_age_seconds");
    assert.equal(providerSettingsInputSchema.safeParse({ ...valid, safety_lag_seconds: 61 }).success, false);
  });
});
