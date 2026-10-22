import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { createSitePaymentFixture } from './site-payment-fixture.ts';
import { createApp } from '../src/http/app.ts';
import { HTTP_TEST_ADMIN_PASSWORD } from './http-fixture.ts';
import { createOrderRequestSchema } from '../src/orders/model.ts';
import { SITE_ADMIN_ROUTES } from '../src/sites/admin-scope.ts';
import { LedgerStore } from '../src/ledger/store.ts';
import { ReconciliationStore } from '../src/reconciliation/store.ts';
import { WebhookStore } from '../src/notifications/store.ts';
import { recordLedgerEntry } from './reconciliation-http-fixture.ts';
import { setAdminRefundMark } from '../src/database/admin-refund-mark-store.ts';
import { siteOverview } from '../src/http/site-overview.ts';
async function fixture() {
    const f = await createSitePaymentFixture();
    f.setNow(f.now() - 10000);
    const ledger = new LedgerStore(f.database), reconciliation = new ReconciliationStore(f.database), webhookStore = new WebhookStore(f.database);
    const deps = { ...f, ledger, reconciliation, webhookStore, startedAt: new Date(), clock: f.now };
    const app = createApp(deps), session = await f.identity.login(HTTP_TEST_ADMIN_PASSWORD);
    const headers = { cookie: `perpay_session=${session.sessionToken}; perpay_csrf=${session.csrfToken}`, 'x-csrf-token': session.csrfToken, origin: f.config.publicOrigin, 'content-type': 'application/json' };
    const order = (site: string, no: string = randomUUID()) => f.orders.forSite(site).create(createOrderRequestSchema.parse({ merchant_order_no: no, idempotency_key: no, amount_cents: 10000, product_name: no })).order;
    const timestamp = (n: number) => new Date(n + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
    const credit = (amount: number) => recordLedgerEntry(ledger, { start: timestamp(f.now() - 60000), end: timestamp(f.now() + 60000) }, randomUUID(), amount, f.now() + 1000, f.now() + 2000, 'CREDIT', f.snapshot.activeProviderAccountKey!);
    const req = (path: string, method = 'GET', body?: unknown) => app.request('/api/admin/v1' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { ...f, app, deps, ledger, reconciliation, webhookStore, headers, order, credit, req };
}
it('mounts every site controller behind authentication and validates path-only scope', async () => {
    const f = await fixture();
    try {
        const a = f.createSite('A');
        const base = '/sites/' + a.clientId;
        for (const [method, path] of SITE_ADMIN_ROUTES) {
            const actual = base + path.replace(/:[A-Za-z]+/g, randomUUID());
            assert.equal((await f.app.request('/api/admin/v1' + actual, { method })).status, 401, path);
        }
        assert.equal((await f.req(base + '/orders?api_client_id=' + a.clientId)).status, 422);
        assert.equal((await f.req(base + '/orders/export', 'POST', { api_client_id: a.clientId })).status, 422);
        assert.equal((await f.req('/sites/unknown/orders')).status, 404);
        const demo = createApp({ ...f.deps, demoMode: true });
        assert.equal((await demo.request('/api/admin/v1' + base + '/test-payments', { method: 'POST', headers: f.headers, body: JSON.stringify({ test_payment_id: randomUUID(), amount_cents: 100 }) })).status, 403);
    }
    finally {
        f.close();
    }
});
it('scopes list, lookup, pagination, export, and detail without changing global access', async () => {
    const f = await fixture();
    try {
        const a = f.createSite('A'), b = f.createSite('B'), oa = f.order(a.clientId, 'same'), oa2 = f.order(a.clientId), ob = f.order(b.clientId, 'same');
        const base = '/sites/' + a.clientId;
        const page = await (await f.req(base + '/orders?limit=1')).json() as {
            data: {
                order_id: string;
            }[];
            page: {
                next_cursor: string;
            };
        };
        assert.equal(page.data.length, 1);
        assert.ok(page.page.next_cursor);
        const second = await (await f.req(base + '/orders?limit=1&cursor=' + encodeURIComponent(page.page.next_cursor))).json() as typeof page;
        assert.deepEqual(new Set([...page.data, ...second.data].map((o: {
            order_id: string;
        }) => o.order_id)), new Set([oa.orderId, oa2.orderId]));
        assert.equal((await f.req('/sites/' + b.clientId + '/orders?limit=1&cursor=' + encodeURIComponent(page.page.next_cursor))).status, 422);
        for (const suffix of ['', '/checkout', '/notifications/deliveries'])
            assert.equal((await f.req(base + '/orders/' + ob.orderId + suffix)).status, 404);
        assert.equal((await f.req('/orders/' + ob.orderId)).status, 200);
        assert.equal((await (await f.req(base + '/orders/by-merchant-no/same')).json() as {
            data: {
                order_id: string;
            };
        }).data.order_id, oa.orderId);
        const csv = await (await f.req(base + '/orders/export', 'POST', { created_from: new Date(f.now() + 8 * 3600000).toISOString().slice(0, 10), created_to: new Date(f.now() + 8 * 3600000).toISOString().slice(0, 10) })).text();
        assert.ok(csv.includes(oa.orderId));
        assert.ok(!csv.includes(ob.orderId));
        const paused = f.sites.get(a.clientId)!;
        f.sites.update(a.clientId, { revision: paused.revision, configuration: { ...paused.configuration, accepting_orders: false } }, { actorId: 'admin' });
        assert.equal((await f.req(base + '/orders/' + oa.orderId)).status, 200);
        const aggregate = await (await f.req(base + '/system/analytics')).json() as {
            data: {
                orders: {
                    created: number;
                };
                pending: {
                    conflicts: null;
                };
            };
        };
        assert.equal(aggregate.data.orders.created, 2);
        assert.equal(aggregate.data.pending.conflicts, null);
    }
    finally {
        f.close();
    }
});
it('filters site-conflicting manual ledger candidates before pagination', async () => {
    const f = await fixture();
    try {
        const a = f.createSite('Manual scope A'), b = f.createSite('Manual scope B');
        const target = f.order(a.clientId, 'manual-scope-target');
        const now = f.now();
        const window = {
            start: new Date(now - 60_000 + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' '),
            end: new Date(now + 60 * 60_000 + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' '),
        };
        let ingestSequence = 0;
        const scopedCredit = (externalEventId: string, amountCents: number, occurredAt: number) => recordLedgerEntry(
            f.ledger,
            window,
            externalEventId,
            amountCents,
            occurredAt,
            now + 1_000 + ingestSequence++ * 1_000,
            'CREDIT',
            f.snapshot.activeProviderAccountKey!,
        );
        const reverse = (orderId: string, ledgerEntryId: string) => {
            const settledAt = Math.max(Date.now(), f.reconciliation.ledgerEntry(ledgerEntryId)!.updatedAt) + 1;
            const settled = f.reconciliation.settleManually({
                financialOperationId: randomUUID(), orderId, ledgerEntryId,
                actorId: 'admin', reason: 'site scope pagination setup', now: settledAt,
            });
            f.reconciliation.reverseSettlement({
                financialOperationId: randomUUID(), paymentMatchId: settled.paymentMatch.paymentMatchId,
                actorId: 'admin', reason: 'site scope pagination regression', now: settledAt + 1,
            });
        };
        // Foreign records sort first but retain reversed B-site matches, so
        // site-scoped pagination must remove them before taking a page.
        const foreignEntries = Array.from({ length: 10 }, (_, index) => {
            const foreign = f.order(b.clientId, 'manual-scope-foreign-' + index);
            const entry = scopedCredit('manual-scope-foreign-entry-' + index, target.payableAmountCents, now + 3_000 + index * 1_000);
            reverse(foreign.orderId, entry.ledgerEntryId);
            return entry;
        });
        const localEntry = scopedCredit('manual-scope-local-entry', target.payableAmountCents, now + 2_000);
        const sameSiteOrder = f.order(a.clientId, 'manual-scope-same-site-history');
        const sameSiteEntry = scopedCredit('manual-scope-same-site-entry', target.payableAmountCents, now + 1_000);
        reverse(sameSiteOrder.orderId, sameSiteEntry.ledgerEntryId);
        const differentAmount = scopedCredit('manual-scope-different-amount', target.payableAmountCents + 777, now);
        const conflictedEntry = scopedCredit('manual-scope-open-conflict', target.payableAmountCents, now + 20_000);
        const conflictAmount = ((target.payableAmountCents + 1) / 100).toFixed(2);
        const conflictDetail = {
            accountLogId: conflictedEntry.externalEventId,
            occurredAt: new Date(now + 20_000 + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' '),
            amount: conflictAmount,
            direction: 'CREDIT',
            alipayOrderNo: 'platform-' + conflictedEntry.externalEventId,
            merchantOrderNo: null, transMemo: null, otherAccount: null,
            raw: { account_log_id: conflictedEntry.externalEventId, amount: conflictAmount },
        };
        const recordConflict = () => {
            const startedAt = now + 1_000 + ingestSequence++ * 1_000;
            const run = f.ledger.startIngestRun({ ...window, pageSize: 1, providerAccountKey: f.snapshot.activeProviderAccountKey!, now: startedAt });
            return f.ledger.recordPage({
                ingestRunId: run.ingestRunId,
                page: { pageNo: 1, pageSize: 1, totalSize: 1, hasMore: false, details: [conflictDetail] },
                evidence: { httpStatus: 200, headers: {}, body: JSON.stringify(conflictDetail), traceId: 'manual-scope-conflict', signatureVerified: true },
                now: startedAt + 1,
            });
        };
        let conflict = recordConflict();
        if (conflict.kind === 'variant') conflict = recordConflict();
        assert.equal(conflict.normalized[0]?.kind, 'conflict');
        assert.ok(f.ledger.listOpenConflicts(f.snapshot.activeProviderAccountKey!).some(item => item.existingLedgerEntryId === conflictedEntry.ledgerEntryId));

        const snapshot = () => f.database.read(db => JSON.stringify([
            'payment_orders', 'amount_slots', 'ledger_entries', 'match_candidates', 'payment_matches',
            'financial_operations', 'order_events', 'payment_match_events', 'ledger_transactions',
            'ledger_postings', 'financial_exceptions', 'ledger_conflicts', 'ledger_conflict_operations',
            'outbox_events', 'provider_raw_pages', 'provider_raw_events', 'ingest_runs',
            'ingest_segments', 'ingest_run_page_observations', 'ledger_cursors',
        ].map(table => db.prepare('SELECT * FROM ' + table).all()), (_, value) => typeof value === 'bigint' ? String(value) : value));
        type CandidatePage = {
            data: Array<{ ledger_entry: { ledger_entry_id: string } }>;
            page: { next_cursor: string | null };
        };
        const page = async (path: string): Promise<CandidatePage> => {
            const response = await f.req(path);
            assert.equal(response.status, 200, await response.clone().text());
            return await response.json() as CandidatePage;
        };
        const ids = (body: CandidatePage) => body.data.map(item => item.ledger_entry.ledger_entry_id);
        const otherTarget = f.order(b.clientId, 'manual-scope-other-target');
        const beforeQueries = snapshot();
        for (const view of ['recommended', 'all'] as const) {
            const query = '/reconciliation/settlements/manual/ledger-entries?order_id=' + target.orderId + '&view=' + view;
            const sitePath = '/sites/' + a.clientId + query;
            const expected = [localEntry.ledgerEntryId, sameSiteEntry.ledgerEntryId, ...(view === 'all' ? [differentAmount.ledgerEntryId] : [])];
            const scoped = await page(sitePath);
            assert.deepEqual(ids(scoped), expected);
            assert.equal(scoped.page.next_cursor, null);
            const scopedFirst = await page(sitePath + '&limit=1');
            assert.deepEqual(ids(scopedFirst), expected.slice(0, 1));
            assert.ok(scopedFirst.page.next_cursor);
            const discovered = ids(scopedFirst);
            let cursor: string | null = scopedFirst.page.next_cursor;
            while (cursor !== null) {
                const next = await page(sitePath + '&limit=1&cursor=' + encodeURIComponent(cursor));
                assert.equal(next.data.length, 1);
                discovered.push(...ids(next));
                assert.ok(discovered.length <= expected.length);
                cursor = next.page.next_cursor;
            }
            assert.deepEqual(discovered, expected);
            assert.equal(new Set(discovered).size, expected.length);

            const globalFirst = await page(query);
            assert.equal(globalFirst.data.length, 10);
            assert.ok(globalFirst.page.next_cursor);
            const globalNext = await page(query + '&cursor=' + encodeURIComponent(globalFirst.page.next_cursor));
            assert.equal(globalNext.page.next_cursor, null);
            const globalIds = [...ids(globalFirst), ...ids(globalNext)];
            const expectedGlobal = [...foreignEntries.map(entry => entry.ledgerEntryId), conflictedEntry.ledgerEntryId, ...expected];
            assert.equal(globalIds.length, expectedGlobal.length);
            assert.deepEqual(new Set(globalIds), new Set(expectedGlobal));
            assert.equal((await f.req(sitePath + '&cursor=' + encodeURIComponent(globalFirst.page.next_cursor))).status, 422);
            assert.equal((await f.req(query + '&limit=1&cursor=' + encodeURIComponent(scopedFirst.page.next_cursor))).status, 422);
            const otherPath = '/sites/' + b.clientId + '/reconciliation/settlements/manual/ledger-entries?order_id=' + otherTarget.orderId + '&view=' + view;
            assert.equal((await f.req(otherPath + '&limit=1&cursor=' + encodeURIComponent(scopedFirst.page.next_cursor))).status, 422);
        }
        assert.equal(snapshot(), beforeQueries);
    }
    finally {
        f.close();
    }
});
it('validates ownership inside financial writes and idempotent replay, preserving global replay', async () => {
    const f = await fixture();
    try {
        const a = f.createSite('A'), b = f.createSite('B'), oa = f.order(a.clientId), ob = f.order(b.clientId);
        const entry = f.credit(oa.payableAmountCents), base = '/sites/' + a.clientId;
        assert.equal((await f.req(base + '/reconciliation/ledger-entries/' + entry.ledgerEntryId)).status, 404);
        assert.equal((await f.req(base + '/reconciliation/ledger-entries/' + entry.ledgerEntryId + '?order_id=' + oa.orderId)).status, 200);
        const bad = { financial_operation_id: randomUUID(), order_id: ob.orderId, ledger_entry_id: entry.ledgerEntryId, reason: 'test' };
        assert.equal((await f.req(base + '/reconciliation/settlements/manual', 'POST', bad)).status, 404);
        const input = { ...bad, financial_operation_id: randomUUID(), order_id: oa.orderId };
        const response = await f.req(base + '/reconciliation/settlements/manual', 'POST', input);
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal((await f.req('/sites/' + b.clientId + '/reconciliation/settlements/manual', 'POST', input)).status, 404);
        assert.equal((await f.req('/reconciliation/settlements/manual', 'POST', input)).status, 200);
        const mark = { operation_id: randomUUID(), version: 0, marked: true };
        assert.equal((await f.req(base + '/orders/' + oa.orderId + '/refund-mark', 'PUT', mark)).status, 200);
        assert.throws(() => setAdminRefundMark(f.database, oa.orderId, mark, { actorId: 'admin', expectedClientId: b.clientId }), /当前网站/);
        const match = f.reconciliation.paymentMatchDetailsForOrder(oa.orderId)[0]!;
        const matchId = match.paymentMatch.paymentMatchId;
        assert.equal((await f.req('/sites/' + b.clientId + '/reconciliation/matches/' + matchId)).status, 404);
        const reverse = { financial_operation_id: randomUUID(), reason: 'test reversal' };
        assert.equal((await f.req(base + '/reconciliation/matches/' + matchId + '/actions/reverse', 'POST', reverse)).status, 200);
        assert.equal((await f.req(base + '/reconciliation/matches/' + matchId + '/actions/reverse', 'POST', reverse)).status, 200);
        const cross = { financial_operation_id: randomUUID(), order_id: ob.orderId, ledger_entry_id: entry.ledgerEntryId, reason: 'cross site' };
        const denied = await f.req('/sites/' + b.clientId + '/reconciliation/settlements/manual', 'POST', cross);
        assert.equal(denied.status, 409);
        assert.equal((await denied.json() as {
            error: {
                code: string;
            };
        }).error.code, 'site_scope_conflict');
    }
    finally {
        f.close();
    }
});
it('batch overview uses bounded aggregate queries, pagination binding and current site metrics', async (t) => {
    const f = await fixture();
    try {
        const a = f.createSite('Batch A'), b = f.createSite('Batch B');
        f.order(a.clientId);
        f.order(a.clientId);
        f.order(b.clientId);
        const paid = f.order(a.clientId), entry = f.credit(paid.payableAmountCents);
        f.reconciliation.settleManually({ financialOperationId: randomUUID(), orderId: paid.orderId, ledgerEntryId: entry.ledgerEntryId, actorId: 'admin' });
        f.setNow(Date.now());
        let calls = 0;
        const original = f.database.read.bind(f.database);
        t.mock.method(f.database, 'read', ((operation: Parameters<typeof original>[0]) => { calls++; return original(operation); }) as typeof original);
        const overview = siteOverview(f.database, new URLSearchParams('q=Batch&range=7&limit=1'), f.now());
        assert.equal(calls, 1);
        assert.equal(overview.data.length, 1);
        assert.ok(overview.page.next_cursor);
        const next = siteOverview(f.database, new URLSearchParams('q=Batch&range=7&limit=1&cursor=' + encodeURIComponent(overview.page.next_cursor!)), f.now());
        assert.equal(next.page.next_cursor, null);
        const rows = [...overview.data, ...next.data];
        assert.equal(rows.find(s => s.client_id === a.clientId)!.pending_orders, 2);
        assert.equal(rows.find(s => s.client_id === b.clientId)!.pending_orders, 1);
        assert.equal(rows.find(s => s.client_id === a.clientId)!.confirmed_count, 1);
        assert.equal(rows.find(s => s.client_id === a.clientId)!.confirmed_amount_cents, paid.payableAmountCents);
        assert.equal(overview.period.to, new Date(f.now() + 8 * 3600000).toISOString().slice(0, 10));
        assert.equal(Date.parse(overview.period.to) - Date.parse(overview.period.from), 6 * 86400000);
        assert.deepEqual(next.period, overview.period);
        assert.equal(overview.max_confirmed_amount_cents, paid.payableAmountCents);
        assert.equal(next.max_confirmed_amount_cents, paid.payableAmountCents);
        assert.ok(rows.every(row => !("daily" in row)));
        assert.throws(() => siteOverview(f.database, new URLSearchParams('range=7&cursor=' + encodeURIComponent(overview.page.next_cursor!)), f.now()), /游标/);
        assert.throws(() => siteOverview(f.database, new URLSearchParams('q=Batch&range=30&cursor=' + encodeURIComponent(overview.page.next_cursor!)), f.now()), /游标/);
        const response = await f.req('/sites/overview?q=Batch&range=7');
        assert.equal(response.status, 200);
        const payload = await response.json() as ReturnType<typeof siteOverview>;
        assert.equal(payload.data.length, 2);
        assert.deepEqual(payload.data, rows.toSorted((left, right) => left.client_id.localeCompare(right.client_id)));
        assert.deepEqual(payload.period, overview.period);
        assert.equal(payload.max_confirmed_amount_cents, paid.payableAmountCents);
        for (const [q, expectedSites] of [['Batch B', 1], ['no matching site', 0]] as const) {
            const filteredResponse = await f.req('/sites/overview?range=7&q=' + encodeURIComponent(q));
            assert.equal(filteredResponse.status, 200);
            const filtered = await filteredResponse.json() as ReturnType<typeof siteOverview>;
            assert.equal(filtered.data.length, expectedSites);
            assert.deepEqual(filtered.period, overview.period);
            assert.equal(filtered.max_confirmed_amount_cents, paid.payableAmountCents);
        }
    }
    finally {
        f.close();
    }
});
it('isolates notification attempts, redelivery and reminder restoration including replays', async () => {
    const f = await fixture();
    try {
        const a = f.createSite('A'), b = f.createSite('B');
        f.sites.rotateSecret(a.clientId, 'webhook_secret', 0, { actorId: 'admin' });
        const current = f.sites.get(a.clientId)!;
        f.sites.update(a.clientId, { revision: current.revision, configuration: { ...current.configuration, notifications_enabled: true, notification_origin: 'https://site.example.com' } }, { actorId: 'admin' });
        const order = f.orders.forSite(a.clientId).create(createOrderRequestSchema.parse({ merchant_order_no: 'notify', idempotency_key: 'notify', amount_cents: 10000, product_name: 'notify', notify_url: 'https://site.example.com/notify' })).order;
        const entry = f.credit(order.payableAmountCents);
        f.reconciliation.settleManually({ financialOperationId: randomUUID(), orderId: order.orderId, ledgerEntryId: entry.ledgerEntryId, actorId: 'admin' });
        f.webhookStore.materialize(10, Date.now(), a.clientId);
        const deliveries = f.webhookStore.listDeliveries({ apiClientId: a.clientId, limit: 10 });
        const id = deliveries.deliveries[0]!.delivery.deliveryId;
        for (const suffix of ['', '/attempts']) {
            assert.equal((await f.req('/sites/' + a.clientId + '/webhooks/deliveries/' + id + suffix)).status, 200);
            assert.equal((await f.req('/sites/' + b.clientId + '/webhooks/deliveries/' + id + suffix)).status, 404);
        }
        assert.equal((await f.req('/sites/' + b.clientId + '/webhooks/deliveries/' + id + '/actions/redeliver', 'POST', { redelivery_id: randomUUID(), reason: 'retry' })).status, 404);
        assert.equal((await f.req('/sites/' + b.clientId + '/work-items/NOTIFICATION_FAILURE/' + id + '/actions/restore', 'POST', { operation_id: randomUUID() })).status, 404);
        const claim = f.webhookStore.claimNext({ clientId: a.clientId, siteRevision: f.sites.get(a.clientId)!.revision, now: Date.now(), leaseMilliseconds: 30000, maximumAttempts: 1 });
        assert.ok(claim);
        f.webhookStore.completeAttempt({ deliveryId: id, attemptId: claim.attempt.attemptId, leaseToken: claim.attempt.leaseToken, outcome: "PERMANENT_FAILURE", now: Date.now(), maximumAttempts: 1, retryBaseMilliseconds: 1000, retryMaximumMilliseconds: 1000, errorCode: "transport_network" });
        const command = { redelivery_id: randomUUID(), reason: "核实后重投" };
        const endpoint = "/webhooks/deliveries/" + id + "/actions/redeliver";
        const replay = await f.req("/sites/" + a.clientId + endpoint, "POST", command);
        assert.equal(replay.status, 201, await replay.clone().text());
        assert.ok(replay.headers.get("location")!.startsWith("/api/admin/v1/sites/" + a.clientId + "/webhooks/deliveries/"));
        assert.equal((await f.req("/sites/" + b.clientId + endpoint, "POST", command)).status, 404);
        assert.equal((await f.req("/sites/" + a.clientId + endpoint, "POST", command)).status, 200);
        const globalReplay = await f.req(endpoint, "POST", command);
        assert.equal(globalReplay.status, 200);
        assert.ok(globalReplay.headers.get("location")!.startsWith("/api/admin/v1/webhooks/deliveries/"));
        const data = await (await f.req('/sites/' + b.clientId + '/webhooks/deliveries')).json() as {
            data: unknown[];
        };
        assert.equal(data.data.length, 0);
        assert.equal((await f.req('/sites/' + a.clientId + '/work-items/LEDGER_CONFLICT/' + randomUUID() + '/actions/restore', 'POST', { operation_id: randomUUID() })).status, 404);
    }
    finally {
        f.close();
    }
});
