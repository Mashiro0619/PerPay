import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  collectionSettingsInputSchema,
  displaySettingsInputSchema,
  parseWebhookOrigin,
  webhookSettingsInputSchema,
} from "../settings/model.ts";

/** A website identity is independent of its credentials and collection source. */
export const siteClientIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/);
const revisionSchema = z.number().int().nonnegative();
const nameSchema = displaySettingsInputSchema.shape.system_name.unwrap();

export const siteCollectionSchema = z.object({
  mode: z.enum(["FIXED", "RANDOM", "WEIGHTED"]),
  accounts: z.array(z.object({
    account_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/),
    weight: z.number().int().min(1).max(1_000_000).default(1),
  }).strict()).min(1).max(100),
}).strict().superRefine((input, context) => {
  if (input.mode === "FIXED" && input.accounts.length !== 1) {
    context.addIssue({ code: "custom", path: ["accounts"], message: "指定收款账号时请选择一个账号。" });
  }
  if (new Set(input.accounts.map(account => account.account_id)).size !== input.accounts.length) {
    context.addIssue({ code: "custom", path: ["accounts"], message: "收款账号不能重复选择。" });
  }
});
export type SiteCollection = z.infer<typeof siteCollectionSchema>;

export const siteOrderPolicySchema = z.object({
  order_ttl_seconds: collectionSettingsInputSchema.shape.order_ttl_seconds,
  amount_offset_maximum_cents: collectionSettingsInputSchema.shape.amount_offset_maximum_cents,
  amount_reuse_cooldown_seconds: collectionSettingsInputSchema.shape.amount_reuse_cooldown_seconds.unwrap(),
  pending_order_limit: z.number().int().positive().nullable(),
}).strict();

export const siteDisplaySchema = z.object({
  checkout_name: nameSchema,
  checkout_help_url: displaySettingsInputSchema.shape.checkout_help_url.unwrap(),
  checkout_show_product_name: z.boolean(),
}).strict();

export const siteNotificationPolicySchema = z.object({
  timeout_milliseconds: webhookSettingsInputSchema.shape.timeout_milliseconds,
  maximum_attempts: webhookSettingsInputSchema.shape.maximum_attempts,
  retry_base_seconds: webhookSettingsInputSchema.shape.retry_base_seconds,
  retry_maximum_seconds: webhookSettingsInputSchema.shape.retry_maximum_seconds,
}).strict().superRefine((input, context) => {
  if (input.retry_maximum_seconds < input.retry_base_seconds) {
    context.addIssue({ code: "custom", path: ["retry_maximum_seconds"], message: "最大重试间隔不能小于基础重试间隔。" });
  }
});

/** Complete creation defaults; never a runtime fallback for an existing site. */
export const sitePolicySchema = z.object({
  orders: siteOrderPolicySchema,
  display: siteDisplaySchema,
  notification_delivery: siteNotificationPolicySchema,
}).strict();

const originSchema = z.string().transform((value, context) => {
  try {
    return parseWebhookOrigin(value);
  } catch {
    context.addIssue({ code: "custom", message: "请填写有效的公网 HTTPS 来源，不包含路径、端口或通配符。" });
    return z.NEVER;
  }
}).nullable();

export const siteConfigurationSchema = z.object({
  name: nameSchema,
  accepting_orders: z.boolean(),
  notifications_enabled: z.boolean(),
  notification_origin: originSchema,
  return_origin: originSchema,
  // Older administrator clients may omit this; the store resolves a sole account.
  collection: siteCollectionSchema.optional(),
  policy: sitePolicySchema,
}).strict().superRefine((input, context) => {
  if (input.notifications_enabled && input.notification_origin === null) {
    context.addIssue({ code: "custom", path: ["notification_origin"], message: "开启通知前必须配置通知来源。" });
  }
});

export const createSiteInputSchema = z.object({
  operation_id: z.uuid(),
  configuration: siteConfigurationSchema,
}).strict();
export const updateSiteInputSchema = z.object({
  revision: revisionSchema,
  configuration: siteConfigurationSchema,
}).strict();
export const updateSiteDefaultsInputSchema = z.object({
  revision: revisionSchema,
  policy: sitePolicySchema,
}).strict();

export type SitePolicy = z.infer<typeof sitePolicySchema>;
export type SiteConfiguration = z.infer<typeof siteConfigurationSchema>;
export interface SiteSnapshot {
  readonly clientId: string;
  readonly revision: number;
  readonly configuration: SiteConfiguration;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
}

export function generateSiteClientId(): string {
  return "site_" + randomUUID();
}

/** Parse returns a detached copy, so form edits cannot mutate the template. */
export function copySiteDefaults(policy: SitePolicy): SitePolicy {
  return sitePolicySchema.parse(policy);
}
