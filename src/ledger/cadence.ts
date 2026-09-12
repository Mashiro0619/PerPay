import type { AppDatabase } from "../database/database.ts";

export interface LedgerScanCadence {
  readonly mode: "normal" | "active" | "tail";
  readonly intervalMilliseconds: number;
}

export interface LedgerScanCadenceOptions {
  readonly database: AppDatabase;
  readonly providerAccountKey: string;
  readonly normalIntervalMilliseconds: number;
  readonly activeIntervalMilliseconds: number;
  readonly safetyLagMilliseconds: number;
  readonly clock?: () => number;
}

/** Derives activity from durable orders, including expiries not yet materialized by a sweep. */
export class LedgerScanCadencePolicy {
  readonly #database: AppDatabase;
  readonly #providerAccountKey: string;
  readonly #normalIntervalMilliseconds: number;
  readonly #activeIntervalMilliseconds: number;
  readonly #tailMilliseconds: number;
  readonly #clock: () => number;

  constructor(options: LedgerScanCadenceOptions) {
    for (const interval of [options.normalIntervalMilliseconds, options.activeIntervalMilliseconds]) {
      if (!Number.isSafeInteger(interval) || interval < 5_000 || interval > 3_600_000) {
        throw new RangeError("ledger cadence interval is invalid");
      }
    }
    if (options.activeIntervalMilliseconds > options.normalIntervalMilliseconds) {
      throw new RangeError("active ledger interval exceeds normal interval");
    }
    if (!Number.isSafeInteger(options.safetyLagMilliseconds) ||
      options.safetyLagMilliseconds < 0 || options.safetyLagMilliseconds > 300_000) {
      throw new RangeError("ledger cadence safety lag is invalid");
    }
    this.#database = options.database;
    this.#providerAccountKey = options.providerAccountKey;
    this.#normalIntervalMilliseconds = options.normalIntervalMilliseconds;
    this.#activeIntervalMilliseconds = options.activeIntervalMilliseconds;
    this.#tailMilliseconds = Math.max(60_000, options.safetyLagMilliseconds + options.activeIntervalMilliseconds);
    this.#clock = options.clock ?? (() => Date.now());
  }

  current(): LedgerScanCadence {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("ledger cadence clock is invalid");
    const mode = this.#database.read((connection) => {
      const row = connection.prepare(
        `SELECT CASE
           WHEN EXISTS (
             SELECT 1
               FROM collection_profile_provider_accounts AS account
               JOIN payment_orders AS orders ON orders.collection_profile_id = account.profile_id
              WHERE account.provider_account_key = ?
                AND orders.payment_status = 'UNPAID'
                AND orders.checkout_status = 'OPEN'
                AND orders.expires_at > ?
           ) THEN 'active'
           -- EXPIRED.closed_at can be the later sweep time, not the actual expiry.
           WHEN EXISTS (
             SELECT 1
               FROM collection_profile_provider_accounts AS account
               JOIN payment_orders AS orders ON orders.collection_profile_id = account.profile_id
              WHERE account.provider_account_key = ?
                AND orders.payment_status = 'UNPAID'
                AND (CASE WHEN orders.checkout_status = 'CLOSED' THEN orders.closed_at ELSE orders.expires_at END) > ?
                AND (CASE WHEN orders.checkout_status = 'CLOSED' THEN orders.closed_at ELSE orders.expires_at END) <= ?
           ) THEN 'tail'
           ELSE 'normal'
         END AS mode`,
      ).get(this.#providerAccountKey, now, this.#providerAccountKey, now - this.#tailMilliseconds, now) as {
        mode: LedgerScanCadence["mode"];
      };
      return row.mode;
    });
    return Object.freeze({
      mode,
      intervalMilliseconds: mode === "normal" ? this.#normalIntervalMilliseconds : this.#activeIntervalMilliseconds,
    });
  }
}
