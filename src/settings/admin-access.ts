import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createIpPolicy } from "../infrastructure/network/ip-policy.ts";
export const adminAccessSchema = z
  .object({
    enabled: z.boolean(),
    cidrs: z.array(z.string().trim().min(1)).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (Buffer.byteLength(value.cidrs.join("\n"), "utf8") > 8192)
      context.addIssue({
        code: "custom",
        path: ["cidrs"],
        message: "白名单不能超过 8 KiB",
      });
    try {
      createAdminAccessPolicy(value.cidrs);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["cidrs"],
        message: "请输入有效 IP 或 CIDR，不能使用 /0 全网规则",
      });
    }
    if (value.enabled && value.cidrs.length === 0)
      context.addIssue({
        code: "custom",
        path: ["cidrs"],
        message: "启用时至少需要一条规则",
      });
  });
export const adminAccessInputSchema = adminAccessSchema.safeExtend({
  revision: z.number().int().nonnegative(),
});
export type AdminAccess = z.infer<typeof adminAccessSchema>;
export type AdminAccessInput = z.infer<typeof adminAccessInputSchema>;

export function readAdminAccess(connection: DatabaseSync): AdminAccess {
  const row = connection
    .prepare(
      "SELECT admin_access FROM runtime_configuration WHERE singleton_key = 1",
    )
    .get() as { admin_access: string } | undefined;
  if (!row) throw new Error("runtime configuration singleton is missing");
  return adminAccessSchema.parse(JSON.parse(row.admin_access));
}

export function createAdminAccessPolicy(cidrs: readonly string[]) {
  return createIpPolicy(cidrs, true);
}
