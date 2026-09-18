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
    const original = services.settings.view();
    const ordersBefore = database.read((c) =>
      c.prepare("SELECT * FROM payment_orders").all(),
    );
    const auth = await login(app);
    const headers = financialHeaders(auth);
    const input = {
      revision: original.revision,
      checkout_show_product_name: false,
      dashboard_chart_type: "BAR",
    };
    const save = (body: unknown, requestHeaders = headers) =>
      app.request("/api/admin/v1/settings/display", {
        method: "PUT",
        headers: requestHeaders,
        body: JSON.stringify(body),
      });
    assert.deepEqual(original.display, {
      checkout_show_product_name: true,
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
    assert.equal(services.settings.view().revision, original.revision);
    const response = await save(input);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const saved = services.settings.view();
    assert.equal(saved.revision, original.revision + 1);
    assert.equal(saved.payment_revision, original.payment_revision);
    assert.deepEqual(saved.display, {
      checkout_show_product_name: false,
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
      ...input,
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
      assert.deepEqual(settings.view().display, saved.display);
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
      await services.settings.saveDisplay(
        {
          revision: services.settings.view().revision,
          checkout_show_product_name: false,
          dashboard_chart_type: "LINE",
        },
        { actorId: "admin" },
      );
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
      await services.settings.saveDisplay(
        {
          revision: services.settings.view().revision,
          checkout_show_product_name: true,
          dashboard_chart_type: "AREA",
        },
        { actorId: "admin" },
      );
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
  await withHttpFixture(async ({ database, services, createSettlement }) => {
    createSettlement("display-migration", 990);
    const before = services.settings.view();
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
    database.close();
    const legacy = new DatabaseSync(services.config.databasePath);
    try {
      legacy.exec(
        "BEGIN IMMEDIATE;" + displaySettingsDowngradeSql() + "COMMIT;",
      );
    } finally {
      legacy.close();
    }
    const upgraded = await AppDatabase.open(services.config.databasePath);
    try {
      const settings = new RuntimeSettingsService({
        store: new RuntimeSettingsStore(upgraded, services.config.masterKey),
      });
      settings.initialize();
      const after = settings.view();
      assert.equal(after.revision, before.revision);
      assert.equal(after.payment_revision, before.payment_revision);
      assert.deepEqual(after.provider, before.provider);
      assert.deepEqual(after.display, {
        checkout_show_product_name: true,
        dashboard_chart_type: "AREA",
      });
      assert.deepEqual(snapshot(upgraded), evidence);
      assert.equal(upgraded.integrityCheck().ok, true);
    } finally {
      upgraded.close();
    }
  });
});

for (const failure of [429, 503] as const) {
  it(
    "keeps product visibility disabled in the recoverable " +
      failure +
      " checkout bootstrap",
    async () => {
      await withHttpFixture(async ({ app, services, createOrder }) => {
        const order = createOrder("display-recovery-" + failure, 4900);
        await services.settings.saveDisplay(
          {
            revision: services.settings.view().revision,
            checkout_show_product_name: false,
            dashboard_chart_type: "AREA",
          },
          { actorId: "admin" },
        );
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
          const initial = readCheckoutInitial(await response.text());
          assert.equal(initial.checkout, null);
          assert.equal(initial.initialError?.status, failure);
          assert.equal(initial.showProductName, false);
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

it("reads display preferences without decrypting credentials, including rate-limited checkout requests", async () => {
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
      const initial = readCheckoutInitial(await response.text());
      assert.equal(initial.showProductName, expected.checkoutShowProductName);
      assert.equal(decryption.mock.callCount(), 0);
    } finally {
      limiter.mock.restore();
      decryption.mock.restore();
    }
  });
});

it("keeps a rate-limited error page recoverable when the display settings read also fails", async () => {
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
      const initial = readCheckoutInitial(html);
      assert.equal(initial.showProductName, false);
      assert.equal(initial.qrAvailable, false);
      assert.equal(initial.initialError?.status, 429);
      assert.equal(
        initial.apiUrl,
        "/api/public/v1/checkouts/" + order.checkoutToken,
      );
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
