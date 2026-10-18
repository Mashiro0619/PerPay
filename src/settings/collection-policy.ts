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
  if (active > input.scan_interval_seconds) context.addIssue({ code: "custom", path: ["active_scan_interval_seconds"], message: "活跃查账间隔不能大于常规查账间隔。" });
  if (input.minimum_scan_interval_seconds !== undefined && input.minimum_scan_interval_seconds > active) context.addIssue({ code: "custom", path: ["minimum_scan_interval_seconds"], message: "最小查账间隔不能大于活跃查账间隔。" });
  if (input.maximum_success_age_seconds < input.scan_interval_seconds * 2) context.addIssue({ code: "custom", path: ["maximum_success_age_seconds"], message: "查账有效时限至少要是常规查账间隔的两倍。" });
  if (input.safety_lag_seconds > input.maximum_success_age_seconds) context.addIssue({ code: "custom", path: ["safety_lag_seconds"], message: "查账延迟不能超过查账有效时限。" });
}

export const collectionPolicyInputSchema = z.object({
  revision: z.number().int().nonnegative(),
  ...collectionPolicyFields,
}).strict().superRefine(validateCollectionPolicy);
export type CollectionPolicyInput = z.infer<typeof collectionPolicyInputSchema>;
