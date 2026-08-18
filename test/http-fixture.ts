import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { AppDatabase } from "../src/database/database.ts";
import { IdentityService } from "../src/identity/service.ts";
import { OrderService } from "../src/orders/service.ts";
import { RuntimeSettingsService, RuntimeSettingsStore } from "../src/settings/index.ts";

const MASTER_KEY = "0123456789abcdef".repeat(4);
const applicationKeys = generateKeyPairSync("rsa", { modulusLength: 2_048 });
const platformKeys = generateKeyPairSync("rsa", { modulusLength: 2_048 });
const applicationPrivateKey = applicationKeys.privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString();
const platformPublicKey = platformKeys.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();

export const HTTP_TEST_ADMIN_PASSWORD = "a-secure-local-password";

export async function createConfiguredHttpServices(options: {
  readonly directory: string;
  readonly apiSecret: string;
  readonly collectionCodePayload: string;
  readonly publicUrl?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly identityClock?: (() => number) | undefined;
}) {
  const config = loadConfig({
    PERPAY_MASTER_KEY: MASTER_KEY,
    PERPAY_DATA_DIR: join(options.directory, "data"),
    PERPAY_BACKUP_DIR: join(options.directory, "backups"),
    PERPAY_PUBLIC_URL: options.publicUrl ?? "http://localhost:6190",
    ...options.environment,
  });
  const database = await AppDatabase.open(config.databasePath);
  const identity = new IdentityService(database, options.identityClock ?? Date.now);
  await identity.initialize();
  await identity.setupAdmin(HTTP_TEST_ADMIN_PASSWORD);

  const settingsStore = new RuntimeSettingsStore(database, config.masterKey);
  const settings = new RuntimeSettingsService({ store: settingsStore });
  settings.initialize();
  await settings.saveCollection({
    revision: 0,
    code_payload: options.collectionCodePayload,
    order_ttl_seconds: 300,
    amount_offset_maximum_cents: 99,
  }, audit("collection"));
  await settings.saveProvider({
    revision: 1,
    environment: "PRODUCTION",
    app_id: "2026000000000001",
    private_key: applicationPrivateKey,
    platform_public_key: platformPublicKey,
    timeout_milliseconds: 8_000,
    scan_interval_seconds: 10,
    maximum_success_age_seconds: 60,
  }, audit("provider"));
  settingsStore.saveApiSecret(options.apiSecret, 2, audit("api"));

  const orders = new OrderService(database, () => settings.snapshot());
  orders.initialize();
  return { config, database, identity, settingsStore, settings, orders };
}

function audit(suffix: string) {
  return {
    actorId: "admin",
    requestId: `http-fixture-${suffix}`,
    remoteAddressHash: "0".repeat(64),
  };
}
