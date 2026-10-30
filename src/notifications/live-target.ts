import { SANDBOX_PROVIDER_ENDPOINT } from "../settings/model.ts";

// Callers alias webhook_targets as target. Follow the original order's
// immutable source; an account's current environment must not relabel history.
export const LIVE_NOTIFICATION_TARGET = `NOT EXISTS (
  SELECT 1 FROM payment_orders AS source_order
    JOIN collection_profile_provider_accounts AS profile_source
      ON profile_source.profile_id = source_order.collection_profile_id
    JOIN provider_account_bindings AS source
      ON source.provider_account_key = profile_source.provider_account_key
   WHERE source_order.order_id = target.order_id
     AND source.provider_endpoint = '${SANDBOX_PROVIDER_ENDPOINT}'
)`;
