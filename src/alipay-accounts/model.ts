import { z } from "zod";
import { collectionCodeError } from "../shared/collection-code.ts";
import type { ProviderApplicationKeyChange, ProviderSettings } from "../settings/model.ts";

export const alipayAccountIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/);
const fields = {
  name: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u),
  enabled: z.boolean(),
  code_payload: z.string().trim().refine(value => collectionCodeError(value) === null, "请填写有效的支付宝收款码内容。").nullable(),
  environment: z.enum(["PRODUCTION", "SANDBOX"]),
  app_id: z.string().trim().regex(/^[A-Za-z0-9._-]{1,64}$/).nullable(),
  platform_public_key: z.string().trim().min(1).max(16 * 1024).nullable().optional(),
  private_key: z.string().trim().min(1).max(16 * 1024).optional(),
};
export const createAlipayAccountInputSchema = z.object({
  ...fields, enabled: fields.enabled.default(true), code_payload: fields.code_payload.default(null),
  environment: fields.environment.default("PRODUCTION"), app_id: fields.app_id.default(null),
}).strict();
export const updateAlipayAccountInputSchema = z.object({ ...fields, revision: z.number().int().nonnegative() }).strict();
export const alipayAccountRevisionSchema = z.object({ revision: z.number().int().nonnegative() }).strict();
export type CreateAlipayAccountInput = z.input<typeof createAlipayAccountInputSchema>;
export type UpdateAlipayAccountInput = z.input<typeof updateAlipayAccountInputSchema>;
export interface AlipayAccountSnapshot {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly codePayload: string | null;
  readonly environment: "PRODUCTION" | "SANDBOX";
  readonly appId: string | null;
  readonly platformPublicKey: string | null;
  readonly providerAccountKey: string | null;
  readonly provider: ProviderSettings | null;
  readonly configured: boolean;
  readonly applicationKey: import("../settings/model.ts").ProviderApplicationKeyMaterial | null;
  readonly pendingApplicationKey: ProviderApplicationKeyChange | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface AlipayAccountView {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly code_payload: string | null;
  readonly environment: "PRODUCTION" | "SANDBOX";
  readonly app_id: string | null;
  readonly platform_public_key: string | null;
  readonly provider_account_key: string | null;
  readonly configured: boolean;
  readonly application_public_key: string | null;
  readonly application_key_fingerprint: string | null;
  readonly pending_application_key: {
    readonly change_id: string; readonly public_key: string; readonly fingerprint: string;
    readonly app_id: string; readonly environment: "PRODUCTION" | "SANDBOX"; readonly created_at: string;
  } | null;
  readonly sites: readonly { readonly client_id: string; readonly name: string }[];
  readonly deletable: boolean;
  readonly last_check: {readonly ok: boolean; readonly checked_at: string; readonly message: string} | null;
  readonly created_at: string;
  readonly updated_at: string;
}
export class AlipayAccountError extends Error {
  readonly code: "alipay_account_not_found" | "alipay_account_revision_conflict" |
    "alipay_account_in_use" | "alipay_account_app_conflict" | "alipay_account_not_configured";
  constructor(code: AlipayAccountError["code"], message: string) {
    super(message);
    this.name = "AlipayAccountError";
    this.code = code;
  }
}
