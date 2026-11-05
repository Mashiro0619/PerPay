// SPDX-License-Identifier: MIT
/**
 * Isolated crash-recovery validation against the image's compiled domain code.
 *
 * For EACH scenario use fresh data, backup, secrets and validation-state volumes,
 * --network none, and mount this directory read-only at /validation.
 * /validation-state/isolation.json must contain:
 * {kind:"perpay-linux-upgrade-validation", run_id:"...",
 *  scenario:"...", data_dir:"/data", backup_dir:"/backups"}
 * Set PERPAY_UPGRADE_ISOLATED=1 and PERPAY_UPGRADE_RUN_ID to that run_id.
 *
 * node /validation/recovery-fixture.mjs prepare SCENARIO
 * node /validation/recovery-fixture.mjs crash SCENARIO
 * Wait for recovery_boundary_ready, then docker kill --signal KILL CONTAINER.
 * node /validation/recovery-fixture.mjs verify SCENARIO
 *
 * verify waits for the actual database/notification leases, never edits them.
 * Hooks exist only in this process; production files and SQL state are not patched.
 * Provider verification/income and the signed, durable receiver are synthetic.
 * Spool input comes from an actual deletion of our own verified backup copy.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadImageModules, seedBusinessData, recordLedgerIncome } from "./upgrade-fixture.mjs";

const SCENARIOS = ["payment-before-commit", "payment-after-commit", "webhook-before-ack-commit",
  "spool-before-import-commit", "spool-after-import-commit", "webhook-after-claim", "spool-after-publish"];
const [command, scenario] = process.argv.slice(2);
if (command === "--help") {
  console.log(JSON.stringify({ commands: ["prepare", "crash", "verify"], scenarios: SCENARIOS,
    contract: "See the header; each scenario requires independent volumes and an isolation marker." }, null, 2));
} else {
  main().catch(error => {
    // Avoid serializing domain inputs, keys, or arbitrary nested error objects.
    console.error(JSON.stringify({ event: "recovery_validation_failed", scenario, command,
      message: error instanceof Error ? error.message : "validation failed" }));
    process.exitCode = 1;
  });
}

function json(path) { return JSON.parse(fs.readFileSync(path, "utf8")); }
function privateJson(path, value, exclusive = false) {
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: exclusive ? "wx" : "w" });
  const fd = fs.openSync(path, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (process.platform !== "win32") {
    const directory = fs.openSync(dirname(path), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}
function emit(event, data = {}) {
  fs.writeSync(1, JSON.stringify({ event, scenario, execution_platform: process.platform, ...data }) + "\n");
}
function assertOrdinaryDirectory(path) {
  const stat = fs.lstatSync(path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Validation paths must be ordinary directories");
  assert.equal(fs.realpathSync(path), resolve(path), "Validation paths must not traverse symlinks");
}
function safeEnvironment() {
  assert.ok(["prepare", "crash", "verify"].includes(command), "Expected prepare, crash or verify");
  assert.ok(SCENARIOS.includes(scenario), "Unknown recovery scenario");
  assert.equal(process.env.PERPAY_UPGRADE_ISOLATED, "1", "Explicit recovery isolation is required");
  const runId = process.env.PERPAY_UPGRADE_RUN_ID;
  assert.match(runId ?? "", /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/, "Invalid isolated run ID");
  const stateDirectory = resolve(process.env.PERPAY_VALIDATION_STATE_DIR ?? "/validation-state");
  const dataDirectory = resolve(process.env.PERPAY_DATA_DIR ?? "/data");
  const backupDirectory = resolve(process.env.PERPAY_BACKUP_DIR ?? "/backups");
  const directories = [stateDirectory, dataDirectory, backupDirectory];
  for (const directory of directories) { assert.ok(isAbsolute(directory)); assertOrdinaryDirectory(directory); }
  for (const first of directories) for (const second of directories) {
    if (first !== second) assert.ok(!first.startsWith(second + sep), "Validation directories must be separate");
  }
  assert.equal(new Set(directories).size, 3, "Validation directories must be distinct");
  const marker = json(join(stateDirectory, "isolation.json"));
  assert.deepEqual({ kind: marker.kind, run_id: marker.run_id, scenario: marker.scenario,
    data_dir: resolve(marker.data_dir), backup_dir: resolve(marker.backup_dir) }, {
    kind: "perpay-linux-upgrade-validation", run_id: runId, scenario,
    data_dir: dataDirectory, backup_dir: backupDirectory,
  }, "Isolation marker must identify these exact recovery volumes");
  return { runId, stateDirectory, dataDirectory, backupDirectory,
    environment: { ...process.env, PERPAY_DATA_DIR: dataDirectory, PERPAY_BACKUP_DIR: backupDirectory,
      PERPAY_PUBLIC_URL: "http://127.0.0.1:6190" } };
}

async function main() {
  const context = safeEnvironment();
  const dist = resolve(process.env.PERPAY_VALIDATION_DIST_DIR ?? "/app/dist");
  const modules = await loadImageModules(dist);
  Object.assign(modules, await import(pathToFileURL(join(dist, "audit/activity.js")).href),
    await import(pathToFileURL(join(dist, "audit/spool.js")).href),
    await import(pathToFileURL(join(dist, "notifications/model.js")).href),
    await import(pathToFileURL(join(dist, "database/maintenance.js")).href));
  const config = modules.loadConfig(context.environment);
  assert.equal(config.dataDir, context.dataDirectory);
  assert.equal(config.backupDir, context.backupDirectory);
  const statePath = join(context.stateDirectory, "recovery-state.json");
  if (command === "prepare") {
    assert.ok(!fs.existsSync(statePath), "Recovery state already exists; use fresh scenario volumes");
    assert.ok(!fs.existsSync(config.databasePath), "Recovery prepare requires a fresh database");
    await prepare({ ...context, modules, config, statePath });
    return;
  }
  const state = json(statePath);
  assert.equal(state.runId, context.runId); assert.equal(state.scenario, scenario);
  assert.equal(state.applicationVersion, modules.APP_VERSION, "Recovery must use the prepared image version");
  const args = { ...context, modules, config, state, statePath };
  if (command === "crash") {
    assert.ok(!fs.existsSync(join(context.stateDirectory, "boundary.json")), "Boundary already reached; do not reuse a crash volume");
    await crash(args);
    throw new Error("Crash scenario returned without reaching its boundary");
  }
  const boundary = json(join(context.stateDirectory, "boundary.json"));
  assert.equal(boundary.scenario, scenario); assert.equal(boundary.runId, context.runId);
  await verify({ ...args, boundary });
}

function coreFacts(database) {
  return database.read(db => db.prepare("SELECT event_id, event_hash FROM audit_events ORDER BY sequence").all()
    .map(row => ({ event_id: row.event_id, event_hash: row.event_hash })));
}
function assertCorePrefix(database, before) {
  const after = coreFacts(database);
  assert.ok(before.length > 0, "Core-audit baseline must not be vacuous");
  assert.deepEqual(after.slice(0, before.length), before, "Previously committed audit IDs/hashes changed");
}
function paymentEvidence(database, state) {
  return database.read(db => ({
    order: db.prepare("SELECT order_id, payment_status, payment_basis, received_amount_cents, version FROM payment_orders WHERE order_id=?").get(state.orderId),
    ledger: db.prepare("SELECT ledger_entry_id, state, amount_cents FROM ledger_entries WHERE ledger_entry_id=?").get(state.ledgerEntryId),
    matches: db.prepare("SELECT payment_match_id, order_id, ledger_entry_id, status FROM payment_matches WHERE order_id=?").all(state.orderId),
    operations: db.prepare("SELECT financial_operation_id, operation_type, order_id, ledger_entry_id FROM financial_operations WHERE order_id=?").all(state.orderId),
    outbox: db.prepare("SELECT outbox_event_id, event_type, aggregate_id, payload_fingerprint FROM outbox_events WHERE aggregate_id=?").all(state.orderId),
    audit: db.prepare("SELECT event_id, action, subject_id FROM audit_events WHERE action='financial.auto_settlement' AND json_extract(details_json,'$.order_id')=?").all(state.orderId),
  }));
}
function serializable(value) { return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? Number(item) : item)); }
function assertConfirmed(evidence, state) {
  assert.equal(evidence.order.order_id, state.orderId); assert.equal(evidence.order.payment_status, "CONFIRMED");
  assert.equal(evidence.ledger.ledger_entry_id, state.ledgerEntryId); assert.equal(evidence.ledger.state, "ALLOCATED");
  assert.equal(Number(evidence.order.received_amount_cents), Number(evidence.ledger.amount_cents));
  for (const key of ["matches", "operations", "outbox", "audit"]) assert.equal(evidence[key].length, 1, `Exactly one ${key} fact is required`);
  assert.equal(evidence.matches[0].status, "SETTLED"); assert.equal(evidence.matches[0].ledger_entry_id, state.ledgerEntryId);
  assert.equal(evidence.operations[0].operation_type, "AUTO_SETTLEMENT");
  assert.equal(evidence.audit[0].subject_id, evidence.operations[0].financial_operation_id);
  assert.equal(evidence.outbox[0].event_type, "PAYMENT_CONFIRMED");
}
function boundary(args, details) {
  const evidence = { event: "recovery_boundary_ready", runId: args.runId, scenario,
    reachedAt: Date.now(), execution_platform: process.platform, ...serializable(details) };
  privateJson(join(args.stateDirectory, "boundary.json"), evidence, true);
  emit("recovery_boundary_ready", evidence);
  // Synchronous blocking preserves the exact transaction or filesystem boundary.
  // The host must kill this process/container; no cleanup or graceful close runs.
  const flag = new Int32Array(new SharedArrayBuffer(4));
  while (true) Atomics.wait(flag, 0, 0, 2_147_483_647);
}
async function openAfterCrash(args) {
  const started = Date.now();
  for (;;) {
    try { return await args.modules.AppDatabase.open(args.config.databasePath, { masterKey: args.config.masterKey }); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "another process already owns the database lease" || Date.now() - started > 45_000) throw error;
      await delay(500);
    }
  }
}
function restoredServices(args, database) {
  const { modules, config } = args;
  const settingsStore = new modules.RuntimeSettingsStore(database, config.masterKey);
  const settings = new modules.RuntimeSettingsService({ store: settingsStore });
  settings.initialize();
  return { settings, sites: settingsStore.siteStore(), webhooks: new modules.WebhookStore(database),
    reconciliation: new modules.ReconciliationStore(database) };
}

async function prepare(args) {
  const { modules, config } = args;
  const database = await modules.AppDatabase.open(config.databasePath, { masterKey: config.masterKey });
  const state = { runId: args.runId, scenario, applicationVersion: modules.APP_VERSION, preparedAt: Date.now() };
  try {
    if (scenario.startsWith("spool-")) {
      const settings = new modules.RuntimeSettingsStore(database, config.masterKey);
      settings.initialize();
      const identity = new modules.IdentityService(database);
      await identity.initialize();
      await identity.setupAdmin(randomBytes(32).toString("base64url"), { requestId: "recovery-spool-setup" });
      state.quarantineName = `perpay.sqlite3.before-restore-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
      const backup = await database.backupDetailed(join(config.dataDir, state.quarantineName));
      state.quarantineSha256 = backup.sha256;
    } else {
      const seeded = await seedBusinessData({ modules, database, config, prefix: "linux-recovery" });
      state.accountId = seeded.accountId; state.siteId = seeded.siteId;
      if (scenario.startsWith("payment-")) {
        const order = seeded.services.orders.forSite(seeded.siteId).create(modules.createOrderRequestSchema.parse({
          idempotency_key: randomUUID(), merchant_order_no: "recovery-" + randomUUID(), amount_cents: 78123,
          product_name: "Isolated interrupted settlement", notify_url: seeded.services.sites.get(seeded.siteId).configuration.notification_origin + "/notify",
        })).order;
        state.orderId = order.orderId;
        const occurredAt = Math.ceil(Math.max(Date.now() + 1000, order.createdAt + 1000) / 1000) * 1000;
        const { entry } = recordLedgerIncome(seeded.services.ledger, { providerAccountKey: seeded.providerAccountKey,
          amountCents: order.payableAmountCents, occurredAt, observedAt: occurredAt + 5 });
        state.ledgerEntryId = entry.ledgerEntryId;
        state.financialNow = occurredAt + 10;
        state.baseline = serializable(paymentEvidence(database, state));
        assert.equal(state.baseline.order.payment_status, "UNPAID");
        assert.equal(state.baseline.ledger.state, "UNALLOCATED");
        for (const key of ["matches", "operations", "outbox", "audit"]) assert.equal(state.baseline[key].length, 0);
      } else {
        const pending = database.read(db => db.prepare("SELECT delivery_id FROM webhook_deliveries WHERE status='PENDING' ORDER BY created_at,delivery_id").all());
        assert.equal(pending.length, 1, "Notification seed must have exactly one pending delivery");
        const detail = seeded.services.webhooks.delivery(pending[0].delivery_id);
        state.orderId = detail.event.orderId; state.deliveryId = detail.delivery.deliveryId;
        state.eventId = detail.event.eventId; state.payloadFingerprint = detail.event.payloadFingerprint;
        state.baseline = webhookEvidence(detail);
      }
    }
    state.coreBaseline = coreFacts(database);
    assert.ok(state.coreBaseline.length > 0);
    assert.equal(database.integrityCheck().ok, true);
  } finally { database.close(); }
  if (scenario.startsWith("spool-") && scenario !== "spool-after-publish") {
    await deleteOwnQuarantine(args, state);
    Object.assign(state, spoolEvent(args, state));
  }
  privateJson(args.statePath, state, true);
  emit("recovery_prepared", { application_version: state.applicationVersion, order_id: state.orderId,
    ledger_entry_id: state.ledgerEntryId, delivery_id: state.deliveryId, event_id: state.eventId,
    core_audit_baseline_count: state.coreBaseline.length });
}

async function deleteOwnQuarantine(args, state) {
  assert.equal(basename(state.quarantineName), state.quarantineName);
  await args.modules.runMaintenanceCommand(["delete-pre-restore-quarantine", state.quarantineName,
    state.quarantineSha256, "--confirm-delete-pre-restore-quarantine"], args.environment);
  assert.equal(fs.existsSync(join(args.config.dataDir, state.quarantineName)), false);
}
function spoolEvent(args, state) {
  const root = args.modules.activitySpoolPath(args.config.backupDir);
  const events = fs.readdirSync(root).flatMap(source => fs.readdirSync(join(root, source))
    .filter(file => /^event-\d{12}-[a-f0-9-]{36}\.json$/.test(file)).map(file => ({ path: join(root, source, file), value: json(join(root, source, file)) })))
    .filter(({ value }) => value.activity.action === "maintenance.quarantine.delete" && value.activity.subjectId === state.quarantineName);
  assert.equal(events.length, 1, "Real maintenance deletion must publish exactly one event");
  const { path, value } = events[0];
  assert.equal(value.permanent, true); assert.equal(value.activity.outcome, "SUCCESS");
  return { eventId: value.eventId, sourceId: value.sourceId, sourceSequence: value.sequence,
    spoolPath: path, spoolSha256: createHash("sha256").update(fs.readFileSync(path)).digest("hex") };
}

function webhookEvidence(detail) {
  assert.ok(detail, "Original delivery disappeared");
  return { deliveryId: detail.delivery.deliveryId, eventId: detail.event.eventId,
    payloadFingerprint: detail.event.payloadFingerprint, generation: detail.delivery.generation,
    status: detail.delivery.status, attemptCount: detail.delivery.attemptCount,
    attempts: detail.attempts.map(attempt => ({ id: attempt.attemptId, number: attempt.attemptNumber,
      outcome: attempt.outcome, errorCode: attempt.errorCode, bodyFingerprint: attempt.requestBodyFingerprint })) };
}
function receiver(args, sites, webhooks) {
  const path = join(args.stateDirectory, "receiver-observations.json");
  return { post: async input => {
    const h = input.headers, detail = webhooks.delivery(h["x-perpay-webhook-delivery-id"]);
    assert.equal(detail.event.eventId, args.state.eventId); assert.equal(detail.delivery.deliveryId, args.state.deliveryId);
    assert.equal(detail.target.targetUrl, input.targetUrl);
    const signature = args.modules.webhookSignature({ secret: sites.notificationSecret(detail.target.apiClientId),
      keyId: h["x-perpay-webhook-key-id"], timestamp: Number(h["x-perpay-webhook-timestamp"]),
      deliveryId: detail.delivery.deliveryId, eventId: detail.event.eventId,
      attemptNumber: Number(h["x-perpay-webhook-attempt"]), body: input.body });
    assert.ok(h["x-perpay-webhook-signature"] === signature, "Synthetic receiver rejected request signature");
    const observations = fs.existsSync(path) ? json(path) : [];
    observations.push({ deliveryId: detail.delivery.deliveryId, eventId: detail.event.eventId,
      attemptNumber: Number(h["x-perpay-webhook-attempt"]), signatureVerified: true,
      businessEffectApplied: !observations.some(item => item.eventId === detail.event.eventId) });
    privateJson(path, observations);
    const body = Buffer.from(JSON.stringify({ schema: "perpay:webhook-ack:v1", ack: true,
      event_id: detail.event.eventId, delivery_id: detail.delivery.deliveryId }));
    return { status: 200, contentType: "application/json", contentEncoding: null, body,
      responseFingerprint: createHash("sha256").update(body).digest("hex"),
      resolvedAddressesFingerprint: "a".repeat(64), connectedAddress: "192.0.2.10" };
  } };
}

async function crash(args) {
  if (scenario === "spool-after-publish") {
    let published = null, ready = false;
    const rename = fs.renameSync, fsync = fs.fsyncSync;
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (String(to).startsWith(args.modules.activitySpoolPath(args.config.backupDir) + sep) && /^event-/.test(basename(String(to)))) published = String(to);
    };
    fs.fsyncSync = fd => {
      fsync(fd);
      if (!ready && published && fs.fstatSync(fd).isDirectory()) {
        ready = true;
        const event = spoolEvent(args, args.state);
        boundary(args, { stage: "event_file_and_directory_synced_before_source_metadata", ...event });
      }
    };
    syncBuiltinESMExports();
    await deleteOwnQuarantine(args, args.state);
    throw new Error("Durable spool publication hook was not reached (requires Linux directory fsync)");
  }
  const database = await args.modules.AppDatabase.open(args.config.databasePath, { masterKey: args.config.masterKey });
  try {
    if (scenario.startsWith("payment-")) {
      const realWrite = database.write.bind(database);
      database.write = operation => {
        const result = realWrite(connection => {
          const value = operation(connection);
          if (scenario === "payment-before-commit" && value?.kind === "auto_settled") boundary(args, { stage: "reconciliation_mutations_complete_transaction_uncommitted", result: value });
          return value;
        });
        if (scenario === "payment-after-commit" && result?.kind === "auto_settled") boundary(args, { stage: "reconciliation_commit_complete_before_caller_receives_result", result,
          committed: paymentEvidence(database, args.state) });
        return result;
      };
      new args.modules.ReconciliationStore(database).reconcileEntry(args.state.ledgerEntryId, Math.max(Date.now(), args.state.financialNow));
    } else if (scenario.startsWith("webhook-")) {
      const services = restoredServices(args, database), { webhooks, sites } = services;
      const nextAttempt = database.read(db => Number(db.prepare("SELECT next_attempt_at FROM webhook_deliveries WHERE delivery_id=?").get(args.state.deliveryId).next_attempt_at));
      assert.ok(nextAttempt - Date.now() < 10_000, "Prepared notification is not due soon");
      if (Date.now() < nextAttempt) await delay(nextAttempt - Date.now() + 1);
      if (scenario === "webhook-after-claim") {
        const claim = webhooks.claimNext.bind(webhooks);
        webhooks.claimNext = input => { const result = claim(input); if (result) boundary(args, { stage: "claim_committed_before_transport", delivery: webhookEvidence(webhooks.delivery(args.state.deliveryId)) }); return result; };
      } else {
        webhooks.completeAttempt = input => {
          assert.equal(input.outcome, "ACKNOWLEDGED");
          boundary(args, { stage: "receiver_persisted_and_ack_validated_before_completion_write", delivery: webhookEvidence(webhooks.delivery(args.state.deliveryId)) });
        };
      }
      await new args.modules.SiteWebhookProcessor({ sites, webhooks,
        transport: () => receiver(args, sites, webhooks) }).processOne();
    } else {
      const realWrite = database.write.bind(database);
      const imported = connection => !!connection.prepare("SELECT event_id FROM activity_external_receipts WHERE event_id=?").get(args.state.eventId);
      database.write = operation => {
        const result = realWrite(connection => {
          const value = operation(connection);
          if (scenario === "spool-before-import-commit" && imported(connection)) boundary(args, { stage: "receipt_activity_core_and_cursor_written_transaction_uncommitted", eventId: args.state.eventId });
          return value;
        });
        if (scenario === "spool-after-import-commit" && database.read(imported)) boundary(args, { stage: "receipt_activity_core_and_cursor_commit_complete", eventId: args.state.eventId });
        return result;
      };
      const recorder = new args.modules.ActivityRecorder({ database });
      await new args.modules.ActivitySpoolImporter({ database, recorder, backupDirectory: args.config.backupDir }).poll();
    }
  } finally { database.close(); }
}

function spoolEvidence(database, state) {
  return database.read(db => ({
    receipt: db.prepare("SELECT event_id,source_id,source_sequence,core_event_id FROM activity_external_receipts WHERE event_id=?").all(state.eventId),
    core: db.prepare("SELECT event_id,action,subject_id FROM audit_events WHERE json_extract(details_json,'$.external_event_id')=?").all(state.eventId),
    activity: db.prepare("SELECT event_id,external_event_id FROM activity_events WHERE external_event_id=?").all(state.eventId),
    cursor: db.prepare("SELECT source_id,last_sequence,gap_count FROM activity_import_sources WHERE source_id=?").get(state.sourceId),
  }));
}
async function verify(args) {
  const database = await openAfterCrash(args);
  let evidence;
  try {
    assertCorePrefix(database, args.state.coreBaseline);
    if (scenario.startsWith("payment-")) {
      const before = paymentEvidence(database, args.state);
      if (scenario === "payment-before-commit") assert.deepEqual(serializable(before), args.state.baseline, "Interrupted transaction leaked partial payment facts");
      else { assertConfirmed(before, args.state); assert.deepEqual(serializable(before), args.boundary.committed); }
      const reconciliation = new args.modules.ReconciliationStore(database);
      const first = reconciliation.reconcileEntry(args.state.ledgerEntryId, Math.max(Date.now(), args.state.financialNow));
      assert.equal(first.kind, scenario === "payment-before-commit" ? "auto_settled" : "allocated");
      const after = paymentEvidence(database, args.state); assertConfirmed(after, args.state);
      for (let retry = 0; retry < 3; retry++) assert.equal(reconciliation.reconcileEntry(args.state.ledgerEntryId).kind, "allocated");
      assert.deepEqual(paymentEvidence(database, args.state), after, "Reconciliation replay duplicated payment or audit facts");
      evidence = { before, after, restart_result: first.kind, repeated_reconciliation_count: 3 };
    } else if (scenario.startsWith("webhook-")) {
      const { sites, webhooks } = restoredServices(args, database);
      const before = webhookEvidence(webhooks.delivery(args.state.deliveryId));
      assert.equal(before.status, "LEASED"); assert.equal(before.attemptCount, 1);
      assert.equal(before.attempts[0].outcome, "STARTED");
      assert.deepEqual(before, args.boundary.delivery, "Persisted claim identity changed across restart");
      const receiverPath = join(args.stateDirectory, "receiver-observations.json");
      const initial = fs.existsSync(receiverPath) ? json(receiverPath) : [];
      assert.equal(initial.length, scenario === "webhook-after-claim" ? 0 : 1);
      const leaseExpires = database.read(db => Number(db.prepare("SELECT lease_expires_at FROM webhook_deliveries WHERE delivery_id=?").get(args.state.deliveryId).lease_expires_at));
      if (Date.now() <= leaseExpires) await delay(leaseExpires - Date.now() + 1);
      const result = await new args.modules.SiteWebhookProcessor({ sites, webhooks,
        transport: () => receiver(args, sites, webhooks) }).processOne();
      assert.equal(result.outcome, "ACKNOWLEDGED");
      const after = webhookEvidence(webhooks.delivery(args.state.deliveryId));
      assert.equal(after.status, "ACKNOWLEDGED"); assert.equal(after.eventId, args.state.eventId);
      assert.equal(after.deliveryId, args.state.deliveryId); assert.equal(after.generation, args.state.baseline.generation);
      assert.equal(after.payloadFingerprint, args.state.payloadFingerprint);
      assert.equal(after.attempts.length, 2); assert.equal(after.attempts[0].id, before.attempts[0].id);
      assert.deepEqual(after.attempts.map(attempt => attempt.outcome), ["OUTCOME_UNKNOWN", "ACKNOWLEDGED"]);
      assert.equal(after.attempts[0].errorCode, "lease_expired_outcome_unknown");
      const observations = json(receiverPath);
      assert.equal(observations.length, initial.length + 1);
      assert.ok(observations.every(item => item.eventId === args.state.eventId && item.deliveryId === args.state.deliveryId && item.signatureVerified));
      assert.equal(observations.filter(item => item.businessEffectApplied).length, 1);
      const count = database.read(db => Number(db.prepare("SELECT COUNT(*) AS total FROM webhook_deliveries WHERE outbox_event_id=?").get(args.state.eventId).total));
      assert.equal(count, 1);
      assert.equal((await new args.modules.SiteWebhookProcessor({ sites, webhooks, transport: () => receiver(args, sites, webhooks) }).processOne()).processed, false);
      evidence = { before, after, receiver_observations: observations, delivery_count: count };
    } else {
      const state = { ...args.state, ...(scenario === "spool-after-publish" ? args.boundary : {}) };
      assert.equal(fs.existsSync(join(args.config.dataDir, state.quarantineName)), false, "Maintenance deletion did not complete");
      assert.deepEqual(spoolEvent(args, state), { eventId: state.eventId, sourceId: state.sourceId, sourceSequence: state.sourceSequence,
        spoolPath: state.spoolPath, spoolSha256: state.spoolSha256 }, "Published immutable spool file changed");
      const before = spoolEvidence(database, state);
      const committed = scenario === "spool-after-import-commit";
      for (const key of ["receipt", "core", "activity"]) assert.equal(before[key].length, committed ? 1 : 0, `Unexpected pre-recovery ${key} count`);
      const recorder = new args.modules.ActivityRecorder({ database });
      const importer = new args.modules.ActivitySpoolImporter({ database, recorder, backupDirectory: args.config.backupDir });
      await importer.poll(); await importer.poll(); await importer.stop();
      // A fresh importer must also preserve deduplication after process-local cursors reset.
      const restarted = new args.modules.ActivitySpoolImporter({ database, recorder, backupDirectory: args.config.backupDir });
      await restarted.poll(); await restarted.stop();
      const after = spoolEvidence(database, state);
      for (const key of ["receipt", "core", "activity"]) assert.equal(after[key].length, 1, `Spool ${key} was lost or duplicated`);
      assert.equal(after.receipt[0].core_event_id, after.core[0].event_id);
      assert.equal(after.core[0].action, "maintenance.quarantine.delete"); assert.equal(after.core[0].subject_id, state.quarantineName);
      assert.equal(Number(after.cursor.last_sequence), state.sourceSequence); assert.equal(Number(after.cursor.gap_count), 0);
      if (committed) assert.deepEqual(after, before, "Committed import changed during replay");
      if (scenario === "spool-after-publish") {
        assert.equal(recorder.status().state, "degraded");
        assert.equal(recorder.status().lastErrorCode, "activity_spool_metadata_missing", "Unknown publisher tail must remain visible");
      } else assert.equal(recorder.status().state, "healthy");
      evidence = { before, after, capture: recorder.status(), spool_sha256: state.spoolSha256 };
      recorder.stop();
    }
    assertCorePrefix(database, args.state.coreBaseline);
    const integrity = database.integrityCheck(); assert.equal(integrity.ok, true);
    const result = serializable({ event: "recovery_verified", scenario, run_id: args.runId,
      execution_platform: process.platform, application_version: args.modules.APP_VERSION,
      boundary: args.boundary.stage, boundary_reached_at: args.boundary.reachedAt,
      preserved_core_audit_count: args.state.coreBaseline.length, integrity, ...evidence,
      limits: "Domain services and persistence are real; provider and signed receiver are synthetic. Process kill is not power-loss or real Alipay/DNS/TLS acceptance." });
    privateJson(join(args.stateDirectory, "result.json"), result);
    emit("recovery_verified", result);
  } finally { database.close(); }
}
