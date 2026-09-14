import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { it } from "node:test";
import { adminWorkItemPage, ignoreAllAdminWorkItems, restoreAdminWorkItem } from "../src/http/admin-work-items.ts";
import { AdminOperationError } from "../src/database/admin-operation-store.ts";
import type { ClaimedWebhookAttempt } from "../src/notifications/store.ts";
import { withHttpFixture, enableNotifications, login, responseData } from "./reconciliation-http-fixture.ts";

it("continues retrying ignored notifications, retains dismissal through final failure, and treats redeliveries as new reminders", async () => {
  await withHttpFixture(async (fixture) => {
    const { allowedOrigin, notifyUrl } = enableNotifications(fixture);
    fixture.createSettlement("ignored-notification", 999, notifyUrl);
    const context = { actorId: "admin", requestId: "ignore-notification", remoteAddressHash: "a".repeat(64) };
    const store = fixture.webhooks;
    const now = Date.now(); assert.equal(store.materialize(10, now), 1);
    const first = store.claimNext({ now, leaseMilliseconds: 10_000, maximumAttempts: 2 }); assert.ok(first);
    function finish(attempt: ClaimedWebhookAttempt, at: number, acknowledged = false) {
      return store.completeAttempt({ deliveryId: attempt.delivery.deliveryId, attemptId: attempt.attempt.attemptId,
        leaseToken: attempt.attempt.leaseToken, outcome: acknowledged ? "ACKNOWLEDGED" : "RETRYABLE_FAILURE", now: at,
        maximumAttempts: 2, retryBaseMilliseconds: 1000, retryMaximumMilliseconds: 60_000,
        ...(acknowledged ? { httpStatus: 200, responseBytes: 2, responseFingerprint: createHash("sha256").update("ok").digest("hex"),
          ackCode: "acknowledged", resolvedAddressesFingerprint: "a".repeat(64), connectedAddress: "8.8.8.8" } : { errorCode: "transport_timeout" }),
      });
    }
    const failed = finish(first, now + 1); assert.equal(failed.status, "RETRY_WAIT");
    const ignored = ignoreAllAdminWorkItems(fixture.database, { operation_id: randomUUID(), type: "NOTIFICATION_FAILURE" }, context);
    assert.equal(ignored.ignored_count, 1); assert.deepEqual(store.counts(), { pending: 1, dead: 0 });
    assert.equal(adminWorkItemPage(fixture.database, { type: "ALL", cursor: null, limit: 20 }).items.length, 0);
    const retry = store.claimNext({ now: failed.nextAttemptAt, leaseMilliseconds: 10_000, maximumAttempts: 2 }); assert.ok(retry);
    assert.equal(retry.delivery.deliveryId, failed.deliveryId);
    assert.equal(adminWorkItemPage(fixture.database, { type: "NOTIFICATION_FAILURE", visibility: "IGNORED", cursor: null, limit: 20 }).items[0]?.ended, false);
    const dead = finish(retry, failed.nextAttemptAt + 1); assert.equal(dead.status, "DEAD_LETTER");
    assert.equal(adminWorkItemPage(fixture.database, { type: "ALL", cursor: null, limit: 20 }).items.length, 0);
    assert.deepEqual(store.counts(), { pending: 0, dead: 1 });
    const auth = await login(fixture.app);
    const analytics = await responseData<Record<string, any>>(await fixture.app.request("/api/admin/v1/system/analytics", { headers: { cookie: auth.cookie } }));
    assert.equal(analytics.notifications.failed, 1, "operational failure counts must not be hidden");
    const replay = store.replay({ redeliveryId: randomUUID(), deliveryId: dead.deliveryId, actorId: "admin", reason: "new isolated redelivery", activeAllowedOrigin: allowedOrigin, now: dead.updatedAt + 1 });
    assert.notEqual(replay.delivery.deliveryId, dead.deliveryId);
    const redelivery = store.claimNext({ now: replay.delivery.nextAttemptAt, leaseMilliseconds: 10_000, maximumAttempts: 2 }); assert.ok(redelivery);
    const newFailure = finish(redelivery, replay.delivery.nextAttemptAt + 1);
    assert.deepEqual(adminWorkItemPage(fixture.database, { type: "ALL", cursor: null, limit: 20 }).items.map((item) => item.itemId), [newFailure.deliveryId]);
    const originalHistory = adminWorkItemPage(fixture.database, { type: "NOTIFICATION_FAILURE", visibility: "IGNORED", cursor: null, limit: 20 });
    assert.equal(originalHistory.items[0]?.ended, true);
    const ignoreNew = ignoreAllAdminWorkItems(fixture.database, { operation_id: randomUUID(), type: "NOTIFICATION_FAILURE" }, context);
    assert.equal(ignoreNew.ignored_count, 1);
    const final = store.claimNext({ now: newFailure.nextAttemptAt, leaseMilliseconds: 10_000, maximumAttempts: 2 }); assert.ok(final);
    assert.equal(finish(final, newFailure.nextAttemptAt + 1, true).status, "ACKNOWLEDGED");
    const history = adminWorkItemPage(fixture.database, { type: "NOTIFICATION_FAILURE", visibility: "IGNORED", cursor: null, limit: 20 });
    assert.equal(history.items.length, 2); assert.ok(history.items.every((item) => item.ended));
    for (const item of history.items) assert.throws(() => restoreAdminWorkItem(fixture.database, { operation_id: randomUUID(), type: "NOTIFICATION_FAILURE", resource_id: item.itemId }, context), (error) => error instanceof AdminOperationError && error.code === "work_item_ended");
    assert.equal(fixture.database.integrityCheck().ok, true);
  });
});
