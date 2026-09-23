import type { SystemStatus } from "@/api/client";
type Worker = Pick<
  SystemStatus["ledger"],
  "enabled" | "state" | "last_error_code" | "consecutive_failures"
>;
function workerHealthy(worker: Worker): boolean {
  return (
    !worker.enabled ||
    (!worker.last_error_code &&
      worker.consecutive_failures === 0 &&
      !["degraded", "stopped", "catching_up"].includes(worker.state))
  );
}
/** Presentation only. Never used to authorize payments or reinterpret the server's readiness gate. */
export function presentSystemStatus(data: SystemStatus) {
  const canReceive =
    data.status !== "not_ready" &&
    data.configured &&
    data.database.ok &&
    data.ledger.collection_ready &&
    data.reconciliation.confirmation_ready;
  const ledgerHealthy =
    data.ledger.collection_ready && workerHealthy(data.ledger);
  const reconciliationHealthy =
    data.reconciliation.confirmation_ready &&
    workerHealthy(data.reconciliation);
  const webhookHealthy = workerHealthy(data.webhook);
  const backupHealthy =
    data.backup.ok &&
    !data.backup.recovery_required &&
    !data.backup.configuration_mismatch &&
    !data.backup.clock_moved_backwards;
  const businessPending =
    (data.ledger.conflicts?.open ?? 0) > 0 ||
    (data.reconciliation.exceptions?.open ?? 0) > 0 ||
    data.webhook.dead_letters > 0;
  const runtimeWarning =
    !ledgerHealthy ||
    !reconciliationHealthy ||
    !webhookHealthy ||
    (data.backup.enabled && !backupHealthy) ||
    data.backup.recovery_required ||
    data.backup.configuration_mismatch ||
    data.backup.clock_moved_backwards ||
    (data.status === "degraded" &&
      (data.ledger.conflicts === null ||
        data.reconciliation.exceptions === null ||
        !businessPending));
  return {
    canReceive,
    ledgerHealthy,
    reconciliationHealthy,
    webhookHealthy,
    backupHealthy,
    businessPending,
    runtimeWarning,
    notice: !canReceive
      ? "收款已暂停"
      : runtimeWarning
        ? "有运行告警"
        : businessPending
          ? "有待处理事项"
          : null,
  };
}
