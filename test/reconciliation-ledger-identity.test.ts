import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { adminLedgerEntryAccount } from "../src/http/admin-ledger-query.ts";
import { withHttpFixture, login, recordLedgerEntry, responseData } from "./reconciliation-http-fixture.ts";

const audit = { actorId: "admin" };
const timestamp = (value: number) => new Date(value + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

it("returns the ledger's own historical account generation in global and website confirmation details", async () => {
  await withHttpFixture(async fixture => {
    const accounts = fixture.services.settings.accountService()!;
    const receivingAccount = await accounts.create({ name: "流水实际收款账号", app_id: "2026110500000002" }, audit);
    const oldProviderKey = receivingAccount.provider_account_key!;
    const order = fixture.createOrder("separate-receiving-account", 1000);
    const entry = recordLedgerEntry(fixture.ledger,
      { start: timestamp(fixture.baseTime - 60_000), end: timestamp(fixture.baseTime + 60_000) },
      "identity-generation", order.payableAmountCents, fixture.baseTime + 1000, fixture.baseTime, "CREDIT", oldProviderKey);
    // Changing this account's current application must not orphan earlier evidence.
    await accounts.update(receivingAccount.id, {
      revision: receivingAccount.revision, name: receivingAccount.name, enabled: receivingAccount.enabled,
      code_payload: receivingAccount.code_payload, environment: "PRODUCTION", app_id: "2026110500000003",
    }, audit);
    assert.notEqual(accounts.get(receivingAccount.id).provider_account_key, oldProviderKey);
    const auth = await login(fixture.app);
    const request = (path: string) => fixture.app.request("/api/admin/v1" + path, { headers: { cookie: auth.cookie } });
    const orderDetail = await responseData<{ alipay_account_id: string; alipay_account_name: string }>(await request("/orders/" + order.orderId));
    assert.equal(orderDetail.alipay_account_id, "default");
    assert.notEqual(orderDetail.alipay_account_name, receivingAccount.name);
    for (const base of ["", "/sites/default"]) {
      const response = await request(`${base}/reconciliation/ledger-entries/${entry.ledgerEntryId}?order_id=${order.orderId}`);
      assert.equal(response.status, 200);
      const detail = await responseData<Record<string, unknown>>(response);
      assert.equal(detail.alipay_account_id, receivingAccount.id);
      assert.equal(detail.alipay_account_name, receivingAccount.name);
      assert.equal(detail.ledger_entry_id, entry.ledgerEntryId);
      assert.equal("provider_account_key" in detail, false);
      assert.equal("platform_public_key" in detail, false);
    }
  });
});

it("keeps historical ownership explicit for legacy, unmapped, and retained deleted-account data", () => {
  const connection = new DatabaseSync(":memory:");
  const database = { read: <T>(operation: (connection: DatabaseSync) => T) => operation(connection) };
  const unknownAccount = { alipay_account_id: null, alipay_account_name: null };
  try {
    connection.exec("CREATE TABLE ledger_entries(ledger_entry_id TEXT PRIMARY KEY, provider_account_key TEXT NOT NULL)");
    connection.prepare("INSERT INTO ledger_entries VALUES (?, ?)").run("legacy-entry", "legacy-provider");
    assert.deepEqual(adminLedgerEntryAccount(database, "legacy-entry"), unknownAccount);
    connection.exec(`
      CREATE TABLE alipay_accounts(account_id TEXT PRIMARY KEY, name TEXT NOT NULL, provider_account_key TEXT, deleted_at INTEGER);
      CREATE TABLE alipay_account_generations(provider_account_key TEXT PRIMARY KEY, account_id TEXT NOT NULL);
      INSERT INTO alipay_accounts VALUES ('current-account', '当前账号', 'current-provider', NULL);
      INSERT INTO alipay_account_generations VALUES ('current-provider', 'current-account');
      INSERT INTO alipay_accounts VALUES ('deleted-account', '保留的历史账号名', NULL, 1000);
      INSERT INTO alipay_account_generations VALUES ('old-provider', 'deleted-account');
      INSERT INTO ledger_entries VALUES ('historical-entry', 'old-provider');
    `);
    assert.deepEqual({ ...adminLedgerEntryAccount(database, "legacy-entry") }, unknownAccount);
    assert.deepEqual(adminLedgerEntryAccount(database, "missing-entry"), unknownAccount);
    assert.deepEqual({ ...adminLedgerEntryAccount(database, "historical-entry") }, {
      alipay_account_id: "deleted-account", alipay_account_name: "保留的历史账号名",
    });
  } finally { connection.close(); }
});
