import { Worker } from "node:worker_threads";
import type { MaintenanceRequest, MaintenanceResult } from "./model.ts";

export interface MaintenanceWorkerConfig {
  dataDir: string;
  backupDir: string;
  masterKey: Buffer;
}

export type MaintenanceWorkerMessage =
  | { type: "progress"; stage: string; message: string }
  | { type: "result"; result: MaintenanceResult }
  | { type: "error"; message: string; result: MaintenanceResult | null };

export class MaintenanceWorkerError extends Error {
  readonly result: MaintenanceResult | null;
  constructor(message: string, result: MaintenanceResult | null) {
    super(message);
    this.name = "MaintenanceWorkerError";
    this.result = result;
  }
}

export function runMaintenanceWorker(
  input: MaintenanceRequest,
  config: MaintenanceWorkerConfig,
  onProgress: (stage: string, message: string) => void,
): Promise<MaintenanceResult> {
  return new Promise((resolve, reject) => {
    const source = import.meta.url.endsWith(".ts");
    const worker = new Worker(new URL(source ? "./worker.ts" : "./worker.js", import.meta.url), {
      workerData: { input, config },
      execArgv: source ? ["--experimental-strip-types"] : [],
    });
    let result: MaintenanceResult | undefined;
    let failure: Error | undefined;
    worker.on("message", (message: MaintenanceWorkerMessage) => {
      if (message.type === "progress") onProgress(message.stage, message.message);
      else if (message.type === "result") result = message.result;
      else failure = new MaintenanceWorkerError(message.message, message.result);
    });
    worker.on("error", error => { failure = error; });
    worker.once("exit", code => {
      if (failure) reject(failure);
      else if (code !== 0 || result === undefined) reject(new MaintenanceWorkerError("维护进程未能完成，请查看服务日志。", result ?? null));
      else resolve(result);
    });
  });
}
