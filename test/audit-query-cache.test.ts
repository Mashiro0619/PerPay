import assert from "node:assert/strict";
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it } from "node:test";
import { queryAuditEvents, queryAuditMetadata, readAuditPageQuery } from "../src/audit/query.ts";
import { AUDIT_TEST_NOW as now, auditQueryFixture } from "./audit-query-fixture.ts";

const DAY = 86_400_000;
function observe(connection: DatabaseSync) {
  const reads: Array<{ sql: string; values: SQLInputValue[] }> = [];
  const proxy = new Proxy(connection, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        return new Proxy(statement, { get(target, key) {
          if (key === "all") return (...values: SQLInputValue[]) => {
            reads.push({ sql, values });
            return target.all(...values);
          };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        } });
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { reads, database: { read<T>(operation: (db: DatabaseSync) => T) { return operation(proxy); } } };
}

describe("audit query bounds and metadata catalog", () => {
  it("uses time indexes and limits each source before merging a page", () => {
    const test = auditQueryFixture();
    try {
      test.core(); test.activity();
      const observed = observe(test.connection);
      const page = queryAuditEvents(observed.database, readAuditPageQuery(new URLSearchParams({ limit: "1" })), now);
      assert.equal(page.data[0]?.source, "core");
      const select = observed.reads.find(read => read.sql.startsWith("WITH core_rows"))!;
      assert.ok(select);
      assert.equal((select.sql.match(/ORDER BY occurred_at DESC, sequence DESC LIMIT \?/g) ?? []).length, 2);
      const plan = test.connection.prepare("EXPLAIN QUERY PLAN " + select.sql).all(...select.values).map(row => String(row.detail)).join("\n");
      assert.match(plan, /audit_events_time_idx/);
      assert.match(plan, /activity_events_time_idx/);
      assert.doesNotMatch(plan, /SCAN audit_records/);
    } finally { test.close(); }
  });

  it("only reads new sequences after initialization, keeping delayed history and current website names", () => {
    const test = auditQueryFixture();
    try {
      test.connection.exec("CREATE TABLE sites(client_id TEXT PRIMARY KEY, configuration TEXT NOT NULL, deleted_at INTEGER)");
      test.core({ occurredAt: now - 50 * DAY, context: { siteId: "retired", siteName: "历史名称" } });
      test.activity({ siteId: "live", siteName: "记录中的旧名称" });
      test.connection.prepare("INSERT INTO sites VALUES(?, ?, NULL)").run("live", JSON.stringify({ name: "当前名称" }));
      const observed = observe(test.connection);
      assert.deepEqual(queryAuditMetadata(observed.database, undefined, now).sites.map(site => site.site_name).sort(), ["历史名称", "当前名称"].sort());
      observed.reads.length = 0;
      queryAuditMetadata(observed.database, undefined, now + 1);
      assert.equal(observed.reads.some(read => read.sql.includes("sequence > ?")), false);
      const watermark = Number(test.connection.prepare("SELECT MAX(sequence) AS n FROM audit_events").get()!.n);
      test.core({ action: "legacy.delayed", occurredAt: now - 60 * DAY, context: { siteId: "delayed", siteName: "延迟导入网站" } });
      test.activity({ action: "expired.new", occurredAt: now - 31 * DAY, siteId: "expired" });
      test.connection.prepare("UPDATE sites SET configuration=?, deleted_at=? WHERE client_id='live'").run(JSON.stringify({ name: "改名且已删除" }), now);
      const updated = queryAuditMetadata(observed.database, undefined, now + 2);
      assert.ok(updated.actions.some(action => action.action === "legacy.delayed"));
      assert.equal(updated.actions.some(action => action.action === "expired.new"), false);
      assert.deepEqual(updated.sites.find(site => site.site_id === "live"), { site_id: "live", site_name: "改名且已删除", deleted: true });
      assert.ok(updated.sites.some(site => site.site_id === "delayed"));
      const coreDeltas = observed.reads.filter(read => read.sql.includes("sequence > ?") && read.sql.includes("FROM audit_events"));
      assert.equal(coreDeltas.length, 2);
      assert.ok(coreDeltas.every(read => read.values[0] === watermark));
    } finally { test.close(); }
  });

  it("uses the latest name deterministically for equal timestamps on cold and incremental reads", () => {
    const test = auditQueryFixture();
    try {
      test.core({ context: { siteId: "shop", siteName: "旧名称" } });
      queryAuditMetadata(test.database, undefined, now);
      test.core({ context: { siteId: "shop", siteName: "新名称" } });
      const incremental = queryAuditMetadata(test.database, undefined, now);
      assert.equal(incremental.sites[0]?.site_name, "新名称");
      test.connection.exec("BEGIN");
      assert.deepEqual(queryAuditMetadata(test.database, undefined, now).sites, incremental.sites);
      test.connection.exec("ROLLBACK");
    } finally { test.close(); }
  });

  it("expires activity-only choices, preserves permanent site history, and can move the clock backwards", () => {
    const test = auditQueryFixture();
    try {
      test.core({ occurredAt: now - 40 * DAY, context: { siteId: "shared", siteName: "永久名称" } });
      test.activity({ action: "temporary.only", occurredAt: now - 30 * DAY, siteId: "shared", siteName: "活动名称" });
      test.activity({ action: "temporary.site", occurredAt: now - 30 * DAY, siteId: "temporary", siteName: "短期网站" });
      assert.equal(queryAuditMetadata(test.database, undefined, now).sites.find(site => site.site_id === "shared")?.site_name, "活动名称");
      const expired = queryAuditMetadata(test.database, undefined, now + 1);
      assert.deepEqual(expired.sites, [{ site_id: "shared", site_name: "永久名称", deleted: true }]);
      assert.equal(expired.actions.some(action => action.action.startsWith("temporary.")), false);
      assert.equal(queryAuditMetadata(test.database, undefined, now).sites.length, 2);
      test.connection.prepare("DELETE FROM activity_events WHERE occurred_at < ?").run(now - 30 * DAY + 1);
      assert.deepEqual(queryAuditMetadata(test.database, undefined, now).sites, [{ site_id: "shared", site_name: "永久名称", deleted: true }]);
    } finally { test.close(); }
  });

  it("rechecks removed activity representatives and does not cache rolled-back or replaced sequences", () => {
    const test = auditQueryFixture();
    try {
      const older = test.activity({ action: "surviving.action", occurredAt: now - 100, siteId: "shop", siteName: "旧名称" });
      const latest = test.activity({ action: "surviving.action", siteId: "shop", siteName: "新名称" });
      test.activity({ action: "other.action", occurredAt: now + 1 });
      assert.equal(queryAuditMetadata(test.database, undefined, now).sites[0]?.site_name, "新名称");
      test.connection.prepare("DELETE FROM activity_events WHERE event_id=?").run(latest.eventId);
      assert.equal(queryAuditMetadata(test.database, undefined, now).sites[0]?.site_name, "旧名称");
      test.connection.exec("BEGIN");
      test.connection.prepare("UPDATE activity_events SET site_name='回滚名称' WHERE event_id=?").run(older.eventId);
      assert.equal(queryAuditMetadata(test.database, undefined, now).sites[0]?.site_name, "回滚名称");
      test.connection.exec("ROLLBACK");
      assert.equal(queryAuditMetadata(test.database, undefined, now).sites[0]?.site_name, "旧名称");
      test.connection.exec("DELETE FROM activity_events; DELETE FROM sqlite_sequence WHERE name='activity_events'");
      test.activity({ action: "restored.action", siteId: "restored", siteName: "恢复的数据" });
      const restored = queryAuditMetadata(test.database, undefined, now);
      assert.deepEqual(restored.actions.map(action => action.action), ["restored.action"]);
      assert.deepEqual(restored.sites.map(site => site.site_id), ["restored"]);
    } finally { test.close(); }
  });

  it("invalidates for external writes and never shares state across reopened connections", () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-audit-metadata-"));
    const path = join(directory, "audit.sqlite");
    const test = auditQueryFixture(undefined, path);
    let other: DatabaseSync | undefined;
    try {
      const event = test.activity({ action: "external.before", siteId: "old", siteName: "旧名称" });
      queryAuditMetadata(test.database, undefined, now);
      other = new DatabaseSync(path);
      other.prepare("UPDATE activity_events SET action='external.after', site_id='new', site_name='新名称' WHERE event_id=?").run(event.eventId);
      const updated = queryAuditMetadata(test.database, undefined, now);
      assert.deepEqual(updated.actions.map(action => action.action), ["external.after"]);
      assert.deepEqual(updated.sites.map(site => site.site_id), ["new"]);
      const reopened = { read<T>(operation: (db: DatabaseSync) => T) { return operation(other!); } };
      assert.deepEqual(queryAuditMetadata(reopened, undefined, now).sites, updated.sites);
    } finally {
      other?.close(); test.close(); rmSync(path); rmdirSync(directory);
    }
  });
});
