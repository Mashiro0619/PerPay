// SPDX-License-Identifier: MIT
import type { EpayProtocol } from "./protocol.ts";

/** Authenticated compatibility data captured with the core order transaction. */
export interface EpayOrderCreation {
  readonly siteId: string;
  readonly protocol: EpayProtocol;
  readonly configurationRevision: number;
  readonly requestFingerprint: string;
  readonly param: string | null;
  readonly returnUrl: string | null;
}
