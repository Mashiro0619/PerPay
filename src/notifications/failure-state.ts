import { LIVE_NOTIFICATION_TARGET } from "./live-target.ts";

// These expressions use the internal delivery, target, outbox and orders aliases.
const REVOKED_EPAY_CONFIRMATION = `(target.target_format != 'NATIVE_JSON_V1' AND (
  orders.payment_status != 'CONFIRMED' OR NOT EXISTS (
    SELECT 1 FROM payment_matches AS confirmation
     WHERE confirmation.created_by_operation_id = outbox.financial_operation_id
       AND confirmation.status = 'SETTLED'
  )
))`;

const HAS_SUCCESSOR = `EXISTS (
  SELECT 1 FROM webhook_deliveries AS successor
   WHERE successor.predecessor_delivery_id = delivery.delivery_id
)`;

const FAILED_NOTIFICATION_STATUS = `(delivery.status IN ('RETRY_WAIT', 'DEAD_LETTER')
  OR (delivery.status = 'LEASED' AND delivery.attempt_count >= 1 AND delivery.last_error_code IS NOT NULL))`;

export const ACTIONABLE_NOTIFICATION_FAILURE = `(${FAILED_NOTIFICATION_STATUS}
  AND ${LIVE_NOTIFICATION_TARGET}
  AND NOT ${REVOKED_EPAY_CONFIRMATION} AND NOT ${HAS_SUCCESSOR})`;

export const ENDED_NOTIFICATION_FAILURE = `(delivery.status = 'ACKNOWLEDGED'
  OR NOT ${LIVE_NOTIFICATION_TARGET}
  OR ${REVOKED_EPAY_CONFIRMATION} OR ${HAS_SUCCESSOR})`;

export const ACTIVE_NOTIFICATION_FAILURE = `(${ACTIONABLE_NOTIFICATION_FAILURE} AND NOT EXISTS (
  SELECT 1 FROM admin_work_item_states AS reminder
   WHERE reminder.kind = 'NOTIFICATION_FAILURE' AND reminder.item_id = delivery.delivery_id
     AND reminder.ignored = 1
))`;
