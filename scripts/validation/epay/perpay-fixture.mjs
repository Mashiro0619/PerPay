// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createApp } from '../../../src/http/app.ts';
import { LedgerStore } from '../../../src/ledger/store.ts';
import { ReconciliationStore } from '../../../src/reconciliation/store.ts';
import { WebhookStore } from '../../../src/notifications/store.ts';
import { SiteWebhookProcessor } from '../../../src/notifications/site-processor.ts';
import { NodeWebhookTransport } from '../../../src/notifications/transport.ts';
import { createSitePaymentFixture } from '../../../test/site-payment-fixture.ts';
import { recordLedgerEntry } from '../../../test/reconciliation-http-fixture.ts';

export async function createPerPayInteropFixture(newApiPort) {
  const f = await createSitePaymentFixture();
  const audit = { actorId: 'admin' };
  const epay = f.settings.epayStore();
  let site = f.createSite('New API 隔离商户');
  const generated = f.sites.rotateSecret(site.clientId, 'webhook_secret', site.revision, audit);
  site = f.sites.update(site.clientId, { revision: generated.site.revision, configuration: {
    ...generated.site.configuration, notifications_enabled: true,
    notification_origin: 'https://shop.example', return_origin: 'https://shop.example',
  } }, audit);
  const configuration = epay.update(site.clientId, { revision: 0, v1_enabled: true, v2_enabled: true }, audit);
  const credentials = epay.credential(configuration.pid);
  const health = () => ({ enabled: true, state: 'healthy', inFlight: false, lastAttemptAt: f.now(), lastSuccessAt: f.now(), lastErrorCode: null, consecutiveFailures: 0 });
  const app = createApp({ ...f, config: { ...f.config, publicOrigin: 'https://pay.example' }, startedAt: new Date(f.now()), clock: f.now,
    ledgerHealth: health, reconciliationHealth: () => ({ ...health(), pendingOrders: 0, continuationPending: false }) });
  const ledger = new LedgerStore(f.database);
  const reconciliation = new ReconciliationStore(f.database);
  const delivered = [];
  const transport = new NodeWebhookTransport('https://shop.example', {
    startHostnameResolution: () => ({ result: Promise.resolve([{ address: '8.8.8.8', family: 4 }]), cancel() {} }),
    request(options, callback) {
      delivered.push('http://127.0.0.1:' + newApiPort + options.path);
      return httpRequest({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: newApiPort,
        lookup: undefined, autoSelectFamily: false }, incoming => {
        // Test-only address seam. The real GET request and response reach the isolated New API process.
        Object.defineProperty(incoming.socket, 'remoteAddress', { value: '8.8.8.8' });
        callback(incoming);
      });
    },
  });
  const processor = new SiteWebhookProcessor({ sites: f.sites, webhooks: new WebhookStore(f.database), epay,
    clock: f.now, transport: () => transport });
  const providerTime = time => new Date(time + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  let sequence = 0;
  async function pay(parameters) {
    const submit = await app.request('/submit.php', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(parameters).toString() });
    assert.equal(submit.status, 302, await submit.clone().text());
    const metadata = epay.findOrder(site.clientId, { outTradeNo: parameters.out_trade_no });
    const order = f.orders.forSite(site.clientId).get(metadata.orderId);
    f.setNow(f.now() + 5000);
    const entry = recordLedgerEntry(ledger, { start: providerTime(f.now() - 60000), end: providerTime(f.now() + 60000) },
      'newapi-' + ++sequence, order.payableAmountCents, f.now() - 1000, f.now(), 'CREDIT', f.snapshot.activeProviderAccountKey);
    f.setNow(f.now() + 10);
    assert.equal(reconciliation.reconcileEntry(entry.ledgerEntryId, f.now()).kind, 'auto_settled');
    const returned = await app.request('/api/public/v1/checkouts/' + order.checkoutToken + '/return');
    assert.equal(returned.status, 302);
    const url = new URL(returned.headers.get('location'));
    const query = await app.request('/api.php?' + new URLSearchParams({ act: 'order', pid: credentials.pid, key: credentials.v1Key, trade_no: metadata.tradeNo }));
    const queried = await query.json();
    assert.equal(queried.status, 1); assert.equal(queried.money, parameters.money);
    return { returnUrl: 'http://127.0.0.1:' + newApiPort + url.pathname + url.search, orderId: order.orderId,
      async notify() {
        const result = await processor.processOne();
        assert.equal(result.outcome, 'ACKNOWLEDGED', JSON.stringify(result));
        return delivered.at(-1);
      } };
  }
  return { credentials, pay, close: () => f.close(), integrity: () => f.database.integrityCheck() };
}
