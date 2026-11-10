import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { AlipayAccountService } from "../src/alipay-accounts/service.ts";
import { AlipayAccountStore } from "../src/alipay-accounts/store.ts";
import { AlipayAccountError } from "../src/alipay-accounts/model.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { keyMaster, privatePem, platformPem } from "./application-key-fixture.ts";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "perpay-account-creation-"));
  const path = join(directory, "state.sqlite3");
  let database = await AppDatabase.open(path);
  new RuntimeSettingsStore(database, keyMaster).initialize();
  const service = () => new AlipayAccountService({ store: new AlipayAccountStore(database, keyMaster) });
  return {
    get database() { return database; }, service,
    async reopen() { database.close(); database = await AppDatabase.open(path); },
    close() {
      database.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
const audit = { actorId: "admin" };

it("replays a committed account creation after runtime failure and restart without overwriting later edits", async () => {
  const f = await fixture();
  try {
    const input = { name: "收款账号", operation_id: randomUUID() };
    const failing = new AlipayAccountService({ store: new AlipayAccountStore(f.database, keyMaster), onApplied: () => { throw new Error("runtime response lost"); } });
    await assert.rejects(failing.create(input, audit), /runtime response lost/);
    assert.equal(f.service().list().length, 1);
    await f.reopen();
    const service = f.service();
    const [first, second] = await Promise.all([service.create(input, audit), service.create({ ...input, enabled: true, app_id: null }, audit)]);
    assert.equal(first.id, "alipay_" + input.operation_id);
    assert.equal(second.id, first.id);
    const current = await service.update(first.id, {
      revision: first.revision, name: "已修改名称", enabled: false, code_payload: null, app_id: null,
    }, audit);
    const replay = await service.create(input, audit);
    assert.equal(replay.name, current.name);
    assert.equal(replay.revision, current.revision);
    assert.equal(service.list().length, 1);
    assert.equal(f.database.read(db => Number(db.prepare("SELECT count(*) AS total FROM audit_events WHERE action='alipay_account.created'").get()!.total)), 1);
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});

it("binds a creation identity to its original fields without storing plaintext keys in the receipt", async () => {
  const f = await fixture();
  try {
    const service = f.service();
    const input = { operation_id: randomUUID(), name: "密钥账号", app_id: "creation-app", private_key: privatePem, platform_public_key: platformPem };
    const account = await service.create(input, audit);
    const conflict = (error: unknown) => error instanceof AlipayAccountError && error.code === "alipay_account_creation_conflict";
    await assert.rejects(service.create({ ...input, name: "其他名称" }, audit), conflict);
    await assert.rejects(service.create({ ...input, private_key: undefined }, audit), conflict);
    assert.equal((await service.create(input, audit)).id, account.id);
    const details = f.database.read(db => String(db.prepare("SELECT details_json FROM audit_events WHERE action='alipay_account.created' AND subject_id=?").get(account.id)!.details_json));
    assert.match(JSON.parse(details).creation_fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(!details.includes(privatePem) && !details.includes(platformPem));
    assert.equal(service.list().length, 1);
  } finally { f.close(); }
});

it("never recreates a deleted account when replaying its creation identity", async () => {
  const f = await fixture();
  try {
    const service = f.service();
    const input = { operation_id: randomUUID(), name: "已删除账号" };
    const account = await service.create(input, audit);
    await service.remove(account.id, { revision: account.revision }, audit);
    await f.reopen();
    await assert.rejects(f.service().create(input, audit), error => error instanceof AlipayAccountError && error.code === "alipay_account_not_found");
    assert.deepEqual(f.service().list(), []);
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});

it("commits the creation receipt atomically and retains legacy creation without operation IDs", async () => {
  const f = await fixture();
  try {
    const service = f.service();
    const input = { operation_id: randomUUID(), name: "回滚账号" };
    f.database.write(db => db.exec("CREATE TEMP TRIGGER reject_account_receipt BEFORE INSERT ON audit_events WHEN NEW.action='alipay_account.created' BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END"));
    await assert.rejects(service.create(input, audit), /injected receipt failure/);
    assert.equal(service.list().length, 0);
    f.database.write(db => db.exec("DROP TRIGGER reject_account_receipt"));
    assert.equal((await service.create(input, audit)).id, "alipay_" + input.operation_id);
    const legacyA = await service.create({ name: "旧客户端" }, audit);
    const legacyB = await service.create({ name: "旧客户端" }, audit);
    assert.notEqual(legacyA.id, legacyB.id);
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});
