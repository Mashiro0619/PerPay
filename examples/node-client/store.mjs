// SPDX-License-Identifier: MIT
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DemoError, validateSnapshot } from './perpay.mjs';

export class DemoStore {
  constructor(filename, origin) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;',
      'CREATE TABLE IF NOT EXISTS orders (merchant_order_no TEXT PRIMARY KEY, request_json TEXT NOT NULL, order_id TEXT UNIQUE, snapshot_json TEXT, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;',
      'CREATE TABLE IF NOT EXISTS received_events (event_id TEXT PRIMARY KEY, body_sha256 TEXT NOT NULL, merchant_order_no TEXT NOT NULL, event_type TEXT NOT NULL, order_version INTEGER NOT NULL, disposition TEXT NOT NULL, received_at INTEGER NOT NULL) STRICT;',
    ].join('\n'));
    const existing = this.db.prepare('SELECT value FROM meta WHERE name = ?').get('perpay_origin');
    if (existing && existing.value !== origin) { this.db.close(); throw new Error('数据目录已绑定另一个 PerPay 实例。请使用新的 DEMO_DATA_DIR，不要把旧业务单号发到新实例。'); }
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('perpay_origin', origin);
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(no) {
    const row = this.db.prepare('SELECT * FROM orders WHERE merchant_order_no = ?').get(no);
    return row ? { ...row, request: JSON.parse(row.request_json), snapshot: row.snapshot_json ? JSON.parse(row.snapshot_json) : null } : null;
  }
  prepare(payload) {
    return this.transaction(() => {
      const existing = this.get(payload.merchant_order_no);
      const serialized = JSON.stringify(payload);
      if (existing && existing.request_json !== serialized) throw new DemoError(409, '同一业务单号的参数已固定。重试请用原订单；修改金额或商品时新建业务单号。');
      if (!existing) this.db.prepare('INSERT INTO orders (merchant_order_no, request_json, created_at, updated_at) VALUES (?, ?, ?, ?)').run(payload.merchant_order_no, serialized, Date.now(), Date.now());
      return this.get(payload.merchant_order_no);
    });
  }
  failure(no, message) {
    this.db.prepare('UPDATE orders SET last_error = ?, updated_at = ? WHERE merchant_order_no = ?').run(message.slice(0, 500), Date.now(), no);
  }
  apply(snapshot, source) { return this.transaction(() => this.applyInsideTransaction(snapshot, source)); }
  applyInsideTransaction(snapshot, source) {
    validateSnapshot(snapshot);
    const row = this.get(snapshot.merchant_order_no);
    if (!row) return 'ignored_unknown_order';
    if (row.request.amount_cents !== snapshot.requested_amount_cents || (row.order_id && row.order_id !== snapshot.order_id)) throw new DemoError(409, '订单 ID 或金额与本地业务订单不一致，未更新状态。');
    const previous = row.snapshot;
    if (previous && snapshot.version < previous.version) return 'ignored_older_version';
    if (previous && snapshot.version === previous.version && (snapshot.payment_status !== previous.payment_status || snapshot.refund_status !== previous.refund_status || snapshot.payable_amount_cents !== previous.payable_amount_cents || snapshot.received_amount_cents !== previous.received_amount_cents)) {
      throw new DemoError(409, '同一订单版本出现不一致的状态，未更新本地记录。');
    }
    const next = { ...previous, ...snapshot, source };
    this.db.prepare('UPDATE orders SET order_id = ?, snapshot_json = ?, last_error = NULL, updated_at = ? WHERE merchant_order_no = ?').run(snapshot.order_id, JSON.stringify(next), Date.now(), snapshot.merchant_order_no);
    return previous && snapshot.version === previous.version ? 'same_version' : 'updated';
  }
  receive(verified) {
    return this.transaction(() => {
      const { event, snapshot, digest } = verified;
      const existing = this.db.prepare('SELECT body_sha256 FROM received_events WHERE event_id = ?').get(event.event_id);
      if (existing) {
        if (existing.body_sha256 !== digest) throw new DemoError(409, '相同事件 ID 对应不同正文，拒绝确认。');
        return 'duplicate';
      }
      const disposition = this.applyInsideTransaction(snapshot, 'webhook');
      // Commit the event receipt and local projection together before returning ACK.
      // Production fulfillment belongs in this transaction or a transactional outbox.
      // This demo deliberately performs no shipping, balance credit or refund.
      this.db.prepare('INSERT INTO received_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(event.event_id, digest, snapshot.merchant_order_no, event.event_type, snapshot.version, disposition, Date.now());
      return disposition;
    });
  }
  list() {
    return this.db.prepare('SELECT merchant_order_no FROM orders ORDER BY created_at DESC LIMIT 30').all().map(({ merchant_order_no }) => {
      const row = this.get(merchant_order_no);
      return { merchant_order_no, product_name: row.request.product_name, amount_cents: row.request.amount_cents, note: row.request.note ?? '', notifications: Boolean(row.request.notify_url), snapshot: row.snapshot, last_error: row.last_error, updated_at: row.updated_at };
    });
  }
  events() { return this.db.prepare('SELECT event_id, merchant_order_no, event_type, order_version, disposition, received_at FROM received_events ORDER BY received_at DESC LIMIT 30').all(); }
  close() { this.db.close(); }
}
