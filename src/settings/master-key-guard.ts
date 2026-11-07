// SPDX-License-Identifier: MIT
import type { DatabaseSync } from "node:sqlite";
import { RuntimeSecretCipher } from "./crypto.ts";

/** Verify or establish the instance key before committing encrypted settings. */
export function ensureRuntimeMasterKeyGuard(connection: DatabaseSync, cipher: RuntimeSecretCipher, now = Date.now()): void {
  if (!connection.isTransaction) throw new Error("master key initialization requires a transaction");
  const existing = connection.prepare(`SELECT cipher_version, nonce, ciphertext, authentication_tag
    FROM runtime_master_key_guard WHERE singleton_key = 1`).get() as {
      cipher_version: number | bigint; nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array;
    } | undefined;
  if (existing) {
    cipher.verifyGuard({ cipherVersion: Number(existing.cipher_version) as 1, nonce: Buffer.from(existing.nonce),
      ciphertext: Buffer.from(existing.ciphertext), authenticationTag: Buffer.from(existing.authentication_tag) });
    return;
  }
  const sources = [
    ["runtime_secrets", ""], ["provider_application_key_changes", " WHERE state = 'PENDING'"],
    ["site_secrets", ""], ["epay_credentials", ""], ["alipay_account_secrets", ""],
    ["alipay_application_key_changes", " WHERE state = 'PENDING'"],
  ] as const;
  for (const [table, condition] of sources) {
    const exists = connection.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table);
    if (exists && connection.prepare(`SELECT 1 FROM ${table}${condition} LIMIT 1`).get()) {
      throw new Error("runtime master key guard is missing while encrypted settings still exist");
    }
  }
  const encrypted = cipher.createGuard();
  const inserted = connection.prepare(`INSERT INTO runtime_master_key_guard (
    singleton_key, cipher_version, nonce, ciphertext, authentication_tag, created_at
  ) VALUES (1, ?, ?, ?, ?, ?)`).run(encrypted.cipherVersion, encrypted.nonce,
    encrypted.ciphertext, encrypted.authenticationTag, now);
  if (Number(inserted.changes) !== 1) throw new Error("master key guard was not initialized");
}
