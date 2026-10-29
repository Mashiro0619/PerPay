import { withLegacyPaymentFixture } from "./legacy-payment-fixture.ts";
import { setTestSiteDisplay } from "./site-display-fixture.ts";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it, mock } from "node:test";
import { PublicCheckoutRateLimiter } from "../src/http/public-checkout-rate-limit.ts";
import { OrderError } from "../src/orders/service.ts";
import { AppDatabase } from "../src/database/database.ts";
import {
  RuntimeSecretCipher,
  RuntimeSettingsService,
  RuntimeSettingsStore,
} from "../src/settings/index.ts";
import { readCheckoutInitial } from "./checkout-view-fixture.ts";
import { displaySettingsDowngradeSql } from "./display-schema-fixture.ts";
import {
  financialHeaders,
  login,
  withHttpFixture,
} from "./reconciliation-http-fixture.ts";

it("persists validated display settings with CSRF, revisions and audit without changing payment state", async () => {
  await withHttpFixture(async ({ app, services, database, createOrder }) => {
    createOrder("display-contract", 1000);
    const original = services.settings.instanceView();
    const ordersBefore = database.read((c) =>
      c.prepare("SELECT * FROM payment_orders").all(),
    );
    const auth = await login(app);
    const headers = financialHeaders(auth);
    const input = {
      system_name: "星河收款",
      revision: original.revision,
      dashboard_chart_type: "BAR",
    };
    const save = (body: unknown, requestHeaders = headers) =>
      app.request("/api/admin/v1/settings/display", {
        method: "PUT",
        headers: requestHeaders,
        body: JSON.stringify(body),
      });
    assert.deepEqual(original.display, {
      system_name: "PerPay",
      dashboard_chart_type: "AREA",
    });
    assert.equal(
      (
        await save(input, {
          "content-type": "application/json",
          origin: "http://localhost:6190",
        })
      ).status,
      401,
    );
    const { "x-csrf-token": _csrf, ...withoutCsrf } = headers;
    assert.equal((await save(input, withoutCsrf)).status, 403);
    assert.equal(
      (await save(input, { ...headers, origin: "https://other.example" }))
        .status,
      403,
    );
    for (const bad of [
      { ...input, dashboard_chart_type: "PIE" },
      { ...input, checkout_show_product_name: "false" },
      { ...input, revision: -1 },
      { ...input, unknown: true },
    ])
      assert.equal((await save(bad)).status, 422);
    assert.equal(services.settings.instanceView().revision, original.revision);
    const response = await save(input);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const saved = services.settings.instanceView();
    assert.equal(saved.revision, original.revision + 1);
    assert.equal(saved.payment_revision, original.payment_revision);
    assert.deepEqual(saved.display, {
      system_name: "星河收款",
      dashboard_chart_type: "BAR",
    });
    assert.deepEqual(saved.provider, original.provider);
    assert.deepEqual(saved.collection, original.collection);
    assert.deepEqual(saved.secrets, original.secrets);
    assert.deepEqual(
      database.read((c) => c.prepare("SELECT * FROM payment_orders").all()),
      ordersBefore,
    );
    assert.equal((await save(input)).status, 409);
    const audit = database.read((c) =>
      c
        .prepare(
          "SELECT details_json FROM audit_events WHERE action = 'settings.display_updated'",
        )
        .all(),
    ) as { details_json: string }[];
    assert.equal(audit.length, 1);
    assert.deepEqual(JSON.parse(audit[0]!.details_json), {
      revision: saved.revision,
      payment_revision_changed: false,
    });
    database.close();
    const reopened = await AppDatabase.open(services.config.databasePath);
    try {
      const settings = new RuntimeSettingsService({
        store: new RuntimeSettingsStore(reopened, services.config.masterKey),
      });
      settings.initialize();
      assert.deepEqual(settings.instanceView().display, saved.display);
      assert.equal(reopened.integrityCheck().ok, true);
    } finally {
      reopened.close();
    }
  });
});

it("applies checkout product visibility to SSR without changing public order data or payment instructions", async () => {
  await withHttpFixture(
    async ({ app, services, createOrder, createSettlement }) => {
      const order = createOrder("checkout-visible", 1000);
      const paid = createSettlement("checkout-paid", 2000).order;
      setTestSiteDisplay(services.sites, "default", { checkout_show_product_name: false });
      for (const record of [order, paid]) {
        const response = await app.request("/checkout/" + record.checkoutToken);
        assert.equal(response.status, 200);
        const html = await response.text();
        const initial = readCheckoutInitial(html);
        assert.equal(initial.showProductName, false);
        assert.equal(initial.checkout?.product_name, "");
        assert.doesNotMatch(html, /data-product-name/);
        const publicResponse = await app.request(
          "/api/public/v1/checkouts/" + record.checkoutToken,
        );
        assert.equal(publicResponse.status, 200);
        const publicData = (await publicResponse.json()) as {
          data: { product_name: string };
        };
        assert.equal(publicData.data.product_name, record.productName);
      }
      setTestSiteDisplay(services.sites, "default", { checkout_show_product_name: true });
      const html = await (
        await app.request("/checkout/" + order.checkoutToken)
      ).text();
      assert.match(html, /data-product-name/);
      assert.equal(
        readCheckoutInitial(html).checkout?.product_name,
        order.productName,
      );
    },
  );
});

it("upgrades schema 23 with presentation defaults while preserving revisions, collection timing and evidence", async () => {
  await withLegacyPaymentFixture(async ({ database, services, createSettlement }) => {
    createSettlement("display-migration", 990);
    const before = services.settings.instanceView();
    const tables = [
      "payment_orders",
      "order_events",
      "outbox_events",
      "audit_events",
    ];
    const snapshot = (db: AppDatabase) =>
      db.read((c) =>
        tables.map((t) =>
          c.prepare("SELECT * FROM " + t + " ORDER BY rowid").all(),
        ),
      );
    const evidence = snapshot(database);
    for (const row of evidence[0]!) row.alipay_account_id = "default";
    database.close();
    const legacy = new DatabaseSync(services.config.databasePath);
    try {
      legacy.exec(
        "BEGIN IMMEDIATE;" + displaySettingsDowngradeSql() + "COMMIT;",
      );
    } finally {
      legacy.close();
    }
    const upgraded = await AppDatabase.open(services.config.databasePath, { masterKey: services.config.masterKey });
    try {
      const settings = new RuntimeSettingsService({
        store: new RuntimeSettingsStore(upgraded, services.config.masterKey),
      });
      settings.initialize();
      const after = settings.instanceView();
      assert.equal(after.revision, before.revision);
      assert.equal(after.payment_revision, before.payment_revision);
      assert.deepEqual(after.provider, before.provider);
      assert.deepEqual(after.display, { system_name: "PerPay", dashboard_chart_type: "AREA" });
      assert.deepEqual(settings.siteStore()!.get("default")!.configuration.policy.display, { checkout_name: "PerPay", checkout_help_url: null, checkout_show_product_name: true });
      assert.deepEqual(snapshot(upgraded), evidence);
      assert.equal(upgraded.integrityCheck().ok, true);
    } finally {
      upgraded.close();
    }
  });
});

for (const failure of [429, 503] as const) {
  it(
    "preserves product privacy on the " +
      failure +
      " checkout error",
    async () => {
      await withHttpFixture(async ({ app, services, createOrder }) => {
        const order = createOrder("display-recovery-" + failure, 4900);
        setTestSiteDisplay(services.sites, "default", { checkout_show_product_name: false });
        const failureMock =
          failure === 429
            ? mock.method(
                PublicCheckoutRateLimiter.prototype,
                "take",
                () => false,
              )
            : mock.method(services.orders, "publicCheckout", () => {
                throw new OrderError(
                  "order_clock_unavailable",
                  "clock unavailable",
                  1,
                );
              });
        try {
          const response = await app.request(
            "/checkout/" + order.checkoutToken,
          );
          assert.equal(response.status, failure);
          const html = await response.text();
          if (failure === 429) {
            assert.match(html, /请求过于频繁/);
            assert.doesNotMatch(html, /<script|data-checkout|data-qr-image/);
            assert.equal(html.includes(order.checkoutToken), false);
          } else {
            const initial = readCheckoutInitial(html);
            assert.equal(initial.checkout, null);
            assert.equal(initial.initialError?.status, failure);
            assert.equal(initial.showProductName, false);
          }
        } finally {
          failureMock.mock.restore();
        }
        const recovered = await app.request(
          "/api/public/v1/checkouts/" + order.checkoutToken,
        );
        assert.equal(recovered.status, 200);
        assert.equal(
          ((await recovered.json()) as { data: { product_name: string } }).data
            .product_name,
          order.productName,
        );
      });
    },
  );
}

it("reads display preferences without decryption and rejects limited requests without a bootstrap", async () => {
  await withHttpFixture(async ({ app, services, createOrder }) => {
    const order = createOrder("display-no-decryption", 1000);
    const expected = services.settings.display();
    const decryption = mock.method(
      RuntimeSecretCipher.prototype,
      "decrypt",
      () => {
        throw new Error("display rendering must not decrypt credentials");
      },
    );
    const limiter = mock.method(
      PublicCheckoutRateLimiter.prototype,
      "take",
      () => false,
    );
    try {
      assert.deepEqual(services.settings.display(), expected);
      const response = await app.request("/checkout/" + order.checkoutToken);
      assert.equal(response.status, 429);
      const html = await response.text();
      assert.match(html, /请求过于频繁/);
      assert.doesNotMatch(html, /<script|data-checkout/);
      assert.equal(decryption.mock.callCount(), 0);
    } finally {
      limiter.mock.restore();
      decryption.mock.restore();
    }
  });
});

it("renders a lightweight limited page without attempting a failing display settings read", async () => {
  await withHttpFixture(async ({ app, services, createOrder }) => {
    const order = createOrder("display-read-failure", 1000);
    const display = mock.method(services.settings, "display", () => {
      throw new Error("configuration temporarily unavailable");
    });
    const limiter = mock.method(
      PublicCheckoutRateLimiter.prototype,
      "take",
      () => false,
    );
    try {
      const response = await app.request("/checkout/" + order.checkoutToken);
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "1");
      const html = await response.text();
      assert.match(html, /请求过于频繁/);
      assert.doesNotMatch(html, /<script|data-checkout/);
      assert.equal(html.includes(order.checkoutToken), false);
      assert.equal(display.mock.callCount(), 0);
      assert.doesNotMatch(
        html,
        /configuration temporarily unavailable|data-qr-image/,
      );
    } finally {
      limiter.mock.restore();
      display.mock.restore();
    }
  });
});

it("validates and persists a public system name while legacy display requests preserve it", async () => {
  await withHttpFixture(async ({ app, services }) => {
    const auth = await login(app);
    const input = { revision: services.settings.instanceView().revision,
      dashboard_chart_type: "AREA" };
    const save = (body: unknown) => app.request("/api/admin/v1/settings/display", {
      method: "PUT", headers: financialHeaders(auth), body: JSON.stringify(body),
    });
    for (const system_name of ["", "   ", "x".repeat(41), "bad\u0000name", "bad\nname", "bad\u202ename", 123]) {
      assert.equal((await save({ ...input, system_name })).status, 422);
    }
    assert.equal(services.settings.instanceView().revision, input.revision);
    assert.equal((await save({ ...input, system_name: "  星河收款  " })).status, 200);
    assert.equal(services.settings.instanceView().display.system_name, "星河收款");
    assert.equal(services.settings.display().systemName, "星河收款");
    assert.equal((await save({ ...input, revision: input.revision + 1 })).status, 200);
    assert.equal(services.settings.instanceView().display.system_name, "星河收款");
    assert.equal((await save({ ...input, revision: input.revision + 2, system_name: "PerPay" })).status, 200);
    assert.equal(services.settings.instanceView().display.system_name, "PerPay");
  });
});

it("escapes public names and reads anonymous branding without decrypting secrets", async () => {
  await withHttpFixture(async ({ app, services, createOrder }) => {
    const order = createOrder("brand-checkout", 1000);
    const name = '"/><script>x</script>& $&';
    await services.settings.saveInstanceDisplay({ revision: services.settings.instanceView().revision,
      system_name: name, dashboard_chart_type: "AREA" }, { actorId: "admin" });
    setTestSiteDisplay(services.sites, "default", { checkout_name: name });
    const decrypt = mock.method(RuntimeSecretCipher.prototype, "decrypt", () => { throw new Error("secrets must not be read"); });
    try {
      for (const path of ["/admin/", "/admin/login", "/admin/setup"]) {
        const response = await app.request(path);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const html = await response.text();
        assert.ok(html.includes('name="perpay-system-name" content="&quot;/&gt;&lt;script&gt;x&lt;/script&gt;&amp; $&amp;"'));
        assert.ok(!html.includes("<script>x</script>") && !html.includes("__PERPAY_SYSTEM_NAME__"));
      }
      assert.equal(decrypt.mock.callCount(), 0);
      decrypt.mock.restore();
      for (const token of [order.checkoutToken, `pct1_${"A".repeat(43)}`]) {
        const response = await app.request("/checkout/" + token);
        const html = await response.text();
        assert.equal(readCheckoutInitial(html).systemName, name);
        assert.ok(!html.includes("<script>x</script>"));
      }
    } finally { decrypt.mock.restore(); }
  });
});
