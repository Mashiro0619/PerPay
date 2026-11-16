import { parentPort, workerData } from "node:worker_threads";
import { readBackupPolicy } from "../backup/policy.ts";
import { backupErrorDetails } from "../backup/error-details.ts";
import { runManagedMaintenance } from "../backup/runner.ts";
import type { MaintenanceRequest, MaintenanceResult } from "./model.ts";
import type { MaintenanceWorkerConfig, MaintenanceWorkerMessage } from "./worker-client.ts";

const { input, config } = workerData as { input: MaintenanceRequest; config: MaintenanceWorkerConfig };
const send = (message: MaintenanceWorkerMessage) => parentPort!.postMessage(message);

try {
  const policy = readBackupPolicy(config.dataDir);
  const result = await runManagedMaintenance(input, {
    dataDirectory: config.dataDir,
    backupDirectory: config.backupDir,
    masterKey: Buffer.from(config.masterKey),
    ...policy,
  }, (stage, message) => send({ type: "progress", stage, message }));
  send({ type: "result", result });
} catch (error) {
  const result = error instanceof Error && "result" in error ? error.result as MaintenanceResult : null;
  send({ type: "error", message: failureMessage(error), result });
} finally { parentPort!.close(); }

function failureMessage(error: unknown): string {
  let current = error;
  while (current instanceof Error) {
    if (/[\u4e00-\u9fff]/u.test(current.message) && current.message !== "恢复失败") return current.message;
    current = current.cause;
  }
  const details = backupErrorDetails(error);
  if (details.error_code === "ENOSPC" || details.message.includes("Insufficient storage headroom")) return "磁盘空间不足，请释放空间后重试。";
  if (details.message.includes("another backup operation") || details.message.includes("maintenance operation may be running")) return "已有备份或维护操作正在执行，请稍后重试。";
  if (details.message.includes("SHA-256")) return "备份校验失败，请刷新列表后重新选择备份。";
  if (details.message.includes("MASTER_KEY") || details.message.includes("master key")) return "当前部署密钥无法解密所选备份。";
  if (details.message.includes("another application instance") || details.message.includes("instance identity changed")) return "所选备份属于其他 PerPay 实例。";
  return details.message;
}
