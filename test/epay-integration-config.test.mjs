// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { createApp } from '../src/http/app.ts';
import { createSitePaymentFixture } from './site-payment-fixture.ts';
import { HTTP_TEST_ADMIN_PASSWORD } from './http-fixture.ts';
import { createDemoClient, orderPayload, readConfig } from '../examples/node-client/server.mjs';

test('export rejects unusable callback configurations and accepted downloads create real orders', async () => {
  const f = await createSitePaymentFixture();
  try {
    const audit = { actorId: 'admin' };
    const origin = 'https://merchant.example.com';
    let site = f.createSite('Export contract');
    site = f.sites.rotateSecret(site.clientId, 'api_secret', site.revision, audit).site;
    site = f.sites.rotateSecret(site.clientId, 'webhook_secret', site.revision, audit).site;
    site = f.sites.update(site.clientId, { revision: site.revision, configuration: {
      ...site.configuration, notifications_enabled: true, notification_origin: origin, return_origin: origin,
    } }, audit);
    const health = () => ({ enabled: true, state: 'healthy', inFlight: false, lastAttemptAt: f.now(),
      lastSuccessAt: f.now(), lastErrorCode: null, consecutiveFailures: 0 });
    const app = createApp({ ...f, startedAt: new Date(f.now()), clock: f.now, ledgerHealth: health,
      reconciliationHealth: () => ({ ...health(), pendingOrders: 0, continuationPending: false }) });
    const session = await f.identity.login(HTTP_TEST_ADMIN_PASSWORD);
    const headers = { cookie: `perpay_session=${session.sessionToken}; perpay_csrf=${session.csrfToken}`,
      'x-csrf-token': session.csrfToken, origin: f.config.publicOrigin, 'content-type': 'application/json' };
    const base = { site_revision: site.revision, epay_revision: f.settings.epayStore().get(site.clientId).revision,
      notify_url: origin + '/notify', return_url: origin + '/return' };
    const download = body => app.request(`/api/admin/v1/sites/${site.clientId}/integration/export`, {
      method: 'POST', headers, body: JSON.stringify({ ...base, ...body }),
    });
    for (const protocol of ['native', 'epay_v1', 'epay_v2']) {
      for (const field of ['notify_url', 'return_url']) {
        const badQueries = protocol === 'native' ? ['?a=1&a=2', '?a=1&%61=2']
          : ['?a=1&b=2', '?tracking.id=123', '?tracking%2Eid=123'];
        for (const query of badQueries) {
          const response = await download({ protocol, [field]: origin + '/callback' + query });
          assert.equal(response.status, 422, `${protocol} ${field} ${query}`);
          const error = await response.json();
          assert.equal(typeof error.error.fields[field], 'string');
        }
      }
      const query = protocol === 'native' ? '?a=1&b=2' : '?source=demo%2B%3D%2526';
      const response = await download({ protocol, notify_url: origin + '/通知' + query,
        return_url: origin + '/返回' + query });
      assert.equal(response.status, 200, await response.clone().text());
      const config = readConfig(parseEnv(await response.text()));
      const client = createDemoClient(config);
      client.fetch = (url, options) => {
        const parsed = new URL(url);
        return app.request(parsed.pathname + parsed.search, options);
      };
      const no = randomUUID();
      const result = await client.createOrder(orderPayload({ merchant_order_no: no, amount: '1.00',
        product_name: 'Downloaded configuration', confirm_real_payment: true }, config));
      assert.equal(result.merchant_order_no, no);
      const order = f.orders.forSite(site.clientId).getByMerchantOrderNumber(no);
      assert.equal(order.notification.notifyUrl, config.notifyUrl);
      assert.equal(order.returnUrl, config.returnUrl);
    }
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});
