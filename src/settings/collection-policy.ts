import { z } from "zod";

/** PerPay scheduling policy, not Alipay application credentials. */
export const collectionPolicyFields = {
  timeout_milliseconds: z.number().int().min(1_000).max(120_000),
  scan_interval_seconds: z.number().int().min(5).max(3_600),
  active_scan_interval_seconds: z.number().int().min(5).max(3_600),
  minimum_scan_interval_seconds: z.number().int().min(5).max(3_600),
  safety_lag_seconds: z.number().int().min(5).max(300),
  maximum_success_age_seconds: z.number().int().min(10).max(86_400),
};

export function validateCollectionPolicy(input: {
  scan_interval_seconds: number;
  active_scan_interval_seconds?: number | undefined;
  minimum_scan_interval_seconds?: number | undefined;
  safety_lag_seconds: number;
  maximum_success_age_seconds: number;
}, context: z.RefinementCtx): void {
  const active = input.active_scan_interval_seconds ?? input.scan_interval_seconds;
  if (active > input.scan_interval_seconds) context.addIssue({ code: "custom", path: ["active_scan_interval_seconds"], message: "must not exceed the normal scan interval" });
  if (input.minimum_scan_interval_seconds !== undefined && input.minimum_scan_interval_seconds > active) context.addIssue({ code: "custom", path: ["minimum_scan_interval_seconds"], message: "最小采集间隔不能大于活跃采集间隔，请明确调整最小间隔。" });
  if (input.maximum_success_age_seconds < input.scan_interval_seconds * 2) context.addIssue({ code: "custom", path: ["maximum_success_age_seconds"], message: "must be at least twice the scan interval" });
  if (input.safety_lag_seconds > input.maximum_success_age_seconds) context.addIssue({ code: "custom", path: ["safety_lag_seconds"], message: "must not exceed the maximum success age" });
}

export const collectionPolicyInputSchema = z.object({
  revision: z.number().int().nonnegative(),
  ...collectionPolicyFields,
}).strict().superRefine(validateCollectionPolicy);
export type CollectionPolicyInput = z.infer<typeof collectionPolicyInputSchema>;
