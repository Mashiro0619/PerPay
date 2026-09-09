import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api, ApiError, queryClient, result, sessionKey } from "./api/client";
import { Button, Details, Notice, Panel } from "./components/ui";
import { dateTime } from "./lib/format";

export const officialUpdateKey = ["official-update"] as const;
const upgradeGuide = "https://github.com/Mashiro0619/PerPay/blob/main/README.md#更新";

function useOfficialUpdate() {
  return useQuery({
    queryKey: officialUpdateKey,
    queryFn: async ({ signal }) => {
      const response = await result(api.checkOfficialUpdate({ signal }));
      const data = response?.data;
      const stable = (value: unknown) => typeof value === "string" && value.length <= 64 && value.trim() === value && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
      if (!data || !stable(data.current_version) || !stable(data.latest_version) ||
          !["update_available", "up_to_date", "ahead"].includes(data.status) ||
          data.release_url !== "https://github.com/Mashiro0619/PerPay/releases/tag/v" + data.latest_version ||
          !Number.isFinite(Date.parse(data.checked_at)) || !Number.isFinite(Date.parse(data.published_at))) {
        throw new Error("官方更新响应无效，请稍后重试。");
      }
      return response;
    },
    // Removal during logout can notify a still-mounted observer; never start work for it.
    enabled: queryClient.getQueryData(sessionKey) != null,
    staleTime: Infinity,
    retry: false,
    retryOnMount: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    networkMode: "always",
  });
}

/** Mounted only inside the authenticated shell; logout clears the query and this dismissal. */
export function OfficialUpdateNotice({ hidden = false }: { hidden?: boolean }) {
  const update = useOfficialUpdate();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const data = update.data?.data;
  if (hidden || update.isFetching || update.isError || data?.status !== "update_available" || dismissedVersion === data.latest_version) return null;
  return <aside className="official-update-banner" role="status" aria-label="官方版本更新">
    <div><strong>发现新版本 v{data.latest_version}</strong><p>当前使用 v{data.current_version}。升级前请备份数据库和主密钥。</p></div>
    <div className="official-update-actions">
      <a className="button" href={data.release_url} target="_blank" rel="noopener noreferrer">查看更新</a>
      <Button variant="quiet" onClick={() => setDismissedVersion(data.latest_version)}>暂不提醒</Button>
    </div>
  </aside>;
}

export function OfficialUpdatePanel() {
  const update = useOfficialUpdate();
  const data = update.data?.data;
  const retryAfter = update.error instanceof ApiError ? update.error.retryAfter : null;
  return <Panel title="官方更新" description="登录后自动检查 GitHub 正式版，结果最多缓存 5 分钟；不会自动升级。" className="content-panel official-update-panel"
    action={<Button pending={update.isFetching} onClick={() => { void update.refetch(); }}>检查更新</Button>}>
    {update.isFetching || update.isPending ? <p role="status">正在检查官方更新，不影响后台使用…</p>
      : update.isError ? <Notice tone="warning">暂时无法检查官方更新，不影响后台使用或收款。请检查服务器能否访问 GitHub，稍后重试。{retryAfter !== null && <p>请至少等待 {retryAfter} 秒后重试。</p>}</Notice>
      : data && <>
        <p role="status">{data.status === "update_available" ? "有可用更新：v" + data.latest_version : data.status === "ahead" ? "当前版本高于官方稳定版，无需降级。" : "当前已是最新稳定版。"}</p>
        <Details items={[["当前版本", "v" + data.current_version], ["官方稳定版", "v" + data.latest_version], ["发布时间", dateTime(data.published_at)], ["检查时间", dateTime(data.checked_at)]]} />
        <div className="official-update-actions"><a href={data.release_url} target="_blank" rel="noopener noreferrer">查看发布说明</a><a href={upgradeGuide} target="_blank" rel="noopener noreferrer">更新方法</a></div>
      </>}
  </Panel>;
}
