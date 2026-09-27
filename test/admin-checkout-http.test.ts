import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { createApp } from "../src/http/app.ts";
import { OrderService } from "../src/orders/service.ts";
import {
  login,
  postFinancial,
  withHttpFixture,
  type ReconciliationHttpFixture,
} from "./reconciliation-http-fixture.ts";

const checkoutPath = (orderId: string) =>
  "/api/admin/v1/orders/" + orderId + "/checkout";
function snapshot(fixture: ReconciliationHttpFixture) {
  return fixture.database.read((connection) =>
    Object.fromEntries(
      [
        "payment_orders",
        "checkout_sessions",
        "checkout_token_keys",
        "order_events",
        "payment_matches",
        "financial_operations",
        "ledger_entries",
        "runtime_configuration",
        "order_clock",
      ].map((table) => [
        table,
        connection
          .prepare('SELECT * FROM "' + table + '" ORDER BY rowid')
          .all(),
      ]),
    ),
  );
}
function assertRedirect(response: Response, token: string) {
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/checkout/" + token);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
}

describe("administrator checkout navigation", () => {
  it("requires a live administrator session before resolving an order", async () => {
    await withHttpFixture(async (fixture) => {
      const order = fixture.createOrder("checkout-auth", 100);
      for (const path of [
        checkoutPath(order.orderId),
        checkoutPath("not-an-order"),
      ]) {
        for (const headers of [{}, { cookie: "perpay_session=invalid" }]) {
          const response = await fixture.app.request(path, { headers });
          assert.equal(response.status, 401);
          assert.equal(response.headers.get("location"), null);
          assert.equal(
            (await response.text()).includes(order.checkoutToken),
            false,
          );
        }
      }
    });
  });

  it("does not resolve a checkout after the administrator session is revoked", async () => {
    await withHttpFixture(async (fixture) => {
      const auth = await login(fixture.app);
      const order = fixture.createOrder("checkout-revoked-session", 100);
      const logout = await postFinancial(
        fixture.app,
        "/api/admin/v1/session/logout",
        auth,
        {},
      );
      assert.equal(logout.status, 204);
      const response = await fixture.app.request(checkoutPath(order.orderId), {
        headers: { cookie: auth.cookie },
      });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("location"), null);
    });
  });

  it("returns the original same-origin capability only on explicit navigation without changing business records", async () => {
    await withHttpFixture(async (fixture) => {
      const auth = await login(fixture.app);
      const order = fixture.createOrder("checkout-existing", 101);
      const before = snapshot(fixture);
      const headers = {
        cookie: auth.cookie,
        host: "untrusted.example",
        "x-forwarded-host": "untrusted.example",
      };
      for (let count = 0; count < 2; count += 1) {
        const response = await fixture.app.request(
          checkoutPath(order.orderId) + "?redirect=https://untrusted.example",
          { headers },
        );
        assertRedirect(response, order.checkoutToken);
        assert.equal(await response.text(), "");
        assert.deepEqual(snapshot(fixture), before);
      }
      const page = await fixture.app.request(
        "/checkout/" + order.checkoutToken,
      );
      assert.equal(page.status, 200);
      const publicState = await fixture.app.request(
        "/api/public/v1/checkouts/" + order.checkoutToken,
      );
      const publicBody = (await publicState.json()) as {
        data: { payment_instructions: unknown; checkout: { status: string } };
      };
      assert.equal(publicBody.data.checkout.status, "OPEN");
      assert.notEqual(publicBody.data.payment_instructions, null);
      for (const path of [
        "/api/admin/v1/orders",
        "/api/admin/v1/orders/" + order.orderId,
        "/api/admin/v1/orders/by-merchant-no/" + order.merchantOrderNo,
      ]) {
        const response = await fixture.app.request(path, {
          headers: { cookie: auth.cookie },
        });
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.equal(text.includes(order.checkoutToken), false);
        assert.equal(text.includes("checkout_url"), false);
        assert.equal(text.includes("token_digest"), false);
      }
      assert.equal(fixture.database.integrityCheck().ok, true);
    });
  });

  it("returns 404 without a redirect for invalid or missing order identifiers", async () => {
    await withHttpFixture(async (fixture) => {
      const auth = await login(fixture.app);
      for (const id of [
        "not-a-uuid",
        randomUUID(),
        "12345678-1234-1234-1234-123456789012",
      ]) {
        const response = await fixture.app.request(checkoutPath(id), {
          headers: { cookie: auth.cookie },
        });
        assert.equal(response.status, 404);
        assert.equal(response.headers.get("location"), null);
        assert.equal(
          ((await response.json()) as { error: { code: string } }).error.code,
          "order_not_found",
        );
      }
    });
  });

  it("opens closed and paid checkout state without reopening payments or generating another token", async () => {
    await withHttpFixture(async (fixture) => {
      const auth = await login(fixture.app);
      const closed = fixture.closeOrder(
        fixture.createOrder("checkout-closed", 201).orderId,
      );
      const paid = fixture.createSettlement("checkout-paid", 301).order;
      for (const order of [closed, paid]) {
        const before = snapshot(fixture);
        const redirect = await fixture.app.request(
          checkoutPath(order.orderId),
          { headers: { cookie: auth.cookie } },
        );
        assertRedirect(redirect, order.checkoutToken);
        assert.deepEqual(snapshot(fixture), before);
        const response = await fixture.app.request(
          "/api/public/v1/checkouts/" + order.checkoutToken,
        );
        assert.equal(response.status, 200);
        const body = (await response.json()) as {
          data: {
            payment_instructions: unknown;
            payment: { status: string };
            checkout: { status: string };
          };
        };
        assert.equal(body.data.payment_instructions, null);
        assert.equal(body.data.checkout.status, order.checkout.status);
        assert.equal(
          body.data.payment.status,
          order.orderId === closed.orderId ? "UNPAID" : "CONFIRMED",
        );
      }
    });
  });

  it("leaves expiry and the terminal observation limit under public checkout enforcement", async () => {
    await withHttpFixture(async (fixture) => {
      const auth = await login(fixture.app);
      const order = fixture.createOrder("checkout-expiry", 401);
      let now = order.checkout.expiresAt + 1;
      const orders = new OrderService(
        fixture.database,
        () => fixture.services.settings.snapshot(),
        () => now,
      );
      const app = createApp({
        ...fixture.services,
        orders,
        startedAt: new Date(fixture.baseTime),
        clock: () => now,
      });
      const before = snapshot(fixture);
      assertRedirect(
        await app.request(checkoutPath(order.orderId), {
          headers: { cookie: auth.cookie },
        }),
        order.checkoutToken,
      );
      assert.deepEqual(snapshot(fixture), before);
      const expired = await app.request(
        "/api/public/v1/checkouts/" + order.checkoutToken,
      );
      assert.equal(expired.status, 200);
      const expiredBody = (await expired.json()) as {
        data: { checkout: { status: string }; payment_instructions: unknown };
      };
      assert.equal(expiredBody.data.checkout.status, "EXPIRED");
      assert.equal(expiredBody.data.payment_instructions, null);
      now += 2 * 24 * 60 * 60 * 1_000;
      assert.equal(
        (await app.request("/api/public/v1/checkouts/" + order.checkoutToken))
          .status,
        404,
      );
      const revoked = snapshot(fixture);
      assertRedirect(
        await app.request(checkoutPath(order.orderId), {
          headers: { cookie: auth.cookie },
        }),
        order.checkoutToken,
      );
      assert.deepEqual(snapshot(fixture), revoked);
      assert.equal(
        (await app.request("/checkout/" + order.checkoutToken)).status,
        404,
      );
    });
  });

  it("does not bypass the public payment-entry readiness checks", async () => {
    await withHttpFixture(async (fixture) => {
      const auth = await login(fixture.app);
      const order = fixture.createOrder("checkout-unready", 501);
      const app = createApp({
        ...fixture.services,
        startedAt: new Date(fixture.baseTime),
        clock: () => fixture.baseTime,
      });
      assertRedirect(
        await app.request(checkoutPath(order.orderId), {
          headers: { cookie: auth.cookie },
        }),
        order.checkoutToken,
      );
      const response = await app.request("/checkout/" + order.checkoutToken);
      assert.equal(response.status, 503);
      assert.equal(
        (await response.text()).includes("reconciliation_not_ready"),
        true,
      );
    });
  });
});
