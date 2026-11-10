export function reconfirmedOrderResolutionSql(exception: "NEW" | "exception", operation: "operation" | "resolution"): string {
  return `COALESCE((${exception}.exception_type = 'RECONCILIATION_CONFLICT'
    AND json_extract(${exception}.details_json, '$.reason') = 'settlement_reversed'
    AND ${operation}.operation_type = 'MANUAL_SETTLEMENT'
    AND ${operation}.order_id = ${exception}.order_id
    AND ${operation}.reason IS NOT NULL
    AND json_extract(${exception}.resolution_json, '$.resolution') = 'dispute_reconfirmed'
    AND EXISTS (SELECT 1 FROM payment_matches AS replacement
      WHERE replacement.payment_match_id = json_extract(${exception}.resolution_json, '$.payment_match_id')
        AND replacement.order_id = ${exception}.order_id
        AND replacement.ledger_entry_id = ${operation}.ledger_entry_id
        AND replacement.created_by_operation_id = ${operation}.financial_operation_id)), 0)`;
}

export const DISPUTE_RECONFIRMATION_SCHEMA_SQL = `
  DROP TRIGGER payment_orders_payment_state_transition;
  CREATE TRIGGER payment_orders_payment_state_transition
  BEFORE UPDATE OF received_amount_cents, payment_status, refund_status, payment_basis ON payment_orders
  WHEN NOT (
    (OLD.payment_status = 'UNPAID' AND OLD.payment_basis = 'NONE'
      AND OLD.received_amount_cents IS NULL AND OLD.refund_status = 'NONE'
      AND NEW.payment_status = 'CONFIRMED' AND NEW.payment_basis IN ('INFERRED', 'MANUAL')
      AND NEW.received_amount_cents IS NOT NULL AND NEW.refund_status = 'NONE') OR
    (OLD.payment_status = 'CONFIRMED' AND NEW.payment_status = 'DISPUTED'
      AND NEW.payment_basis = OLD.payment_basis AND NEW.received_amount_cents = OLD.received_amount_cents
      AND NEW.refund_status = OLD.refund_status) OR
    (OLD.payment_status IN ('CONFIRMED', 'DISPUTED') AND NEW.payment_status = OLD.payment_status
      AND NEW.payment_basis = OLD.payment_basis AND NEW.received_amount_cents = OLD.received_amount_cents
      AND ((OLD.refund_status = 'NONE' AND NEW.refund_status IN ('PARTIAL', 'FULL'))
        OR (OLD.refund_status = 'PARTIAL' AND NEW.refund_status IN ('PARTIAL', 'FULL')))) OR
    (OLD.payment_status = 'DISPUTED' AND NEW.payment_status = 'CONFIRMED'
      AND NEW.payment_basis = 'MANUAL' AND OLD.refund_status = 'NONE' AND NEW.refund_status = 'NONE'
      AND NOT EXISTS (SELECT 1 FROM admin_refund_marks AS current
        JOIN admin_refund_mark_events AS mark ON mark.order_id = current.order_id AND mark.version = current.version
        WHERE current.order_id = OLD.order_id AND mark.marked = 1)
      AND EXISTS (SELECT 1 FROM payment_matches AS replacement
        JOIN financial_operations AS operation ON operation.financial_operation_id = replacement.created_by_operation_id
        JOIN ledger_entries AS entry ON entry.ledger_entry_id = replacement.ledger_entry_id
        WHERE replacement.order_id = OLD.order_id AND replacement.status = 'SETTLED'
          AND replacement.evidence_type = 'MANUAL' AND operation.operation_type = 'MANUAL_SETTLEMENT'
          AND operation.reason IS NOT NULL AND operation.created_at = NEW.updated_at
          AND entry.amount_cents = NEW.received_amount_cents))
  )
  BEGIN SELECT RAISE(ABORT, 'payment state transition is invalid'); END;

  CREATE TRIGGER disputed_manual_settlement_reason
  BEFORE INSERT ON financial_operations
  WHEN NEW.operation_type = 'MANUAL_SETTLEMENT' AND NEW.reason IS NULL
    AND EXISTS (SELECT 1 FROM payment_orders WHERE order_id = NEW.order_id AND payment_status = 'DISPUTED')
  BEGIN SELECT RAISE(ABORT, 'disputed settlement requires a review reason'); END;

  DROP TRIGGER financial_exceptions_resolution_once;
  CREATE TRIGGER financial_exceptions_resolution_once
  BEFORE UPDATE OF status, resolution_operation_id, resolution_json, resolution_fingerprint, resolved_at
  ON financial_exceptions
  WHEN OLD.status != 'OPEN' OR NEW.status != 'RESOLVED'
    OR NEW.resolution_operation_id IS NULL OR NEW.resolution_json IS NULL
    OR NEW.resolution_fingerprint IS NULL OR NEW.resolved_at IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM financial_operations AS operation
      WHERE operation.financial_operation_id = NEW.resolution_operation_id
        AND operation.created_at = NEW.resolved_at
        AND operation.operation_type IN ('AUTO_SETTLEMENT', 'MANUAL_SETTLEMENT', 'RECORD_REFUND')
        AND (
          (operation.ledger_entry_id IS NEW.ledger_entry_id AND (
            NEW.order_id IS NULL OR operation.order_id IS NEW.order_id OR (
              operation.operation_type IN ('AUTO_SETTLEMENT', 'MANUAL_SETTLEMENT')
              AND json_type(NEW.resolution_json, '$.resolution') = 'text'
              AND json_extract(NEW.resolution_json, '$.resolution') = 'superseded_by_settlement'
              AND json_type(NEW.resolution_json, '$.payment_match_id') = 'text'
              AND EXISTS (SELECT 1 FROM payment_matches AS payment_match
                WHERE payment_match.payment_match_id = json_extract(NEW.resolution_json, '$.payment_match_id')
                  AND payment_match.ledger_entry_id IS operation.ledger_entry_id
                  AND payment_match.order_id IS operation.order_id
                  AND payment_match.created_by_operation_id = operation.financial_operation_id)
            )
          )) OR ${reconfirmedOrderResolutionSql("NEW", "operation")}
        )
    )
  BEGIN SELECT RAISE(ABORT, 'financial exception resolution is invalid'); END;
`;
