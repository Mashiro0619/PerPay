// SPDX-License-Identifier: MIT
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DemoError, validateSnapshot, validateClientId } from './perpay.mjs';

export class DemoStore {
  constructor(filename, origin, siteId, protocol = 'native') {
    if (!['native', 'epay_v1', 'epay_v2'].includes(protocol)) throw new Error('支付协议无效。');
    if (protocol === 'native') siteId = validateClientId(siteId);
    else if (!/^[1-9]\d{0,19}$/.test(siteId)) throw new Error('易支付 PID 无效。');
    this.protocol = protocol;
    this.origin = origin;
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;',
      'CREATE TABLE IF NOT EXISTS orders (merchant_order_no TEXT PRIMARY KEY, request_json TEXT NOT NULL, order_id TEXT UNIQUE, checkout_url TEXT, snapshot_json TEXT, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;',
      'CREATE TABLE IF NOT EXISTS received_events (event_id TEXT PRIMARY KEY, body_sha256 TEXT NOT NULL, merchant_order_no TEXT NOT NULL, event_type TEXT NOT NULL, order_version INTEGER NOT NULL, disposition TEXT NOT NULL, received_at INTEGER NOT NULL) STRICT;',
    ].join('\n'));
    try {
      this.transaction(() => {
        if (!this.db.prepare('PRAGMA table_info(orders)').all().some(column => column.name === 'checkout_url')) {
          this.db.exec('ALTER TABLE orders ADD COLUMN checkout_url TEXT');
        }
        const existing = this.db.prepare('SELECT value FROM meta WHERE name = ?').get('perpay_origin');
        // Keep the metadata key for older databases. Its value is the stable website identity.
        const website = this.db.prepare('SELECT value FROM meta WHERE name = ?').get('perpay_client_id');
        const savedProtocol = this.db.prepare('SELECT value FROM meta WHERE name = ?').get('payment_protocol');
        const historical = this.db.prepare('SELECT 1 FROM orders LIMIT 1').get();
        if ((existing && existing.value !== origin) || (website && website.value !== siteId) ||
            ((savedProtocol?.value ?? (existing ? 'native' : protocol)) !== protocol) || (!website && historical && siteId !== 'default')) {
          throw new Error('数据目录已绑定另一个 PerPay 实例或业务网站。请使用新的 DEMO_DATA_DIR，不要把旧业务单号发到另一个网站。');
        }
        this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('perpay_origin', origin);
        this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('perpay_client_id', siteId);
        this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('payment_protocol', protocol);
      });
    } catch (error) { this.db.close(); throw error; }
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
  saveCheckout(no, created) {
    const url = new URL(created.checkout_url);
    if (this.protocol === 'native' || !/^[1-9]\d{0,63}$/.test(created.order_id) ||
        url.origin !== this.origin || url.username || url.password || url.search || url.hash ||
        !/^\/checkout\/pct1_[A-Za-z0-9_-]{43}$/.test(url.pathname)) throw new DemoError(502, '创建响应的订单或收银台地址无效。');
    this.transaction(() => {
      const row = this.get(no);
      if (!row) throw new DemoError(404, '本地没有这个业务订单。');
      if (row.order_id && row.order_id !== created.order_id) throw new DemoError(409, '创建响应的订单 ID 与本地业务订单不一致。');
      this.db.prepare('UPDATE orders SET order_id = ?, checkout_url = ?, updated_at = ? WHERE merchant_order_no = ?')
        .run(created.order_id, url.href, Date.now(), no);
    });
  }
  apply(snapshot, source) { return this.transaction(() => this.applyInsideTransaction(snapshot, source)); }
  applyInsideTransaction(snapshot, source) {
    validateSnapshot(snapshot);
    if ((snapshot.payment_protocol ?? 'native') !== this.protocol) throw new DemoError(409, '订单协议与数据目录不一致。');
    const row = this.get(snapshot.merchant_order_no);
    if (!row) return 'ignored_unknown_order';
    if (row.request.amount_cents !== snapshot.requested_amount_cents || (row.order_id && row.order_id !== snapshot.order_id)) throw new DemoError(409, '订单 ID 或金额与本地业务订单不一致，未更新状态。');
    const previous = row.snapshot;
    if (this.protocol !== 'native') {
      if (row.checkout_url) snapshot = { ...snapshot, checkout_url: row.checkout_url, checkout_status: 'OPEN', expires_at: null };
      // Compatibility responses have no remote order version. Version this local projection.
      const payment = ['CONFIRMED', 'DISPUTED'].includes(previous?.payment_status) && snapshot.payment_status === 'UNPAID'
        ? 'DISPUTED' : snapshot.payment_status;
      const changed = previous && previous.payment_status !== payment;
      snapshot = { ...snapshot, payment_status: payment, version: previous ? previous.version + Number(changed) : 1 };
    }
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
