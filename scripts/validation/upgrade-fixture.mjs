// SPDX-License-Identifier: MIT
/**
 * Run inside isolated RC1/candidate images with --network none and /app/dist.
 * Required: PERPAY_UPGRADE_ISOLATED=1, PERPAY_UPGRADE_RUN_ID, synthetic original
 * PERPAY_MASTER_KEY, and ordinary /data, /backups, /run/perpay-secrets volumes.
 * /validation-state/isolation.json must match kind, run_id, data_dir and backup_dir.
 *
 * seed [--storage-history]              Actual RC1/schema 38 services and optional large history.
 * verify --schema=<image maximum> --checkpoint=base|upgraded [--label=lowercase-label]
 * advance                               Candidate/schema 40 or later; separate checkpoint.
 * http-verify --checkpoint=base|upgraded  Running main, loopback :6190 only.
 * summary                               Secret-free base snapshot.
 *
 * Run strict verify before starting normal workers: retries and ingest runs may
 * legitimately change their rows afterwards. HTTP checks original credentials,
 * capabilities and replay identity; an open checkout may be unavailable because
 * the external provider is deliberately unreachable. Private fixture files stay
 * on the isolated state volume; stdout and snapshots contain no secret material.
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const KIND = "perpay-linux-upgrade-validation";
const TABLES = ["admin_identity", "alipay_accounts", "alipay_account_generations", "alipay_account_secrets",
  "sites", "site_secrets", "api_client_config", "api_client_keys", "webhook_signing_keys", "collection_profiles",
  "payment_orders", "checkout_sessions", "checkout_token_keys", "order_events", "provider_account_bindings",
  "ingest_runs", "provider_raw_pages", "provider_raw_events", "ledger_entries", "financial_operations",
  "payment_matches", "match_candidates", "financial_exceptions", "ledger_transactions", "ledger_postings",
  "outbox_events", "webhook_targets", "webhook_deliveries", "webhook_attempts"];
const EPAY_TABLES = ["epay_sites", "epay_credentials", "epay_orders"];

function requireCondition(condition, code) { if (!condition) throw new Error(code); }
function canonical(value) {
  if (typeof value === "bigint") return { integer: value.toString() };
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString("hex") };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function digest(value) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function sameSecret(left, right) {
  return typeof left === "string" && typeof right === "string" && timingSafeEqual(
    createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}
function quote(value) { return '"' + value.replaceAll('"', '""') + '"'; }
function providerTime(value) { return new Date(value + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " "); }

export function growObservationHistory({ modules: m, database, providerAccountKey, count = 90_000 }) {
  requireCondition(Number.isSafeInteger(count) && count >= 1 && count <= 100_000, "invalid_observation_history_count");
  const ledger = new m.LedgerStore(database), now = Date.now();
  database.write(db => db.exec("CREATE INDEX validation_observation_seed_order ON ingest_run_page_observations(raw_page_id, observation_sequence DESC)"));
  try {
    for (let offset = 0; offset < count; offset += 100) {
      const attempts = Math.min(100, count - offset);
      const end = now;
      const run = ledger.startIngestRun({ providerAccountKey, start: providerTime(end - 60_000), end: providerTime(end), pageSize: 1, now });
      const segment = ledger.getNextPendingSegment(run.ingestRunId);
      ledger.recordSegmentPage({ ingestRunId: run.ingestRunId, ingestSegmentId: segment.ingestSegmentId,
        page: { pageNo: 1, pageSize: 1, totalSize: 2, hasMore: true, details: [{
          raw: { synthetic_probe: true }, accountLogId: "storage-probe", occurredAt: providerTime(end),
          amount: "1.00", direction: "CREDIT", alipayOrderNo: null, merchantOrderNo: null, transMemo: null, otherAccount: null,
        }] },
        evidence: { httpStatus: 200, headers: {}, body: "[]", traceId: "storage-history", signatureVerified: true }, now: now + 1 });
      // Keep every production constraint and trigger active. Short per-run batches
      // share one request history that the complete integrity scan must sort.
      if (attempts > 1) database.write(db => {
        const original = db.prepare("SELECT observation_sequence FROM ingest_run_page_observations WHERE ingest_run_id = ?").get(run.ingestRunId);
        db.prepare(`WITH RECURSIVE attempts(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM attempts WHERE value < ?
        ) INSERT INTO ingest_run_page_observations (
          ingest_run_id, ingest_segment_id, raw_page_id, observation_attempt, observation_kind,
          http_status, headers_json, trace_id, signature_verified, observed_at,
          disposition, observation_sequence, transition_enforced
        ) SELECT original.ingest_run_id, original.ingest_segment_id, original.raw_page_id,
          original.observation_attempt + attempts.value, original.observation_kind,
          original.http_status, original.headers_json, original.trace_id, original.signature_verified,
          original.observed_at, original.disposition, original.observation_sequence + attempts.value, original.transition_enforced
          FROM ingest_run_page_observations original CROSS JOIN attempts
          WHERE original.observation_sequence = ? ORDER BY attempts.value`).run(attempts - 1, original.observation_sequence);
        db.prepare("UPDATE ingest_runs SET pages_received = pages_received + ? WHERE ingest_run_id = ?").run(attempts - 1, run.ingestRunId);
      });
      let pending;
      while ((pending = ledger.getNextPendingSegment(run.ingestRunId))) {
        ledger.recordSegmentPage({ ingestRunId: run.ingestRunId, ingestSegmentId: pending.ingestSegmentId,
          page: { pageNo: 1, pageSize: 1, totalSize: 0, hasMore: false, details: [] },
          evidence: { httpStatus: 200, headers: {}, body: "[]", traceId: "storage-history", signatureVerified: true }, now: now + 2 });
      }
    }
  } finally {
    database.write(db => db.exec("DROP INDEX validation_observation_seed_order"));
  }
  requireCondition(database.read(db => !db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'validation_observation_seed_order'").get()), "seeding_index_retained");
  requireCondition(database.integrityCheck().ok, "historical_observations_integrity_failed");
  return database.read(captureObservationHistory);
}

function captureObservationHistory(db, maximum = Number.MAX_SAFE_INTEGER) {
  const hash = createHash("sha256");
  let count = 0;
  for (const row of db.prepare("SELECT * FROM ingest_run_page_observations WHERE observation_sequence <= ? ORDER BY observation_sequence").iterate(maximum)) {
    hash.update(JSON.stringify(canonical(row)) + "\n");
    count++;
  }
  return { count, sha256: hash.digest("hex") };
}

/** Recovery scenarios may import these helpers; importing this file performs no I/O. */
export async function loadImageModules(distDirectory = "/app/dist", extension = ".js") {
  requireCondition([".js", ".ts"].includes(extension), "invalid_module_extension");
  const names = ["config", "database/database", "database/audit-chain", "identity/service", "identity/crypto",
    "settings/store", "settings/service", "settings/model", "alipay-accounts/service", "orders/service", "orders/model",
    "ledger/store", "reconciliation/store", "notifications/store", "notifications/site-processor", "security/api-signature", "version"];
  return Object.assign({}, ...await Promise.all(names.map(name => import(pathToFileURL(join(distDirectory, name + extension)).href))));
}

/** The only synthetic ledger boundary is the provider page and its verification result. */
export function recordLedgerIncome(ledger, { providerAccountKey, amountCents, occurredAt, observedAt = occurredAt + 1_000,
  externalEventId = "validation-" + randomUUID() }) {
  const amount = (amountCents / 100).toFixed(2), occurred = providerTime(occurredAt);
  const run = ledger.startIngestRun({ providerAccountKey, start: providerTime(occurredAt - 60_000),
    end: providerTime(occurredAt + 60_000), pageSize: 1, now: observedAt });
  const result = ledger.recordPage({ ingestRunId: run.ingestRunId,
    page: { pageNo: 1, pageSize: 1, totalSize: 1, hasMore: false, details: [{
      raw: { account_log_id: externalEventId, amount, direction: "CREDIT", occurred_at: occurred },
      accountLogId: externalEventId, occurredAt: occurred, amount, direction: "CREDIT",
      alipayOrderNo: "platform-" + externalEventId, merchantOrderNo: null, transMemo: null, otherAccount: null,
    }] }, evidence: { httpStatus: 200, headers: { "alipay-request-id": externalEventId },
      body: JSON.stringify({ synthetic_provider_page: true, externalEventId, amount }), traceId: externalEventId, signatureVerified: true }, now: observedAt + 1 });
  const normalized = result.normalized[0];
  requireCondition(normalized?.kind === "created", "synthetic_income_not_ingested");
  ledger.completeIngestRun({ ingestRunId: run.ingestRunId, now: observedAt + 2 });
  return { entry: normalized.entry, ingestRunId: run.ingestRunId };
}

/** All business facts below are written through the running image's own services. */
export async function seedBusinessData({ modules: m, database, config, prefix = "linux-upgrade", clock = Date.now }) {
  requireCondition(/^[a-z0-9-]{1,32}$/.test(prefix), "invalid_seed_prefix");
  const identity = new m.IdentityService(database, clock);
  await identity.initialize();
  requireCondition(!identity.isInitialized(), "refusing_initialized_database");
  const adminPassword = randomBytes(32).toString("base64url");
  await identity.setupAdmin(adminPassword, { requestId: prefix + "-setup", sourceAddress: "127.0.0.1", userAgent: "isolated-upgrade-validation" });
  const settingsStore = new m.RuntimeSettingsStore(database, config.masterKey);
  const settings = new m.RuntimeSettingsService({ store: settingsStore, verifyProviderApplicationKey: async () => undefined });
  settings.initialize();
  const platformPublicKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "pem", type: "spki" }).toString();
  const platformFingerprint = m.publicKeyFingerprint(m.parsePlatformPublicKey(platformPublicKey).publicKey);
  const accounts = new m.AlipayAccountService({ store: settingsStore.accountStore(), verifyProviderApplicationKey: async provider => {
    requireCondition(provider.appId === "2026110500990100", "unexpected_synthetic_app_id");
    requireCondition(provider.platformKeyFingerprint === platformFingerprint, "unexpected_synthetic_platform_key");
  } });
  const audit = { actorId: "admin", requestId: prefix + "-seed", remoteAddressHash: "0".repeat(64) };
  let account = await accounts.create({ name: "隔离升级收款账号", enabled: true, environment: "PRODUCTION", app_id: null, code_payload: null }, audit);
  account = await accounts.generateApplicationKey(account.id, { revision: account.revision }, audit);
  account = await accounts.update(account.id, { revision: account.revision, name: account.name, enabled: true, environment: "PRODUCTION",
    app_id: "2026110500990100", code_payload: "https://qr.alipay.com/isolated-linux-upgrade", platform_public_key: platformPublicKey }, audit);
  requireCondition((await accounts.check(account.id)).ok, "synthetic_account_check_failed");
  const sites = settingsStore.siteStore();
  requireCondition(sites !== null, "site_schema_unavailable");
  const policy = sites.defaults().policy;
  let site = sites.create({ operation_id: randomUUID(), configuration: { name: "隔离升级业务网站", accepting_orders: true,
    notifications_enabled: false, notification_origin: "https://linux-validation.example.com", return_origin: null,
    collection: { mode: "FIXED", accounts: [{ account_id: account.id, weight: 1 }] },
    policy: { ...policy, orders: { ...policy.orders, order_ttl_seconds: 1800 } } } }, audit);
  const apiRotation = sites.rotateSecret(site.clientId, "api_secret", site.revision, audit); site = apiRotation.site;
  const notificationRotation = sites.rotateSecret(site.clientId, "webhook_secret", site.revision, audit); site = notificationRotation.site;
  site = sites.update(site.clientId, { revision: site.revision, configuration: { ...site.configuration, notifications_enabled: true } }, audit);
  const orders = new m.OrderService(database, () => settings.instanceSnapshot(), clock, sites, site.clientId,
    { accounts: () => accounts.store().snapshots(), available: id => id === account.id && accounts.get(id).configured });
  orders.initialize();
  const requests = {
    paid: m.createOrderRequestSchema.parse({ idempotency_key: prefix + "-paid", merchant_order_no: prefix + "-paid", amount_cents: 1234,
      product_name: "升级前已确认订单", notify_url: "https://linux-validation.example.com/notify" }),
    open: m.createOrderRequestSchema.parse({ idempotency_key: prefix + "-open", merchant_order_no: prefix + "-open", amount_cents: 5678,
      product_name: "升级前待付款订单" }),
  };
  const paid = orders.create(requests.paid).order, open = orders.create(requests.open).order;
  const ledger = new m.LedgerStore(database), reconciliation = new m.ReconciliationStore(database), webhooks = new m.WebhookStore(database);
  const occurredAt = Math.ceil(Math.max(clock(), paid.createdAt + 1_000) / 1_000) * 1_000;
  const observedAt = occurredAt + 1_000;
  const { entry, ingestRunId } = recordLedgerIncome(ledger, { providerAccountKey: account.provider_account_key, amountCents: paid.payableAmountCents,
    occurredAt, observedAt, externalEventId: prefix + "-income" });
  const settled = reconciliation.reconcileEntry(entry.ledgerEntryId, observedAt + 3);
  requireCondition(settled.kind === "auto_settled" && settled.orderId === paid.orderId, "seed_real_reconciliation_failed");
  requireCondition(webhooks.materialize(100, observedAt + 4, site.clientId) === 1, "seed_notification_not_materialized");
  const delivery = webhooks.listDeliveriesForOrder({ orderId: paid.orderId, limit: 20 }).deliveries[0];
  requireCondition(delivery?.delivery.status === "PENDING" && delivery.attempts.length === 0, "seed_notification_not_pending");
  const fixture = { format: 1, version: m.APP_VERSION, instanceId: database.instanceId(), accountId: account.id,
    siteId: site.clientId, providerAccountKey: account.provider_account_key, adminPassword,
    apiSecret: apiRotation.secret, webhookSecret: notificationRotation.secret,
    applicationKeyFingerprint: account.application_key_fingerprint,
    orders: { paid: { orderId: paid.orderId, checkoutToken: paid.checkoutToken, request: requests.paid },
      open: { orderId: open.orderId, checkoutToken: open.checkoutToken, request: requests.open } },
    ledgerEntryId: entry.ledgerEntryId, paymentMatchId: settled.paymentMatchId, candidateId: settled.candidateId,
    ingestRunId, deliveryId: delivery.delivery.deliveryId, eventId: delivery.event.eventId,
  };
  return { services: { identity, settingsStore, settings, accounts, sites, orders, ledger, reconciliation, webhooks },
    accountId: account.id, siteId: site.clientId, providerAccountKey: account.provider_account_key, fixture };
}

/** Hash complete rows, including ciphertext and original column types, but never export their contents. */
export function captureSnapshot(database, fixture, imageVersion) {
  return database.read(db => {
    const schemaVersion = Number(db.prepare("SELECT MAX(version) AS value FROM schema_migrations").get().value);
    const tables = {};
    for (const table of [...TABLES, ...(schemaVersion >= 41 ? EPAY_TABLES : [])]) {
      const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all();
      requireCondition(columns.length > 0, "snapshot_table_missing:" + table);
      const primary = columns.filter(column => Number(column.pk) > 0).sort((left, right) => Number(left.pk) - Number(right.pk)).map(column => String(column.name));
      requireCondition(primary.length > 0, "snapshot_primary_key_missing:" + table);
      const names = columns.map(column => String(column.name));
      const rows = db.prepare(`SELECT * FROM ${quote(table)}`).all().map(row => ({ key: primary.map(name => row[name]), digest: digest(row) }));
      rows.sort((left, right) => JSON.stringify(canonical(left.key)).localeCompare(JSON.stringify(canonical(right.key))));
      tables[table] = { columns: names, primary, rows: canonical(rows) };
    }
    const audit = db.prepare("SELECT * FROM audit_events ORDER BY sequence").all().map(row => ({
      sequence: Number(row.sequence), eventId: String(row.event_id), eventHash: String(row.event_hash), previousHash: row.previous_hash, digest: digest(row) }));
    return { format: 1, imageVersion, schemaVersion,
      instanceId: database.instanceId(), accountId: fixture.accountId, siteId: fixture.siteId,
      orders: Object.fromEntries(Object.entries(fixture.orders).map(([kind, order]) => [kind, { orderId: order.orderId, checkoutTokenFingerprint: digest(order.checkoutToken) }])),
      credentialFingerprints: { api: digest(fixture.apiSecret), notification: digest(fixture.webhookSecret), application: fixture.applicationKeyFingerprint },
      ledgerEntryId: fixture.ledgerEntryId, paymentMatchId: fixture.paymentMatchId, deliveryId: fixture.deliveryId, eventId: fixture.eventId,
       tables, audit, observationHistory: captureObservationHistory(db), externalSimulation: ["Alipay application verification", "Alipay statement page and signature-verification result"],
    };
  });
}

export async function verifyBusinessData({ modules: m, database, config, fixture, baseline, expectedSchema }) {
  requireCondition(baseline.audit.length > 0 && baseline.tables.payment_orders.rows.length >= 2 &&
    baseline.tables.ledger_entries.rows.length > 0 && baseline.tables.financial_operations.rows.length > 0 &&
    baseline.tables.outbox_events.rows.length > 0, "baseline_business_evidence_empty");
  requireCondition(database.instanceId() === baseline.instanceId && fixture.instanceId === baseline.instanceId, "instance_identity_changed");
  requireCondition(database.integrityCheck().ok, "database_integrity_failed");
  const preservedRows = database.read(db => {
    if (baseline.observationHistory !== undefined) {
      requireCondition(digest(captureObservationHistory(db, baseline.observationHistory.count)) === digest(baseline.observationHistory), "historical_observations_changed");
    }
    requireCondition(Number(db.prepare("SELECT MAX(version) AS value FROM schema_migrations").get().value) === expectedSchema, "unexpected_verified_schema");
    let checked = 0;
    for (const [table, saved] of Object.entries(baseline.tables)) {
      requireCondition(TABLES.includes(table) || EPAY_TABLES.includes(table), "unknown_snapshot_table");
      const actual = new Map(db.prepare(`SELECT ${saved.columns.map(quote).join(",")} FROM ${quote(table)}`).all()
        .map(row => [JSON.stringify(canonical(saved.primary.map(name => row[name]))), digest(row)]));
      for (const row of saved.rows) { requireCondition(actual.get(JSON.stringify(row.key)) === row.digest, "preserved_row_changed:" + table); checked++; }
    }
    const audit = db.prepare("SELECT * FROM audit_events WHERE sequence <= ? ORDER BY sequence").all(baseline.audit.at(-1)?.sequence ?? 0);
    requireCondition(audit.length === baseline.audit.length, "historical_audit_count_changed");
    for (let index = 0; index < audit.length; index++) {
      const saved = baseline.audit[index], row = audit[index];
      requireCondition(row.event_id === saved.eventId && row.event_hash === saved.eventHash && row.previous_hash === saved.previousHash && digest(row) === saved.digest,
        "historical_audit_bytes_changed");
    }
    requireCondition(m.inspectAuditChain(db).violations === 0, "audit_chain_integrity_failed");
    if (expectedSchema >= 41) {
      requireCondition(!db.prepare("SELECT 1 FROM sites LEFT JOIN epay_sites ON epay_sites.site_id = sites.client_id WHERE epay_sites.pid IS NULL LIMIT 1").get(), "epay_site_identity_missing");
      if (baseline.schemaVersion < 41) {
        requireCondition(!db.prepare("SELECT 1 FROM epay_sites WHERE v1_enabled != 0 OR v2_enabled != 0 LIMIT 1").get(), "epay_migration_enabled_protocol");
        requireCondition(Number(db.prepare("SELECT COUNT(*) AS count FROM epay_credentials").get().count) === 0, "epay_migration_created_credentials");
      }
    }
    if (expectedSchema >= 42 && baseline.schemaVersion < 42) {
      for (const saved of baseline.tables.webhook_attempts.rows) {
        const row = db.prepare("SELECT protocol, epay_key_id, request_method, request_url, request_fingerprint FROM webhook_attempts WHERE attempt_id = ?").get(saved.key[0]);
        requireCondition(row?.protocol === "native" && row.epay_key_id === null && row.request_method === "POST" && row.request_url === null && row.request_fingerprint === null,
          "historical_notification_protocol_changed");
      }
    }
    return checked;
  });
  const settingsStore = new m.RuntimeSettingsStore(database, config.masterKey); settingsStore.initialize();
  const settings = new m.RuntimeSettingsService({ store: settingsStore, verifyProviderApplicationKey: async () => { throw new Error("verification_must_not_contact_provider"); } });
  const sites = settingsStore.siteStore(), accounts = settingsStore.accountStore(); accounts.verifySecrets();
  const account = accounts.snapshot(fixture.accountId);
  requireCondition(account.applicationKey?.fingerprint === fixture.applicationKeyFingerprint, "application_key_identity_changed");
  requireCondition(sameSecret(sites.credential(fixture.siteId)?.secret, fixture.apiSecret), "original_api_credential_unusable");
  requireCondition(sameSecret(sites.notificationSecret(fixture.siteId), fixture.webhookSecret), "original_notification_credential_unusable");
  const passwordHash = database.read(db => String(db.prepare("SELECT password_hash FROM admin_identity WHERE singleton_key=1").get().password_hash));
  requireCondition(await m.verifyPassword(fixture.adminPassword, passwordHash), "original_admin_password_unusable");
  const orders = new m.OrderService(database, () => settings.instanceSnapshot(), undefined, sites, fixture.siteId, { accounts: () => accounts.snapshots() });
  for (const order of Object.values(fixture.orders)) requireCondition(sameSecret(orders.adminCheckoutToken(order.orderId), order.checkoutToken), "original_checkout_capability_changed");
  const payment = database.read(db => db.prepare("SELECT payment_status,payment_basis FROM payment_orders WHERE order_id=?").get(fixture.orders.paid.orderId));
  requireCondition(payment.payment_status === "CONFIRMED" && payment.payment_basis === "INFERRED", "confirmed_payment_changed");
  const delivery = new m.WebhookStore(database).delivery(fixture.deliveryId);
  requireCondition(delivery?.delivery.status === "PENDING" && delivery.attempts.length === 0 && delivery.event.eventId === fixture.eventId, "pending_notification_changed");
  return { ok: true, imageVersion: m.APP_VERSION, schemaVersion: expectedSchema, instanceId: baseline.instanceId,
    preservedRows, historicalAuditEvents: baseline.audit.length, historicalAuditHead: baseline.audit.at(-1)?.eventHash ?? null,
    originalAdminPasswordVerified: true, originalCredentialsVerified: true, originalCheckoutTokensVerified: true,
    paidOrderId: fixture.orders.paid.orderId, openOrderId: fixture.orders.open.orderId, pendingDeliveryId: fixture.deliveryId,
    networkUsed: false, verifiedAt: new Date().toISOString() };
}

export async function advanceBusinessData({ modules: m, database, config, fixture }) {
  requireCondition(m.DATABASE_COMPATIBILITY.maximum >= 40, "advance_requires_candidate_schema");
  const settingsStore = new m.RuntimeSettingsStore(database, config.masterKey); settingsStore.initialize();
  const settings = new m.RuntimeSettingsService({ store: settingsStore, verifyProviderApplicationKey: async () => { throw new Error("no_external_verification"); } });
  const sites = settingsStore.siteStore(), accounts = settingsStore.accountStore();
  const orders = new m.OrderService(database, () => settings.instanceSnapshot(), undefined, sites, fixture.siteId,
    { accounts: () => accounts.snapshots(), available: id => id === fixture.accountId && accounts.view(id).configured });
  const request = m.createOrderRequestSchema.parse({ idempotency_key: "linux-upgrade-after-migration", merchant_order_no: "linux-upgrade-after-migration",
    amount_cents: 9012, product_name: "升级后新增业务事实", notify_url: "https://linux-validation.example.com/notify" });
  const created = orders.create(request);
  requireCondition(created.created, "advance_order_already_exists");
  const occurredAt = Math.ceil(Math.max(Date.now(), created.order.createdAt + 1_000) / 1_000) * 1_000, observedAt = occurredAt + 1_000;
  const { entry } = recordLedgerIncome(new m.LedgerStore(database), { providerAccountKey: fixture.providerAccountKey,
    amountCents: created.order.payableAmountCents, occurredAt, observedAt, externalEventId: "linux-upgrade-new-income" });
  const result = new m.ReconciliationStore(database).reconcileEntry(entry.ledgerEntryId, observedAt + 3);
  requireCondition(result.kind === "auto_settled" && result.orderId === created.order.orderId, "advance_reconciliation_failed");
  new m.WebhookStore(database).materialize(100, observedAt + 4, fixture.siteId);
  return { ...fixture, orders: { ...fixture.orders, upgraded: { orderId: created.order.orderId, checkoutToken: created.order.checkoutToken, request } },
    upgradedLedgerEntryId: entry.ledgerEntryId, upgradedPaymentMatchId: result.paymentMatchId };
}

/** The only network permitted by this mode is the running container's loopback HTTP listener. */
export async function verifyHttpIdentity({ modules: m, config, fixture, request = fetch }) {
  const publicUrl = new URL(config.publicOrigin);
  requireCondition(publicUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname) && publicUrl.port === "6190", "http_probe_requires_loopback_origin");
  const base = "http://127.0.0.1:6190";
  const send = (path, options = {}) => request(base + path, { redirect: "error", signal: AbortSignal.timeout(15_000), ...options });
  const login = await send("/api/admin/v1/session/login", { method: "POST", headers: { origin: config.publicOrigin, "content-type": "application/json" }, body: JSON.stringify({ password: fixture.adminPassword }) });
  requireCondition(login.status === 200, "original_admin_http_login_failed");
  const cookie = login.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
  const account = await send("/api/admin/v1/alipay-accounts/" + fixture.accountId, { headers: { cookie } });
  requireCondition(account.status === 200, "original_account_http_read_failed");
  const accountValue = (await account.json()).data;
  requireCondition(accountValue.id === fixture.accountId && accountValue.application_key_fingerprint === fixture.applicationKeyFingerprint, "http_account_identity_changed");
  const checked = [];
  for (const [kind, order] of Object.entries(fixture.orders)) {
    const redirect = await request(base + "/api/admin/v1/orders/" + order.orderId + "/checkout", { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    requireCondition(redirect.status === 302 && sameSecret(redirect.headers.get("location"), "/checkout/" + encodeURIComponent(order.checkoutToken)), "original_checkout_redirect_changed");
    const checkout = await send("/api/public/v1/checkouts/" + encodeURIComponent(order.checkoutToken));
    const checkoutValue = await checkout.json();
    if (kind === "open" && checkout.status === 503) {
      requireCondition(checkoutValue.error?.code === "reconciliation_not_ready", "open_checkout_unexpected_rejection");
    } else {
      requireCondition(checkout.status === 200 && checkoutValue.data?.merchant_order_no === order.request.merchant_order_no, "original_checkout_token_not_consumed");
      if (kind !== "open") requireCondition(checkoutValue.data.payment.status === "CONFIRMED", "http_confirmed_payment_changed");
    }
    const body = Buffer.from(JSON.stringify(order.request));
    const signed = m.signApiRequest({ secret: Buffer.from(fixture.apiSecret, "base64url"), method: "POST", target: "/api/v1/orders", body,
      clientId: fixture.siteId, timestamp: String(Math.floor(Date.now() / 1000)), nonce: m.createApiRequestNonce() });
    const replay = await send("/api/v1/orders", { method: "POST", headers: { "content-type": "application/json",
      "x-perpay-signature-version": signed.version, "x-perpay-client-id": signed.clientId, "x-perpay-timestamp": signed.timestamp,
      "x-perpay-nonce": signed.nonce, "x-perpay-signature": signed.signature }, body });
    requireCondition(replay.status === 200 && (await replay.json()).data?.order_id === order.orderId, "original_idempotent_http_request_not_replayed");
    checked.push({ kind, orderId: order.orderId, checkoutHttpStatus: checkout.status, originalCapabilityMatched: true, idempotentReplayStatus: replay.status });
  }
  return { ok: true, mode: "http-verify", imageVersion: m.APP_VERSION, administratorLoginVerified: true, originalAccountIdentityVerified: true,
    orders: checked, networkScope: "container-loopback-only", externalAlipayUnavailableByDesign: true };
}

export function assertIsolation(environment = process.env, platform = process.platform) {
  requireCondition(platform === "linux", "linux_container_required");
  requireCondition(environment.PERPAY_UPGRADE_ISOLATED === "1", "explicit_isolation_required");
  const runId = environment.PERPAY_UPGRADE_RUN_ID;
  requireCondition(typeof runId === "string" && /^[a-z0-9][a-z0-9-]{7,79}$/.test(runId), "unique_run_id_required");
  requireCondition(environment.PERPAY_DATA_DIR === "/data" && environment.PERPAY_BACKUP_DIR === "/backups" &&
    environment.PERPAY_SECRETS_DIR === "/run/perpay-secrets", "isolated_volume_paths_required");
  for (const path of ["/data", "/backups", "/run/perpay-secrets", "/validation-state"]) {
    const stat = lstatSync(path);
    requireCondition(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === path, "ordinary_isolated_directory_required");
  }
  const markerPath = "/validation-state/isolation.json", stat = lstatSync(markerPath);
  requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096, "invalid_isolation_marker");
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  requireCondition(marker.kind === KIND && marker.run_id === runId && marker.data_dir === "/data" && marker.backup_dir === "/backups", "isolation_marker_mismatch");
  return { runId, stateDirectory: "/validation-state" };
}

function readState(path) {
  const stat = lstatSync(path);
  requireCondition(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.size < 8 * 1024 * 1024, "private_fixture_state_required");
  return JSON.parse(readFileSync(path, "utf8"));
}

export async function runUpgradeFixture(arguments_ = process.argv.slice(2), environment = process.env) {
  const isolation = assertIsolation(environment); process.umask(0o077);
  const [mode, ...flags] = arguments_;
  requireCondition(["seed", "verify", "advance", "http-verify", "summary"].includes(mode), "invalid_upgrade_mode");
  const checkpointFlag = flags.find(value => /^--checkpoint=(base|upgraded)$/.test(value));
  const checkpoint = checkpointFlag?.slice("--checkpoint=".length) ?? "base";
  const suffix = checkpoint === "base" ? "" : "-upgraded";
  const privatePath = join(isolation.stateDirectory, "private-fixture" + suffix + ".json"), snapshotPath = join(isolation.stateDirectory, "snapshot" + suffix + ".json");
  if (mode === "summary") { requireCondition(flags.length === 0, "unexpected_summary_options"); return readState(snapshotPath); }
  const m = await loadImageModules();
  const schemaFlag = flags.find(value => /^--schema=[1-9][0-9]{0,5}$/.test(value)), labelFlag = flags.find(value => /^--label=[a-z0-9-]{1,40}$/.test(value));
  const expectedSchema = schemaFlag ? Number(schemaFlag.slice("--schema=".length)) : m.DATABASE_COMPATIBILITY.maximum;
  if (mode === "verify") {
    requireCondition((flags.length === 2 || flags.length === 3 && labelFlag) && schemaFlag && checkpointFlag, "verify_requires_schema_and_checkpoint");
    requireCondition(m.DATABASE_COMPATIBILITY.maximum === expectedSchema, "verification_image_schema_mismatch");
  }
  if (mode === "advance") requireCondition(flags.length === 0 && m.DATABASE_COMPATIBILITY.maximum >= 40, "advance_requires_candidate_schema");
  if (mode === "http-verify") requireCondition(flags.length === 1 && checkpointFlag, "http_verify_requires_checkpoint");
  const config = m.loadConfig(environment);
  requireCondition(config.databasePath === "/data/perpay.sqlite3", "unexpected_database_path");
  if (mode === "seed") {
    requireCondition((flags.length === 0 || flags.length === 1 && flags[0] === "--storage-history") && m.APP_VERSION === "1.0.0-rc.1" && m.DATABASE_COMPATIBILITY.maximum === 38, "seed_requires_actual_rc1_image");
    requireCondition(!existsSync(config.databasePath) && !existsSync(privatePath) && !existsSync(snapshotPath), "refusing_existing_fixture_data");
  } else {
    requireCondition(existsSync(config.databasePath), "verification_requires_existing_database");
  }
  const fixture = mode === "seed" ? null : readState(privatePath), baseline = mode === "seed" ? null : readState(snapshotPath);
  if (fixture) requireCondition(fixture.runId === isolation.runId && baseline.runId === isolation.runId, "snapshot_run_id_mismatch");
  if (mode === "http-verify") return verifyHttpIdentity({ modules: m, config, fixture });
  const openedAt = performance.now();
  const database = await m.AppDatabase.open(config.databasePath, { masterKey: config.masterKey });
  const openMilliseconds = Math.round(performance.now() - openedAt);
  try {
    if (mode === "seed") {
      const seeded = await seedBusinessData({ modules: m, database, config });
      if (flags.includes("--storage-history")) growObservationHistory({ modules: m, database, providerAccountKey: seeded.providerAccountKey });
      const snapshot = captureSnapshot(database, seeded.fixture, m.APP_VERSION);
      requireCondition(snapshot.schemaVersion === 38, "seed_schema_is_not_38");
      writeFileSync(privatePath, JSON.stringify({ runId: isolation.runId, ...seeded.fixture }) + "\n", { mode: 0o600, flag: "wx" });
      writeFileSync(snapshotPath, JSON.stringify({ runId: isolation.runId, ...snapshot }) + "\n", { mode: 0o600, flag: "wx" });
      return { ok: true, mode, runId: isolation.runId, imageVersion: m.APP_VERSION, schemaVersion: snapshot.schemaVersion,
        instanceId: snapshot.instanceId, accountId: snapshot.accountId, siteId: snapshot.siteId,
        orders: snapshot.orders, historicalAuditEvents: snapshot.audit.length, historicalAuditHead: snapshot.audit.at(-1)?.eventHash ?? null,
        notificationStatus: "PENDING", observationHistory: snapshot.observationHistory,
        databaseBytes: statSync(config.databasePath).size, maxRssKiB: process.resourceUsage().maxRSS, networkUsed: false };
    }
    if (mode === "advance") {
      const upgradedPrivatePath = join(isolation.stateDirectory, "private-fixture-upgraded.json"), upgradedSnapshotPath = join(isolation.stateDirectory, "snapshot-upgraded.json");
      requireCondition(!existsSync(upgradedPrivatePath) && !existsSync(upgradedSnapshotPath), "upgraded_checkpoint_already_exists");
      await verifyBusinessData({ modules: m, database, config, fixture, baseline, expectedSchema: m.DATABASE_COMPATIBILITY.maximum });
      const advanced = await advanceBusinessData({ modules: m, database, config, fixture });
      const snapshot = captureSnapshot(database, advanced, m.APP_VERSION);
      writeFileSync(upgradedPrivatePath, JSON.stringify(advanced) + "\n", { mode: 0o600, flag: "wx" });
      writeFileSync(upgradedSnapshotPath, JSON.stringify({ runId: isolation.runId, ...snapshot }) + "\n", { mode: 0o600, flag: "wx" });
      return { ok: true, mode, runId: isolation.runId, imageVersion: m.APP_VERSION, schemaVersion: snapshot.schemaVersion,
        newOrderId: advanced.orders.upgraded.orderId, newLedgerEntryId: advanced.upgradedLedgerEntryId,
        newPaymentMatchId: advanced.upgradedPaymentMatchId, historicalAuditEvents: snapshot.audit.length, historicalAuditHead: snapshot.audit.at(-1)?.eventHash ?? null,
        checkpoint: "upgraded", networkUsed: false };
    }
    const result = await verifyBusinessData({ modules: m, database, config, fixture, baseline, expectedSchema });
    const label = labelFlag?.slice("--label=".length) ?? expectedSchema + "-" + checkpoint;
    writeFileSync(join(isolation.stateDirectory, "verify-" + label + ".json"), JSON.stringify(result) + "\n", { mode: 0o600 });
    return { ...result, openMilliseconds, databaseBytes: statSync(config.databasePath).size,
      observationHistory: baseline.observationHistory, maxRssKiB: process.resourceUsage().maxRSS };
  } finally { database.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await runUpgradeFixture()) + "\n"); }
  catch (error) {
    // Never print assertion values, credential-bearing rows, config input, or stack locals.
    const reason = error instanceof Error && /database or disk is full/.test(error.message) ? "sqlite_storage_full"
      : error instanceof Error && /^[a-z0-9_:]+$/.test(error.message) ? error.message : "inspect_isolated_fixture_privately";
    process.stderr.write(JSON.stringify({ ok: false, error: "isolated_upgrade_validation_failed", reason }) + "\n");
    process.exitCode = 1;
  }
}
