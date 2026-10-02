import assert from "node:assert/strict";
import { it } from "node:test";
import { checkoutHelpUrl } from "../src/shared/checkout-help.ts";
import { readCheckoutInitial } from "./checkout-view-fixture.ts";
import {
  withHttpFixture,
  login,
  financialHeaders,
} from "./reconciliation-http-fixture.ts";
it("validates navigation targets without fetching them", () => {
  assert.equal(
    checkoutHelpUrl("https://help.example.com:8443/support"),
    "https://help.example.com:8443/support",
  );
  for (const url of [
    "http://shop.example.com/help",
    "https://localhost/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://foo.local/",
    "https://u:p@shop.example.com/",
    "https://shop.example.com/%0a",
    "https://shop.example.com/" + "中".repeat(2048),
  ])
    assert.equal(checkoutHelpUrl(url), null, url);
  assert.equal(
    checkoutHelpUrl("https://shop.example.com/help?q=1#support"),
    "https://shop.example.com/help?q=1#support",
  );
});
it("persists help links, preserves omissions and clears null without changing payment revision", async () => {
  await withHttpFixture(async ({ app, services }) => {
    const auth = await login(app);
    const before = services.settings.view();
    const save = (extra: object) =>
      app.request("/api/admin/v1/settings/display", {
        method: "PUT",
        headers: financialHeaders(auth),
        body: JSON.stringify({
          revision: services.settings.view().revision,
          checkout_show_product_name: true,
          dashboard_chart_type: "AREA",
          ...extra,
        }),
      });
    assert.equal(
      (await save({ checkout_help_url: "https://shop.example.com/help" }))
        .status,
      200,
    );
    assert.equal((await save({})).status, 200);
    assert.equal(
      services.settings.display().checkoutHelpUrl,
      "https://shop.example.com/help",
    );
    const html = await (await app.request("/checkout/invalid")).text();
    assert.equal(
      readCheckoutInitial(html).helpUrl,
      "https://shop.example.com/help",
    );
    assert.equal(
      services.settings.view().payment_revision,
      before.payment_revision,
    );
    assert.equal(
      (await save({ checkout_help_url: "javascript:alert(1)" })).status,
      422,
    );
    assert.equal((await save({ checkout_help_url: null })).status, 200);
    assert.equal(services.settings.display().checkoutHelpUrl, null);
  });
});
