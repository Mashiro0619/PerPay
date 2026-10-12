import { useState } from "react";
import { isReleaseVersion, isPrereleaseVersion } from "../../src/shared/release-version";
import { X, ArrowUpCircle, ChevronDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, queryClient, result, sessionKey } from "@/api/client";
import { dateTime } from "@/lib/format";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Alert,
  AlertTitle,
  AlertAction,
} from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
export const officialUpdateKey = ["official-update"] as const;
const upgradeGuide =
  "https://github.com/Mashiro0619/PerPay/blob/main/README.md#更新";
function useOfficialUpdate() {
  return useQuery({
    queryKey: officialUpdateKey,
    queryFn: async ({ signal }) => {
      const response = await result(api.checkOfficialUpdate({ signal }));
      const data = response?.data;
      if (
        !data ||
        !isReleaseVersion(data.current_version) ||
        !isReleaseVersion(data.latest_version) ||
        (!isPrereleaseVersion(data.current_version) && isPrereleaseVersion(data.latest_version)) ||
        !["update_available", "up_to_date", "ahead"].includes(data.status) ||
        data.release_url !==
          "https://github.com/Mashiro0619/PerPay/releases/tag/v" +
            data.latest_version ||
        !Number.isFinite(Date.parse(data.checked_at)) ||
        !Number.isFinite(Date.parse(data.published_at))
      ) {
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

export function OfficialUpdateNotice({
  hidden = false,
  className,
}: {
  hidden?: boolean;
  className?: string | undefined;
}) {
  const update = useOfficialUpdate();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const data = update.data?.data;
  if (
    hidden ||
    update.isFetching ||
    update.isError ||
    data?.status !== "update_available" ||
    dismissedVersion === data.latest_version
  )
    return null;
  return (
    <Alert className={className} role="status" aria-label="官方版本更新">
      <ArrowUpCircle />
      <AlertTitle>
        有新版本 v{data.latest_version}{isPrereleaseVersion(data.latest_version) ? "（预发布）" : ""} ·{" "}
        <a data-external-link href={data.release_url} target="_blank" rel="noopener noreferrer">
          查看更新
        </a>
      </AlertTitle>
      <AlertAction>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="关闭更新提示"
          onClick={() => setDismissedVersion(data.latest_version)}
        >
          <X />
        </Button>
      </AlertAction>
    </Alert>
  );
}
function retryWait(seconds: number) {
  if (seconds > 0 && seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  if (seconds > 0 && seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

export function OfficialUpdatePanel({ currentVersion }: { currentVersion?: string }) {
  const update = useOfficialUpdate();
  const checking = update.isFetching || update.isPending;
  const data = !checking && !update.isError ? update.data?.data : undefined;
  const lastKnownVersion = update.data?.data.current_version;
  const knownVersion = isReleaseVersion(currentVersion)
    ? currentVersion
    : isReleaseVersion(lastKnownVersion) ? lastKnownVersion : undefined;
  const prereleaseChannel = isPrereleaseVersion(data?.current_version);
  const latestIsPrerelease = isPrereleaseVersion(data?.latest_version);
  const latestLabel = latestIsPrerelease ? "官方预发布版" : "官方稳定版";
  const retryAfter =
    update.error instanceof ApiError ? update.error.retryAfter : null;
  const status = checking
    ? "正在检查更新…"
    : update.isError
      ? "暂时无法检查更新，不影响收款。"
      : data?.status === "update_available"
        ? "有可用更新：v" + data.latest_version + (latestIsPrerelease ? "（预发布）" : "")
        : data?.status === "ahead"
          ? prereleaseChannel ? "当前版本高于官方已发布版本。" : "当前版本高于官方稳定版。"
          : prereleaseChannel ? "已是当前通道最新版本。" : "已是最新稳定版。";
  return (
    <section className="system-update-strip" aria-label="官方更新">
      <Collapsible>
        <div className="system-update-main">
          <div className="system-update-summary">
            <h2>官方更新</h2>
            {knownVersion && (
              <span className="system-update-current">
                <span>当前版本</span>{" "}
                <span className="font-mono">v{knownVersion}</span>
                {isPrereleaseVersion(knownVersion) && <span>（预发布）</span>}
              </span>
            )}
            <p role="status" className="system-update-status">
              <span>{status}</span>
              {!checking && update.isError && retryAfter !== null && (
                <span> 请至少等待 {retryWait(retryAfter)}后重试。</span>
              )}
            </p>
          </div>
          <div className="system-update-actions">
            <Button
              variant="ghost"
              size="sm"
              disabled={update.isFetching}
              onClick={() => {
                void update.refetch();
              }}
            >
              {update.isFetching && (
                <Spinner aria-hidden="true" data-icon="inline-start" />
              )}
              检查更新
            </Button>
            {data && (
              <>
                <a
                  data-external-link
                  aria-label="查看发布说明"
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                  href={data.release_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  发布说明
                </a>
                <a
                  data-external-link
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                  href={upgradeGuide}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  更新方法
                </a>
                <CollapsibleTrigger
                  render={<Button variant="ghost" size="sm" className="group" />}
                >
                  发布信息
                  <ChevronDown data-icon="inline-end" className="transition-transform group-aria-expanded:rotate-180" />
                </CollapsibleTrigger>
              </>
            )}
          </div>
        </div>
        {data?.status === "update_available" && (
          <p className="system-update-note">更新前请备份数据库和主密钥。</p>
        )}
        {data && (
          <CollapsibleContent className="system-update-details">
            <p>
              <span>{latestLabel}</span>{" "}
              <span className="font-mono">v{data.latest_version}</span>
            </p>
            <p>
              <span>发布时间</span>{" "}
              <time dateTime={data.published_at}>{dateTime(data.published_at)}</time>
            </p>
            <p>
              <span>检查时间</span>{" "}
              <time dateTime={data.checked_at}>{dateTime(data.checked_at)}</time>
            </p>
            {prereleaseChannel && (
              <p>
                当前使用预发布版本，同时检查正式版和预发布版。
              </p>
            )}
          </CollapsibleContent>
        )}
      </Collapsible>
    </section>
  );
}
