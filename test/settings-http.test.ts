import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createApp } from "../src/http/app.ts";
import {
  createConfiguredHttpServices,
  HTTP_TEST_ADMIN_PASSWORD,
} from "./http-fixture.ts";

const origin = "http://localhost:6190";
const apiSecret = Buffer.alloc(32, 0x72).toString("base64url");

describe("advanced settings HTTP contract", () => {
  it("requires a current revision and persists checkout lifecycle settings", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-advanced-settings-"));
    const { config, database, identity, settings, orders } = await createConfiguredHttpServices({
      directory,
      apiSecret,
      collectionCodePayload: "https://qr.local.invalid/http-advanced-settings",
      publicUrl: origin,
    });
    const app = createApp({ config, database, identity, settings, orders, startedAt: new Date(0) });
    try {
      const elevatedHeaders = await loginAndStepUp(app);
      const saved = await app.request("/api/admin/v1/settings/advanced", {
        method: "PUT",
        headers: elevatedHeaders,
        body: JSON.stringify({
          revision: 3,
          checkout_key_rotation_days: 30,
          checkout_terminal_observation_seconds: 3_600,
        }),
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.headers.get("cache-control"), "no-store");
      const savedBody = await saved.json() as {
        data: {
          revision: number;
          payment_revision: number;
          advanced: {
            checkout_key_rotation_days: number;
            checkout_terminal_observation_seconds: number;
          };
        };
      };
      assert.equal(savedBody.data.revision, 4);
      assert.equal(savedBody.data.payment_revision, 2);
      assert.deepEqual(savedBody.data.advanced, {
        checkout_key_rotation_days: 30,
        checkout_terminal_observation_seconds: 3_600,
      });

      const stale = await app.request("/api/admin/v1/settings/advanced", {
        method: "PUT",
        headers: elevatedHeaders,
        body: JSON.stringify({
          revision: 3,
          checkout_key_rotation_days: 60,
          checkout_terminal_observation_seconds: 7_200,
        }),
      });
      assert.equal(stale.status, 409);
      assert.equal(
        (await stale.json() as { error: { code: string } }).error.code,
        "settings_revision_conflict",
      );

      const invalid = await app.request("/api/admin/v1/settings/advanced", {
        method: "PUT",
        headers: elevatedHeaders,
        body: JSON.stringify({
          revision: 4,
          checkout_key_rotation_days: 0,
          checkout_terminal_observation_seconds: 59,
        }),
      });
      assert.equal(invalid.status, 422);
      assert.equal(
        (await invalid.json() as { error: { code: string } }).error.code,
        "validation_failed",
      );

      const audit = database.read((connection) => connection.prepare(
        `SELECT details_json FROM audit_events
          WHERE action = 'settings.advanced_updated'`,
      ).get() as { details_json: string });
      assert.deepEqual(JSON.parse(audit.details_json), {
        checkout_key_rotation_days: 30,
        checkout_terminal_observation_seconds: 3_600,
        payment_revision_changed: false,
        revision: 4,
      });
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function loginAndStepUp(app: ReturnType<typeof createApp>): Promise<Record<string, string>> {
  const login = await app.request("/api/admin/v1/session/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json() as { data: { csrf_token: string } };
  const loginCookie = login.headers.getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const stepUp = await app.request("/api/admin/v1/session/step-up", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      cookie: loginCookie,
      "x-csrf-token": loginBody.data.csrf_token,
    },
    body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }),
  });
  assert.equal(stepUp.status, 200);
  const stepUpBody = await stepUp.json() as { data: { csrf_token: string } };
  return {
    "content-type": "application/json",
    origin,
    cookie: stepUp.headers.getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; "),
    "x-csrf-token": stepUpBody.data.csrf_token,
  };
}
