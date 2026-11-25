import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { MAX_ORDER_CLOCK_AHEAD_MILLISECONDS } from "../orders/model.ts";
import type { AppDatabase } from "./database.ts";

type DatabaseOwner = Pick<AppDatabase, "read" | "write">;

export class OrderClockError extends Error {
  constructor() {
    super("order clock is out of sync with the system clock");
    this.name = "OrderClockError";
  }
}

export class OrderClock {
  readonly #wallClockAnchorMs = Date.now();
  readonly #monotonicAnchorMs = performance.now();

  read(connection: DatabaseSync): number {
    const row = connection
      .prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now_ms")
      .get() as { now_ms: bigint | number };
    const physicalNow = Number(row.now_ms);
    if (!Number.isSafeInteger(physicalNow) || physicalNow < 0) {
      throw new RangeError("order clock must return a non-negative safe integer");
    }
    const expectedPhysical = this.#wallClockAnchorMs + (performance.now() - this.#monotonicAnchorMs);
    if (Math.abs(physicalNow - expectedPhysical) > MAX_ORDER_CLOCK_AHEAD_MILLISECONDS) {
      throw new OrderClockError();
    }
    return physicalNow;
  }
}

const clocks = new WeakMap<DatabaseOwner, OrderClock>();

/** 同一数据库的订单和对账共用时间锚，重建网站作用域不会刷新它。 */
export function orderClockForDatabase(database: DatabaseOwner): OrderClock {
  let clock = clocks.get(database);
  if (!clock) {
    clock = new OrderClock();
    clocks.set(database, clock);
  }
  return clock;
}
