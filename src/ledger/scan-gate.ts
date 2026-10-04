import type { AppDatabase } from "../database/database.ts";
export interface LedgerScanGate { completedAt: number; protectedUntil: number; continuation: boolean; }
/** Account-scoped schedule state survives configuration reloads and process restarts. */
export function ledgerScanGate(database: AppDatabase, accountKey: string) {
 return {
  read(): LedgerScanGate | null { return database.read(connection => {
   const row = connection.prepare("SELECT completed_at, protected_until, continuation FROM ledger_scan_gate WHERE provider_account_key = ?").get(accountKey) as {completed_at:number|bigint;protected_until:number|bigint;continuation:number|bigint}|undefined;
   return row ? {completedAt:Number(row.completed_at),protectedUntil:Number(row.protected_until),continuation:Number(row.continuation)===1}:null;
  }); },
  write(state:LedgerScanGate):void { database.write(connection => connection.prepare("INSERT INTO ledger_scan_gate(provider_account_key,completed_at,protected_until,continuation) VALUES(?,?,?,?) ON CONFLICT(provider_account_key) DO UPDATE SET completed_at=excluded.completed_at,protected_until=excluded.protected_until,continuation=excluded.continuation").run(accountKey,state.completedAt,state.protectedUntil,state.continuation?1:0)); }
 };
}
