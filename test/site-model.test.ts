import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  copySiteDefaults,
  createSiteInputSchema,
  generateSiteClientId,
  siteClientIdSchema,
  siteConfigurationSchema,
  sitePolicySchema,
  updateSiteDefaultsInputSchema,
  updateSiteInputSchema,
  type SitePolicy,
} from "../src/sites/model.ts";

const policy = (): SitePolicy => ({
  orders: { order_ttl_seconds: 300, amount_offset_maximum_cents: 99, amount_reuse_cooldown_seconds: 60, pending_order_limit: null },
  display: { checkout_name: "PerPay", checkout_help_url: null, checkout_show_product_name: true },
  notification_delivery: { timeout_milliseconds: 5000, maximum_attempts: 12, retry_base_seconds: 5, retry_maximum_seconds: 3600 },
});
const configuration = () => ({ name: "网站 A", accepting_orders: true, notifications_enabled: false, notification_origin: null as string | null, return_origin: null as string | null, policy: policy() });

describe("complete website configuration", () => {
  it("accepts a website without credentials or callback origins", () => {
    assert.deepEqual(siteConfigurationSchema.parse(configuration()), configuration());
  });
  it("copies defaults without retaining nested references", () => {
    const template = policy();
    const siteA = copySiteDefaults(template);
    const siteB = copySiteDefaults(template);
    siteA.orders.order_ttl_seconds = 600;
    template.display.checkout_name = "new template";
    assert.equal(siteB.orders.order_ttl_seconds, 300);
    assert.equal(siteA.display.checkout_name, "PerPay");
    assert.equal(siteB.display.checkout_name, "PerPay");
  });
  it("rejects omitted/null policy sections instead of inheriting defaults", () => {
    for (const key of ["orders", "display", "notification_delivery"] as const) {
      const missing: Record<string, unknown> = { ...policy() };
      delete missing[key];
      assert.equal(sitePolicySchema.safeParse(missing).success, false);
      assert.equal(sitePolicySchema.safeParse({ ...policy(), [key]: null }).success, false);
    }
    const missingCooldown = { ...policy().orders } as Record<string, unknown>;
    delete missingCooldown.amount_reuse_cooldown_seconds;
    assert.equal(sitePolicySchema.safeParse({ ...policy(), orders: missingCooldown }).success, false);
  });
  it("never accepts identity, credentials or origins in a defaults template", () => {
    for (const key of ["client_id", "api_secret", "webhook_secret", "notification_origin", "return_origin", "accepting_orders"]) {
      assert.equal(sitePolicySchema.safeParse({ ...policy(), [key]: "not a default" }).success, false);
    }
  });
  it("keeps website policy free of collection source and scan controls", () => {
    for (const key of ["provider_account_key", "app_id", "code_payload", "scan_interval_seconds", "safety_lag_seconds"]) {
      assert.equal(sitePolicySchema.safeParse({ ...policy(), [key]: "unrelated" }).success, false);
    }
  });
  it("keeps pause and notification enablement independent", () => {
    const input = { ...configuration(), accepting_orders: false, notifications_enabled: true, notification_origin: "https://notify.example.com" };
    assert.equal(siteConfigurationSchema.parse(input).notifications_enabled, true);
    assert.equal(siteConfigurationSchema.parse(input).accepting_orders, false);
  });
  it("requires notification origin when enabled, even while paused", () => {
    for (const accepting_orders of [true, false]) {
      const result = siteConfigurationSchema.safeParse({ ...configuration(), accepting_orders, notifications_enabled: true });
      assert.equal(result.success, false);
      if (!result.success) assert.deepEqual(result.error.issues[0]?.path, ["notification_origin"]);
    }
  });
  it("allows separately configured notification and return origins", () => {
    const input = { ...configuration(), notifications_enabled: true, notification_origin: "https://notify.example.com", return_origin: "https://shop.example.com" };
    assert.deepEqual(siteConfigurationSchema.parse(input), input);
  });
  for (const origin of ["", "http://shop.example.com", "https://shop.example.com/path", "https://user@shop.example.com", "https://*.example.com", "https://127.0.0.1", "https://shop.example.com:8443", "https://shop.example.com?x=1", "https://shop.example.com#x"]) {
    it("rejects invalid origins even in disabled drafts: " + origin, () => {
      for (const field of ["notification_origin", "return_origin"]) {
        assert.equal(siteConfigurationSchema.safeParse({ ...configuration(), [field]: origin }).success, false);
      }
    });
  }
  it("requires a positive safe integer cap or explicit unlimited null", () => {
    for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
      assert.equal(sitePolicySchema.safeParse({ ...policy(), orders: { ...policy().orders, pending_order_limit: limit } }).success, false);
    }
    for (const limit of [null, 1, 100]) {
      assert.equal(sitePolicySchema.safeParse({ ...policy(), orders: { ...policy().orders, pending_order_limit: limit } }).success, true);
    }
  });
  it("retains TTL, offset, cooldown and retry safety bounds", () => {
    for (const patch of [{ order_ttl_seconds: 59 }, { order_ttl_seconds: 1801 }, { amount_offset_maximum_cents: 0 }, { amount_offset_maximum_cents: 100 }, { amount_reuse_cooldown_seconds: -1 }]) {
      assert.equal(sitePolicySchema.safeParse({ ...policy(), orders: { ...policy().orders, ...patch } }).success, false);
    }
    assert.equal(sitePolicySchema.safeParse({ ...policy(), notification_delivery: { ...policy().notification_delivery, retry_base_seconds: 10, retry_maximum_seconds: 9 } }).success, false);
  });
  it("rejects unsafe display configuration", () => {
    for (const patch of [{ checkout_name: "" }, { checkout_name: "bad\u0000name" }, { checkout_help_url: "javascript:alert(1)" }, { checkout_help_url: "http://help.example.com" }]) {
      assert.equal(sitePolicySchema.safeParse({ ...policy(), display: { ...policy().display, ...patch } }).success, false);
    }
  });
  it("accepts historical identity but generates distinct non-default IDs", () => {
    assert.equal(siteClientIdSchema.parse("default"), "default");
    const ids = new Set(Array.from({ length: 100 }, generateSiteClientId));
    assert.equal(ids.size, 100);
    for (const id of ids) assert.equal(siteClientIdSchema.parse(id), id);
    assert.equal(ids.has("default"), false);
    for (const id of ["", "ab", "a:b", "abc\u0000def", "_abc", "a".repeat(65)]) assert.equal(siteClientIdSchema.safeParse(id).success, false);
  });
  it("requires operation identity on create and rejects client-supplied site IDs", () => {
    const input = { operation_id: "b9f43b29-8062-434b-bb62-47ba5596e069", configuration: configuration() };
    assert.equal(createSiteInputSchema.safeParse(input).success, true);
    assert.equal(createSiteInputSchema.safeParse({ configuration: configuration() }).success, false);
    assert.equal(createSiteInputSchema.safeParse({ ...input, client_id: "chosen" }).success, false);
  });
  it("requires independent revisions on site and template writes", () => {
    for (const revision of [undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(updateSiteInputSchema.safeParse({ revision, configuration: configuration() }).success, false);
      assert.equal(updateSiteDefaultsInputSchema.safeParse({ revision, policy: policy() }).success, false);
    }
    assert.equal(updateSiteInputSchema.safeParse({ revision: 0, configuration: configuration() }).success, true);
    assert.equal(updateSiteDefaultsInputSchema.safeParse({ revision: 0, policy: policy() }).success, true);
  });
});
