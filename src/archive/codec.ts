import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import type { SQLOutputValue } from "node:sqlite";

export type ArchiveSourceRow = Record<string, SQLOutputValue>;

export function archiveRecordKey(row: ArchiveSourceRow, primaryKey: readonly string[]): string {
  return JSON.stringify(primaryKey.map(column => {
    const value = row[column];
    return value instanceof Uint8Array ? Buffer.from(value).toString("hex") : typeof value === "bigint" ? value.toString() : value;
  }));
}

export function encodeArchiveRecord(row: ArchiveSourceRow): { payload: Buffer; sha256: string; rawBytes: number } {
  const values = Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    value instanceof Uint8Array ? { $blob: Buffer.from(value).toString("base64") } : typeof value === "bigint" ? { $integer: value.toString() } : value,
  ]));
  const bytes = Buffer.from(JSON.stringify(values));
  return { payload: gzipSync(bytes), sha256: createHash("sha256").update(bytes).digest("hex"), rawBytes: bytes.length };
}

export function decodeArchiveRecord(payload: Uint8Array, expectedSha256: string, rawBytes: number): ArchiveSourceRow {
  const bytes = gunzipSync(payload, { maxOutputLength: rawBytes });
  if (bytes.length !== rawBytes || createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    throw new Error("归档记录校验失败。");
  }
  const values = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
    value !== null && typeof value === "object" && "$blob" in value ? Buffer.from(String(value.$blob), "base64") :
    value !== null && typeof value === "object" && "$integer" in value ? BigInt(String(value.$integer)) : value,
  ])) as ArchiveSourceRow;
}

export function hashArchiveFile(path: string): string {
  const hash = createHash("sha256");
  const handle = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let size: number;
    while ((size = readSync(handle, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
    return hash.digest("hex");
  } finally { closeSync(handle); }
}
