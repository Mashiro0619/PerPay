import {
  api,
  queryClient,
  result,
  type AlipayAccount as AccountResponse,
  type SiteCollection,
} from "@/api/client";
export type { SiteCollection } from "@/api/client";

export type AlipayAccount = AccountResponse;

export function accountChoiceLabel(account: AlipayAccount, accounts: readonly AlipayAccount[]): string {
  const duplicates = accounts.filter(item => item.name === account.name);
  if (duplicates.length < 2) return account.name;
  if (account.app_id && duplicates.every(item => item.id === account.id || item.app_id !== account.app_id)) {
    return `${account.name} · App ID ${account.app_id}`;
  }
  const compact = (id: string, length: number) => id.replace(/^alipay_/, "").slice(0, length);
  let length = 8;
  const collides = () => duplicates.some(item => item.id !== account.id && compact(item.id, length) === compact(account.id, length));
  while (length < account.id.length && collides()) length += 4;
  return account.name + " · " + (collides() ? account.id : compact(account.id, length));
}

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
  // The write is confirmed and its snapshot is cached. Background reads must
  // not keep the editor's mutation/navigation lock pending if one stalls.
  void Promise.all([
    queryClient.invalidateQueries({ queryKey: alipayAccountsKey, exact: true }),
    queryClient.invalidateQueries({ queryKey: ["settings"] }),
    queryClient.invalidateQueries({ queryKey: ["status"] }),
  ]);
}

export function defaultSiteCollection(
  accounts: readonly AlipayAccount[],
): SiteCollection {
  const available = accounts.filter(
    (account) => account.environment === "PRODUCTION" && account.enabled && account.configured,
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
  if (account.environment !== "PRODUCTION") return "旧版账号已停用";
  if (!account.configured) return "配置未完成";
  return account.enabled ? "接收新订单" : "已暂停新订单";
}

export function accountHealth(account: AlipayAccount): string {
  if (account.environment !== "PRODUCTION") return "不再查账";
  if (!account.configured) return "待完成配置";
  if (!account.health) return "尚未查账";
  const compensationContinuing = account.health.last_error_code === "compensation_continuation";
  if (
    (account.health.last_error_code && !compensationContinuing) ||
    account.health.state === "degraded" ||
    account.health.state === "failed"
  )
    return "查账异常";
  if (compensationContinuing) return account.health.collection_ready ? "查账正常 · 历史补扫中" : "历史补扫中";
  if (
    account.health.state === "running" ||
    account.health.state === "catching_up"
  )
    return "查账中";
  return account.health.last_success_at ? "查账正常" : "等待查账";
}
