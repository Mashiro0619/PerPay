import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AppDatabase } from "../src/database/database.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import {
  RuntimeSettingsService,
  RuntimeSettingsStore,
  type RuntimeSettingsSnapshot,
} from "../src/settings/index.ts";
import type { ProviderKeyVerifier } from "../src/settings/provider-key-verification.ts";

export const keyMaster = Buffer.alloc(32, 0x41);
export const applicationPair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
export const platformPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const nextPlatformPair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
export const privatePem = applicationPair.privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString();
export const platformPem = platformPair.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();
export const nextPlatformPem = nextPlatformPair.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();
export const keyAudit = () => ({ actorId: "admin", requestId: randomUUID() });
export const providerInput = (revision: number) => ({
  revision,
  environment: "PRODUCTION" as const,
  app_id: "rotation-test-app",
  private_key: privatePem,
  platform_public_key: platformPem,
  timeout_milliseconds: 8000,
  scan_interval_seconds: 60,
  active_scan_interval_seconds: 8,
  safety_lag_seconds: 10,
  maximum_success_age_seconds: 120,
});
export const changeRequest = (settings: RuntimeSettingsService) => ({
  revision: settings.view().revision,
  change_id: randomUUID(),
  base_fingerprint: settings.view().application_key_fingerprint!,
});

export async function withKeyFixture(
  active: boolean,
  test: (
    fixture: Awaited<ReturnType<typeof createKeyFixture>>,
  ) => Promise<void>,
): Promise<void> {
  const fixture = await createKeyFixture(active);
  try {
    await test(fixture);
  } finally {
    fixture.database.close();
    assert.equal(dirname(resolve(fixture.directory)), resolve(tmpdir()));
    assert.ok(
      fixture.directory
        .split(/[\\/]/)
        .at(-1)!
        .startsWith("perpay-key-rotation-"),
    );
    rmSync(fixture.directory, { recursive: true, force: true });
  }
}

async function createKeyFixture(active: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "perpay-key-rotation-"));
  const databasePath = join(directory, "perpay.sqlite3");
  const database = await AppDatabase.open(databasePath);
  const events: string[] = [];
  const hooks: {
    verify?: ProviderKeyVerifier;
    apply?: (snapshot: RuntimeSettingsSnapshot) => Promise<void>;
    pause?: () => Promise<void>;
  } = {};
  const services = (db: AppDatabase) => {
    const store = new RuntimeSettingsStore(db, keyMaster);
    const ledger = new LedgerStore(db);
    const settings = new RuntimeSettingsService({
      store,
      providerHistory: () => ledger.providerIdentityHistory(),
      guardProviderSwitch: () => {
        throw new Error("rotation must not switch account identity");
      },
      verifyProviderApplicationKey: async (provider, options) => {
        events.push("verify");
        await hooks.verify?.(provider, options);
      },
      onPaymentMutationStarted: async () => {
        events.push("pause");
        await hooks.pause?.();
      },
      onApplied: async (snapshot) => {
        events.push("apply");
        await hooks.apply?.(snapshot);
      },
    });
    settings.initialize();
    return { store, ledger, settings };
  };
  const fixture = {
    directory,
    databasePath,
    database,
    ...services(database),
    events,
    hooks,
    async reopen(path = databasePath) {
      fixture.database.close();
      fixture.database = await AppDatabase.open(path);
      Object.assign(fixture, services(fixture.database));
    },
  };
  if (active) await fixture.settings.saveProvider(providerInput(0), keyAudit());
  else await fixture.settings.generateProviderApplicationKey(0, keyAudit());
  events.length = 0;
  return fixture;
}
