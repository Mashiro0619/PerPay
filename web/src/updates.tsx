import { useState } from "react";
import { isReleaseVersion, isPrereleaseVersion } from "../../src/shared/release-version";
import { X, ArrowUpCircle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, queryClient, result, sessionKey } from "@/api/client";
import { dateTime } from "@/lib/format";
import { DetailFields } from "@/components/detail/DetailPrimitives";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Card,
  CardHeader,
  CardTitle,
  CardAction,
  CardContent,
} from "@/components/ui/card";
import {
  Alert,
  AlertTitle,
  AlertDescription,
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
        <a href={data.release_url} target="_blank" rel="noopener noreferrer">
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
export function OfficialUpdatePanel() {
  const update = useOfficialUpdate();
  const data = update.data?.data;
  const prereleaseChannel = isPrereleaseVersion(data?.current_version);
  const latestIsPrerelease = isPrereleaseVersion(data?.latest_version);
  const retryAfter =
    update.error instanceof ApiError ? update.error.retryAfter : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          官方更新
        </CardTitle>
        <CardAction>
          <Button
            variant="outline"
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
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {update.isFetching || update.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            正在检查更新…
          </p>
        ) : update.isError ? (
          <Alert>
            <AlertDescription>
              暂时无法检查更新，不影响收款。
              {retryAfter !== null && <p>请至少等待 {retryAfter} 秒后重试。</p>}
            </AlertDescription>
          </Alert>
        ) : (
          data && (
            <>
              <p role="status" className="text-sm">
                {data.status === "update_available"
                  ? "有可用更新：v" + data.latest_version + (latestIsPrerelease ? "（预发布）" : "")
                  : data.status === "ahead"
                    ? prereleaseChannel ? "当前版本高于官方已发布版本。" : "当前版本高于官方稳定版。"
                    : prereleaseChannel ? "已是当前通道最新版本。" : "已是最新稳定版。"}
              </p>
              {prereleaseChannel && (
                <p className="text-sm text-muted-foreground">
                  当前使用预发布版本，同时检查正式版和预发布版。
                </p>
              )}
              <Collapsible>
                <CollapsibleTrigger
                  render={<Button variant="ghost" size="sm" />}
                >
                  版本信息
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="pt-4">
                    <DetailFields
                      items={[
                        ["当前版本", "v" + data.current_version],
                        [latestIsPrerelease ? "官方预发布版" : "官方稳定版", "v" + data.latest_version],
                        ["发布时间", dateTime(data.published_at)],
                        ["检查时间", dateTime(data.checked_at)],
                      ]}
                    />
                  </div>
                </CollapsibleContent>
              </Collapsible>
              {data.status === "update_available" && (
                <p className="text-sm text-muted-foreground">
                  更新前请备份数据库和主密钥。
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <a
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                  href={data.release_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  查看发布说明
                </a>
                <a
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                  href={upgradeGuide}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  更新方法
                </a>
              </div>
            </>
          )
        )}
      </CardContent>
    </Card>
  );
}
