import { Worker } from "node:worker_threads";

const START_TIMEOUT_MILLISECONDS = 10_000;
const STOP_TIMEOUT_MILLISECONDS = 10_000;

type HeartbeatMessage =
  | { readonly kind: "ready" }
  | { readonly kind: "lost"; readonly message: string }
  | { readonly kind: "stopped" };

export interface StartupLeaseHeartbeatOptions {
  readonly databasePath: string;
  readonly leaseKey: number;
  readonly leaseToken: string;
  readonly leaseTtlMilliseconds: number;
  readonly intervalMilliseconds: number;
  readonly sqliteTimeoutMilliseconds: number;
}

/** Keeps the database lease alive while synchronous startup work blocks the main thread. */
export class StartupLeaseHeartbeat {
  readonly #worker: Worker;
  #failure: Error | null = null;
  #stopped = false;

  private constructor(worker: Worker) {
    this.#worker = worker;
    worker.on("message", (message: HeartbeatMessage) => {
      if (message.kind === "lost" && this.#failure === null) {
        this.#failure = new Error(message.message);
      }
    });
    worker.on("error", (error) => {
      if (this.#failure === null) this.#failure = error;
    });
    worker.on("exit", (code) => {
      if (!this.#stopped && code !== 0 && this.#failure === null) {
        this.#failure = new Error(`startup lease heartbeat exited with code ${code}`);
      }
    });
  }

  static async start(options: StartupLeaseHeartbeatOptions): Promise<StartupLeaseHeartbeat> {
    validateOptions(options);
    const worker = new Worker(heartbeatWorkerSource, {
      eval: true,
      workerData: options,
    });
    const heartbeat = new StartupLeaseHeartbeat(worker);
    try {
      await waitForMessage(worker, "ready", START_TIMEOUT_MILLISECONDS);
      heartbeat.assertHealthy();
      return heartbeat;
    } catch (error) {
      heartbeat.#stopped = true;
      await worker.terminate().catch(() => undefined);
      throw error;
    }
  }

  assertHealthy(): void {
    if (this.#failure !== null) {
      throw new Error("database lease was lost during startup", { cause: this.#failure });
    }
    if (this.#stopped) throw new Error("startup lease heartbeat is already stopped");
  }

  async stop(renewBeforeStopping: boolean): Promise<void> {
    if (this.#stopped) return;
    if (!renewBeforeStopping) {
      this.#stopped = true;
      await this.#worker.terminate();
      return;
    }
    this.assertHealthy();
    const stopped = waitForMessage(this.#worker, "stopped", STOP_TIMEOUT_MILLISECONDS);
    this.#worker.postMessage({ kind: "stop", renewBeforeStopping });
    try {
      await stopped;
      this.assertHealthy();
    } finally {
      this.#stopped = true;
      await this.#worker.terminate().catch(() => undefined);
    }
  }
}

function validateOptions(options: StartupLeaseHeartbeatOptions): void {
  if (options.databasePath.length === 0 || options.leaseToken.length === 0) {
    throw new TypeError("startup lease heartbeat requires a database path and token");
  }
  for (const [label, value] of [
    ["lease key", options.leaseKey],
    ["lease TTL", options.leaseTtlMilliseconds],
    ["heartbeat interval", options.intervalMilliseconds],
    ["SQLite timeout", options.sqliteTimeoutMilliseconds],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${label} must be a positive safe integer`);
    }
  }
  if (options.intervalMilliseconds * 2 >= options.leaseTtlMilliseconds) {
    throw new RangeError("startup lease heartbeat interval must be less than half the lease TTL");
  }
}

function waitForMessage(
  worker: Worker,
  expectedKind: HeartbeatMessage["kind"],
  timeoutMilliseconds: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`startup lease heartbeat timed out waiting for ${expectedKind}`));
    }, timeoutMilliseconds);
    timeout.unref();

    const onMessage = (message: HeartbeatMessage) => {
      if (message.kind === "lost") {
        cleanup();
        reject(new Error(message.message));
        return;
      }
      if (message.kind !== expectedKind) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`startup lease heartbeat exited before ${expectedKind} with code ${code}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };

    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
  });
}

const heartbeatWorkerSource = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  const { DatabaseSync } = require("node:sqlite");

  const connection = new DatabaseSync(workerData.databasePath, {
    timeout: workerData.sqliteTimeoutMilliseconds,
    readBigInts: true,
    defensive: true,
  });
  let stopped = false;

  function fail(message) {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try { connection.close(); } catch {}
    parentPort.postMessage({ kind: "lost", message });
  }

  function renew(failOnError = false) {
    if (stopped) return false;
    const now = Date.now();
    try {
      const result = connection.prepare(
        "UPDATE app_lease SET expires_at = ? WHERE lease_key = ? AND owner_token = ?",
      ).run(
        now + workerData.leaseTtlMilliseconds,
        workerData.leaseKey,
        workerData.leaseToken,
      );
      if (Number(result.changes) !== 1) {
        fail("database lease ownership changed during startup");
        return false;
      }
      return true;
    } catch (error) {
      if (failOnError) fail("database lease could not be renewed before heartbeat handoff");
      return false;
    }
  }

  const timer = setInterval(renew, workerData.intervalMilliseconds);
  parentPort.on("message", (message) => {
    if (message?.kind !== "stop" || stopped) return;
    if (message.renewBeforeStopping && !renew(true)) return;
    stopped = true;
    clearInterval(timer);
    connection.close();
    parentPort.postMessage({ kind: "stopped" });
  });

  if (renew()) parentPort.postMessage({ kind: "ready" });
`;
