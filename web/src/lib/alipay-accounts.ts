import {
  api,
  queryClient,
  result,
  type AlipayAccount as AccountResponse,
  type SiteCollection,
} from "@/api/client";
export type { SiteCollection } from "@/api/client";

export type AlipayAccount = AccountResponse;

export const alipayAccountsKey = ["alipay-accounts"] as const;
export const alipayAccountKey = (id: string) =>
  [...alipayAccountsKey, id] as const;
export const alipayAccountsQuery = {
  queryKey: alipayAccountsKey,
  queryFn: async ({
    signal,
  }: {
    signal: AbortSignal;
  }): Promise<{ data: AlipayAccount[] }> =>
    result(api.listAlipayAccounts({ signal })),
};

export async function accountSaved(account: AlipayAccount) {
  await queryClient.cancelQueries({
    queryKey: alipayAccountKey(account.id),
    exact: true,
  });
  queryClient.setQueryData(alipayAccountKey(account.id), { data: account });
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: alipayAccountsKey, exact: true }),
    queryClient.invalidateQueries({ queryKey: ["settings"] }),
    queryClient.invalidateQueries({ queryKey: ["status"] }),
  ]);
}

export function defaultSiteCollection(
  accounts: readonly AlipayAccount[],
): SiteCollection {
  const available = accounts.filter(
    (account) => account.enabled && account.configured,
  );
  return {
    mode: "FIXED",
    accounts:
      available.length === 1
        ? [{ account_id: available[0]!.id, weight: 1 }]
        : [],
  };
}

export function accountState(account: AlipayAccount): string {
  if (!account.configured) return "配置未完成";
  return account.enabled ? "接收新订单" : "已暂停新订单";
}

export function accountHealth(account: AlipayAccount): string {
  if (!account.configured) return "待完成配置";
  if (!account.health) return "尚未查账";
  if (
    account.health.last_error_code ||
    account.health.state === "degraded" ||
    account.health.state === "failed"
  )
    return "查账异常";
  if (
    account.health.state === "running" ||
    account.health.state === "catching_up"
  )
    return "查账中";
  return account.health.last_success_at ? "查账正常" : "等待查账";
}
