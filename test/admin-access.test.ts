import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runAllowlistRecovery } from "../src/identity/disable-admin-allowlist.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createIpPolicy } from "../src/infrastructure/network/ip-policy.ts";
import { adminAccessSchema, createAdminAccessPolicy } from "../src/settings/admin-access.ts";
import { createApp } from "../src/http/app.ts";
import {
  createConfiguredHttpServices,
  HTTP_TEST_ADMIN_PASSWORD,
} from "./http-fixture.ts";
import { disableAdministratorAllowlist } from "../src/identity/allowlist-recovery.ts";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
const audit = {
  actorId: "admin",
  requestId: "allowlist-test",
  remoteAddressHash: "0".repeat(64),
};
describe("administrator IP allowlist", () => {
  it("matches IPv4, IPv6 and mapped addresses and validates rules", () => {
    const mapped = createAdminAccessPolicy(["::ffff:192.0.2.0/120"]);
    assert.equal(mapped.isTrusted("192.0.2.1"), true);
    assert.equal(mapped.isTrusted("192.0.3.1"), false);
    assert.equal(adminAccessSchema.safeParse({enabled:true,cidrs:["::ffff:192.0.2.1/128"]}).success,true);
    const policy = createIpPolicy(["192.0.2.0/24", "2001:db8::/64"]);
    for (const ip of [
      "192.0.2.255",
      "::ffff:192.0.2.5",
      "::ffff:c000:205",
      "2001:db8::1",
    ])
      assert.equal(policy.isTrusted(ip), true, ip);
    for (const ip of ["192.0.3.0", "2001:db8:0:1::1", "unknown", "127.0.0.1"])
      assert.equal(policy.isTrusted(ip), false, ip);
    for (const cidrs of [
      [""],
      ["example.com"],
      ["192.0.2.1:80"],
      ["0.0.0.0/0"],
      ["::/0"],
      ["::/129"],
      Array(101).fill("192.0.2.1"),
    ])
      assert.equal(
        adminAccessSchema.safeParse({ enabled: false, cidrs }).success,
        false,
      );
    assert.equal(
      adminAccessSchema.safeParse({ enabled: true, cidrs: [] }).success,
      false,
    );
  });
  for (const proxied of [false, true])
    it("enforces routes and prevents lockout: proxy=" + proxied, async () => {
      const directory = mkdtempSync(join(tmpdir(), "perpay-allowlist-"));
      const services = await createConfiguredHttpServices({
        directory,
        apiSecret: null,
        collectionCodePayload: "https://qr.alipay.com/allowlist",
        environment: {
          PERPAY_TRUSTED_PROXY_CIDRS: proxied ? "127.0.0.1/32" : "",
        },
      });
      const app = createApp({ ...services, startedAt: new Date() });
      const request = (path: string, ip: string, init: RequestInit = {}) =>
        app.request(
          "http://localhost:6190" + path,
          {
            ...init,
            headers: {
              ...(proxied ? { "x-forwarded-for": ip } : {}),
              ...init.headers,
            },
          },
          {
            incoming: {
              socket: {
                remoteAddress: proxied ? "127.0.0.1" : ip,
                remotePort: 1234,
                remoteFamily: "IPv4",
              },
            },
          },
        );
      try {
        assert.deepEqual(services.settings.adminAccess(), {
          enabled: false,
          cidrs: [],
        });
        const before = services.settings.view();
        await assert.rejects(
          services.settings.saveAdminAccess(
            {
              revision: before.revision,
              enabled: true,
              cidrs: ["198.51.100.1"],
            },
            "192.0.2.1",
            audit,
          ),
        );
        assert.equal(services.settings.view().revision, before.revision);
        await services.settings.saveAdminAccess(
          { revision: before.revision, enabled: true, cidrs: ["192.0.2.0/24"] },
          "192.0.2.1",
          audit,
        );
        assert.equal(
          services.settings.view().payment_revision,
          before.payment_revision,
        );
        await assert.rejects(
          services.settings.saveAdminAccess(
            { revision: before.revision, enabled: false, cidrs: [] },
            "192.0.2.1",
            audit,
          ),
        );
        for (const path of [
          "/admin",
          "/admin/settings/security",
          "/admin/assets/no.js",
          "/api/admin",
          "/api/admin/v1/session/login",
          "/api/admin/v1/setup",
          "/api/admin/v1/settings",
        ]) {
          for (const method of ["GET", "POST", "HEAD", "OPTIONS"]) {
            const response = await request(path, "198.51.100.1", { method });
            assert.equal(response.status, 403, path + method);
            assert.equal(response.headers.get("cache-control"), "no-store");
          }
        }
        assert.equal(
          (await request("/api/admin/v1/settings", "192.0.2.1")).status,
          401,
        );
        assert.equal((await request("/healthz", "198.51.100.1")).status, 200);
        assert.notEqual((await request("/readyz", "198.51.100.1")).status, 403);
        const unknown = await app.request("/api/admin/v1/settings");
        assert.equal(unknown.status, 403);
        const spoof = await request("/api/admin/v1/settings", "198.51.100.1", {
          headers: {
            "x-forwarded-for": proxied
              ? "192.0.2.1, 198.51.100.1"
              : "192.0.2.1",
          },
        });
        assert.equal(spoof.status, 403);
        const login = await request(
          "/api/admin/v1/session/login",
          "192.0.2.1",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "http://localhost:6190",
            },
            body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }),
          },
        );
        assert.equal(login.status, 200);
        const cookie = login.headers
          .getSetCookie()
          .map((v) => v.split(";")[0])
          .join("; ");
        assert.equal(
          (
            await request("/api/admin/v1/settings", "198.51.100.1", {
              headers: { cookie },
            })
          ).status,
          403,
        );
        const view = await request(
          "/api/admin/v1/settings/admin-access",
          "192.0.2.1",
          { headers: { cookie } },
        );
        assert.equal(view.status, 200);
        assert.equal(
          ((await view.json()) as { data: { current_ip: string } }).data
            .current_ip,
          "192.0.2.1",
        );
        const csrf = decodeURIComponent(
          cookie.match(/perpay_csrf=([^;]+)/)![1]!,
        );
        const put = (body: unknown, headers: Record<string, string> = {}) =>
          request("/api/admin/v1/settings/admin-access", "192.0.2.1", {
            method: "PUT",
            headers: {
              cookie,
              origin: "http://localhost:6190",
              "content-type": "application/json",
              "x-csrf-token": csrf,
              ...headers,
            },
            body: JSON.stringify(body),
          });
        const revision = services.settings.view().revision;
        assert.equal(
          (
            await put(
              { revision, enabled: false, cidrs: [] },
              { "x-csrf-token": "wrong" },
            )
          ).status,
          403,
        );
        assert.equal(
          (await put({ revision, enabled: true, cidrs: ["198.51.100.1"] }))
            .status,
          422,
        );
        assert.equal(
          (await put({ revision, enabled: false, cidrs: ["bad-ip"] })).status,
          422,
        );
        assert.equal(
          (await put({ revision: revision - 1, enabled: false, cidrs: [] }))
            .status,
          409,
        );
        assert.equal(
          (await put({ revision, enabled: false, cidrs: ["192.0.2.0/24"] }))
            .status,
          200,
        );
        assert.equal(
          (
            await request("/api/admin/v1/settings", "198.51.100.1", {
              headers: { cookie },
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await put({
              revision: revision + 1,
              enabled: true,
              cidrs: ["192.0.2.0/24"],
            })
          ).status,
          200,
        );
        if (proxied)
          assert.equal(
            (
              await request("/api/admin/v1/settings", "192.0.2.1", {
                headers: { "x-forwarded-for": "bad" },
              })
            ).status,
            400,
          );
        await assert.rejects(
          disableAdministratorAllowlist({
            dataDirectory: join(directory, "data"),
            confirmed: true,
          }),
          /租约/,
        );
        await assert.rejects(
          disableAdministratorAllowlist({
            dataDirectory: join(directory, "data"),
            confirmed: false,
          }),
          /未确认/,
        );
        services.database.close();
        await disableAdministratorAllowlist({
          dataDirectory: join(directory, "data"),
          confirmed: true,
        });
        const reopened = await AppDatabase.open(services.config.databasePath);
        try {
          const store = new RuntimeSettingsStore(
            reopened,
            services.config.masterKey,
          );
          assert.deepEqual(store.adminAccess(), {
            enabled: false,
            cidrs: ["192.0.2.0/24"],
          });
          assert.equal(reopened.health().ok, true);
        } finally {
          reopened.close();
        }
      } finally {
        services.database.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  it("migrates schema 31 with disabled defaults and refuses invalid policy state", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "perpay-allowlist-migration-"),
    );
    const services = await createConfiguredHttpServices({
      directory,
      apiSecret: null,
      collectionCodePayload: "https://qr.alipay.com/allowlist-migration",
    });
    let reopened: AppDatabase | undefined;
    try {
      const before = services.settings.view();
      services.database.close();
      const old = new DatabaseSync(services.config.databasePath);
      try {
        old.exec(
          "DROP TABLE ledger_scan_gate; ALTER TABLE runtime_configuration DROP COLUMN provider_minimum_scan_interval_milliseconds; DELETE FROM schema_migrations WHERE version = 33; ALTER TABLE runtime_configuration DROP COLUMN admin_access; DELETE FROM schema_migrations WHERE version = 32;",
        );
      } finally {
        old.close();
      }
      await assert.rejects(
        disableAdministratorAllowlist({
          dataDirectory: services.config.dataDir,
          confirmed: true,
        }),
      );
      reopened = await AppDatabase.open(services.config.databasePath);
      const store = new RuntimeSettingsStore(
        reopened,
        services.config.masterKey,
      );
      assert.deepEqual(store.adminAccess(), { enabled: false, cidrs: [] });
      assert.equal(store.snapshot().revision, before.revision);
      assert.equal(store.snapshot().paymentRevision, before.payment_revision);
      const app = createApp({
        ...services,
        database: reopened,
        settings: undefined,
        startedAt: new Date(),
      });
      reopened.write((connection) =>
        connection.exec(
          `UPDATE runtime_configuration SET revision = revision + 1, admin_access = '{"enabled":true,"cidrs":["bad-ip"]}'`,
        ),
      );
      assert.equal(reopened.integrityCheck().ok, false);
      assert.equal((await app.request("/admin")).status, 500);
      assert.equal(
        (await app.request("/api/admin/v1/session/login", { method: "POST" }))
          .status,
        500,
      );
      reopened.write((connection) =>
        connection.exec(
          `UPDATE runtime_configuration SET revision = revision + 1, admin_access = '{"enabled":false,"cidrs":[]}'`,
        ),
      );
      assert.equal(reopened.integrityCheck().ok, true);
      await assert.rejects(runAllowlistRecovery([]));
      await assert.rejects(
        runAllowlistRecovery([
          "--confirm-disable-admin-allowlist",
          "--unexpected",
        ]),
      );
    } finally {
      reopened?.close();
      services.database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
