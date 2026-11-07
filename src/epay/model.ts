// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { SiteSnapshot } from "../sites/model.ts";

export type EpayProtocol = "epay_v1" | "epay_v2";
export type EpayCredentialPurpose = "v1_key" | "v2_merchant" | "v2_platform";

export const epayConfigurationInputSchema = z.object({
  revision: z.number().int().nonnegative(),
  v1_enabled: z.boolean(),
  v2_enabled: z.boolean(),
}).strict();

export interface EpaySiteSnapshot {
  readonly siteId: string;
  readonly clientId: string;
  readonly pid: string;
  readonly revision: number;
  readonly v1Enabled: boolean;
  readonly v2Enabled: boolean;
  readonly v1KeyVersion: number;
  readonly merchantKeyVersion: number;
  readonly platformKeyVersion: number;
  readonly merchantPublicKey: string | null;
  readonly platformPublicKey: string | null;
}

export interface EpayCredentials extends EpaySiteSnapshot {
  readonly site: SiteSnapshot;
  readonly v1Key: string | null;
  readonly merchantPrivateKey: string | null;
  readonly platformPrivateKey: string | null;
  readonly v1KeyId: string | null;
  readonly merchantKeyId: string | null;
  readonly platformKeyId: string | null;
  readonly v1Fingerprint: string | null;
  readonly merchantFingerprint: string | null;
  readonly platformFingerprint: string | null;
}

export interface EpayOrderMetadata {
  readonly orderId: string;
  readonly siteId: string;
  readonly pid: string;
  readonly protocol: EpayProtocol;
  readonly tradeNo: string;
  readonly param: string | null;
  readonly requestFingerprint: string;
  readonly returnUrl: string | null;
  readonly createdAt: number;
}

export interface InsertEpayOrderInput {
  readonly orderId: string;
  readonly siteId: string;
  readonly protocol: EpayProtocol;
  readonly param: string | null;
  readonly requestFingerprint: string;
  readonly returnUrl: string | null;
  readonly createdAt: number;
}

export interface EpayExportInput {
  readonly protocol: "native" | EpayProtocol;
  readonly siteRevision: number;
  readonly epayRevision: number;
}

export interface EpayExportSnapshot {
  readonly site: SiteSnapshot;
  readonly configuration: EpaySiteSnapshot;
  readonly credentials: EpayCredentials | null;
  readonly apiSecret: string | null;
  readonly webhookSecret: string | null;
}
