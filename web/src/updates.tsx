import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { isReleaseVersion, isPrereleaseVersion } from "../../src/shared/release-version";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, queryClient, result, sessionKey, type OfficialUpdate } from "@/api/client";
import { isUpdateChannel, setUpdatePreferences, useUpdatePreferences, type UpdateChannel } from "@/lib/update-preferences";
import { dismissUpdateVersion, restoreUpdateReminders, useUpdateReminder } from "@/lib/update-reminders";
import { UpdateDialog, type UpdateDialogRequest } from "@/components/update-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { CopyValue } from "@/components/copy-value";
export const officialUpdateKey = ["official-update", "prerelease"] as const;
const checkInterval = 6 * 60 * 60 * 1000;
const channels: { value: UpdateChannel; label: string }[] = [
  { value: "stable", label: "仅稳定版" },
  { value: "prerelease", label: "包含预发布版" },
];
export const upgradeGuide =
  "https://github.com/Mashiro0619/PerPay/blob/main/README.md#更新";
function retryDeadline(error: unknown, updatedAt: number): number {
  const seconds = error instanceof ApiError ? error.retryAfter : null;
  return seconds !== null && Number.isFinite(seconds)
    ? updatedAt + seconds * 1000 : 0;
}

function useUpdateOwner() {
  const preferences = useUpdatePreferences();
  const { channel, automatic } = preferences;
  const toastId = useId();
  const selection = useMemo(() => ({
    queryKey: ["official-update", channel] as const,
    active: false,
    pending: null as { manual: boolean } | null,
    wake: undefined as (() => void) | undefined,
    lastAttemptAt: null as number | null,
  }), [channel]);
  const [completedSelection, setCompletedSelection] = useState<typeof selection | null>(null);
  const [dialogRequest, setDialogRequest] = useState<(UpdateDialogRequest & { selection: typeof selection }) | null>(null);
  const update = useQuery({
    queryKey: selection.queryKey,
    queryFn: async ({ signal }) => {
      if (queryClient.getQueryData(sessionKey) == null) {
        throw new DOMException("当前不能检查更新。", "AbortError");
      }
      const response = await result(api.checkOfficialUpdate({
        signal,
        query: { channel, ...(selection.pending?.manual ? { refresh: true } : {}) },
      }));
      signal.throwIfAborted();
      const data = response?.data;
      if (
        !data ||
        !isReleaseVersion(data.current_version) ||
        !isReleaseVersion(data.latest_version) ||
        (channel === "stable" && isPrereleaseVersion(data.latest_version)) ||
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
    // Only this owner schedules requests; observers and global refreshes cannot start one.
    enabled: false,
    staleTime: Infinity,
    retry: false,
    retryOnMount: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    networkMode: "always",
  });
  const { refetch } = update;
  const showDetails = useCallback((data: OfficialUpdate, returnFocus: HTMLElement | null = null) => {
    if (!selection.active || queryClient.getQueryData(sessionKey) == null || data.status !== "update_available") return;
    setDialogRequest({ data, channel, returnFocus, selection });
  }, [channel, selection]);
  const clearDialogRequest = useCallback((request: UpdateDialogRequest) => {
    setDialogRequest(previous => previous === request ? null : previous);
  }, []);
  const check = useCallback(async (manual = true, returnFocus: HTMLElement | null = null) => {
    if (!selection.active || selection.pending || queryClient.getQueryData(sessionKey) == null) return;
    const state = queryClient.getQueryState(selection.queryKey);
    if (!manual && Date.now() < retryDeadline(state?.error, state?.errorUpdatedAt ?? 0)) return;
    const previousAttemptAt = selection.lastAttemptAt;
    const attempt = { manual };
    selection.pending = attempt;
    selection.lastAttemptAt = Date.now();
    if (manual) toast.close(toastId);
    try {
      const outcome = await refetch();
      if (selection.active && selection.pending === attempt && outcome.status !== "pending" && outcome.error?.name !== "AbortError") {
        // A request refused by the cooldown has not checked the upstream and
        // must not postpone the next scheduled check for another six hours.
        if (outcome.error instanceof ApiError && outcome.error.status === 429) selection.lastAttemptAt = previousAttemptAt;
        setCompletedSelection(selection);
        if (manual && outcome.isSuccess) {
          const data = outcome.data.data;
          if (data.status === "update_available") showDetails(data, returnFocus);
          else toast.add({
            id: toastId,
            title: data.status === "up_to_date" ? "已是当前通道最新版本。" : "当前版本高于此通道最新发布版本。",
            type: data.status === "up_to_date" ? "success" : "info",
            timeout: 4000,
          });
        }
      }
    } finally {
      if (selection.pending === attempt) {
        selection.pending = null;
        selection.wake?.();
      }
    }
  }, [refetch, selection, showDetails, toastId]);

  useEffect(() => {
    selection.active = true;
    return () => {
      selection.active = false;
      // StrictMode can replay effects without recreating this selection. A canceled
      // attempt must neither suppress its replacement nor complete that replacement.
      if (selection.pending) selection.lastAttemptAt = null;
      selection.pending = null;
      toast.close(toastId);
      void queryClient.cancelQueries({ queryKey: selection.queryKey, exact: true });
    };
  }, [selection, toastId]);

  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      if (!automatic || !selection.active || selection.pending ||
        document.visibilityState === "hidden" || !navigator.onLine ||
        queryClient.getQueryData(sessionKey) == null) return;
      const state = queryClient.getQueryState(selection.queryKey);
      const next = Math.max(
        selection.lastAttemptAt === null ? 0 : selection.lastAttemptAt + checkInterval,
        retryDeadline(state?.error, state?.errorUpdatedAt ?? 0),
      );
      const delay = next - Date.now();
      if (delay <= 0) {
        void check(false);
      } else {
        // Browsers clamp larger delays to 1ms; bound unusually long Retry-After values.
        timer = window.setTimeout(schedule, Math.min(delay, 2_147_483_647));
      }
    };
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("online", schedule);
    window.addEventListener("offline", schedule);
    selection.wake = schedule;
    schedule();
    return () => {
      window.clearTimeout(timer);
      if (selection.wake === schedule) selection.wake = undefined;
      document.removeEventListener("visibilitychange", schedule);
      window.removeEventListener("online", schedule);
      window.removeEventListener("offline", schedule);
    };
  }, [automatic, selection, check]);

  return {
    update, check, preferences, checked: completedSelection === selection,
    selection, showDetails, clearDialogRequest,
    dialogRequest: dialogRequest?.selection === selection ? dialogRequest : null,
  };
}

const OfficialUpdateContext = createContext<ReturnType<typeof useUpdateOwner> | null>(null);

function UpdateOwner({ children }: { children: ReactNode }) {
  const value = useUpdateOwner();
  return <OfficialUpdateContext value={value}>{children}</OfficialUpdateContext>;
}

export function OfficialUpdateProvider({ children }: { children: ReactNode }) {
  const owner = useContext(OfficialUpdateContext);
  // A standalone System view can supply the boundary; the app's existing owner wins.
  return owner ? children : <UpdateOwner>{children}</UpdateOwner>;
}

function useOfficialUpdate() {
  const context = useContext(OfficialUpdateContext);
  if (!context) throw new Error("官方更新需要 OfficialUpdateProvider。");
  return context;
}

export function OfficialUpdateDialog() {
  const { update, checked, preferences, selection, dialogRequest, clearDialogRequest } = useOfficialUpdate();
  return <UpdateDialog
    channel={preferences.channel}
    selection={selection}
    candidate={checked && !selection.pending?.manual && !dialogRequest && !update.isFetching && !update.isError ? update.data?.data : undefined}
    request={dialogRequest}
    onRequestHandled={clearDialogRequest}
    upgradeGuide={upgradeGuide}
  />;
}

export function useOfficialUpdateAvailable(): boolean {
  const { update, checked, preferences } = useOfficialUpdate();
  const data = update.data?.data;
  const reminder = useUpdateReminder(preferences.channel, data?.latest_version);
  return checked && !update.isFetching && !update.isError &&
    data?.status === "update_available" && !reminder.ignored;
}
export function OfficialUpdatePanel({ currentVersion }: { currentVersion?: string }) {
  return <OfficialUpdateProvider><UpdatePanel currentVersion={currentVersion} /></OfficialUpdateProvider>;
}

function UpdatePanel({ currentVersion }: { currentVersion?: string | undefined }) {
  const { update, checked, check, preferences, showDetails } = useOfficialUpdate();
  const checking = update.isFetching;
  const failed = checked && update.isError;
  const data = checked && !checking && !update.isError ? update.data?.data : undefined;
  const lastKnownVersion = update.data?.data.current_version;
  const knownVersion = isReleaseVersion(currentVersion)
    ? currentVersion
    : isReleaseVersion(lastKnownVersion) ? lastKnownVersion : undefined;
  const latestIsPrerelease = isPrereleaseVersion(data?.latest_version);
  const reminder = useUpdateReminder(preferences.channel, data?.latest_version);
  const status = checking
    ? "正在检查更新…"
    : failed
      ? update.error instanceof ApiError ? update.error.message : "暂时无法检查更新。"
      : data?.status === "update_available"
        ? "有可用更新：v" + data.latest_version + (latestIsPrerelease ? "（预发布）" : "") + (reminder.ignored ? "（已忽略）" : "")
        : null;
  const hasUpdate = data?.status === "update_available";
  const hasNotice = Boolean(status || hasUpdate);
  return (
    <section
      className="system-update-strip"
      aria-label="官方更新"
      data-update-state={checking ? "checking" : failed ? "unavailable" : data?.status ?? "idle"}
    >
      <Card size="sm" className="system-update-card">
        <CardHeader className="system-update-header">
          <CardTitle role="heading" aria-level={2}>官方更新</CardTitle>
          <CardDescription className="system-update-current">
            <span>当前版本</span>
            {isPrereleaseVersion(knownVersion) && <span>（预发布）</span>}
          </CardDescription>
          <CardAction>
            <Badge variant={hasUpdate ? "warning" : "secondary"} className="font-mono">
              {knownVersion ? `v${knownVersion}` : "未知"}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="system-update-body">
          {hasNotice && (
            <div className="system-update-notice" data-highlight={hasUpdate ? "true" : undefined}>
              {status && (
                <p className="system-update-status">
                  <span role="status" aria-label="更新状态">{status}</span>
                </p>
              )}
              {hasUpdate && (
                <div className="flex min-w-0 flex-col gap-1.5 text-xs">
                  <span className="font-medium text-foreground">目标镜像</span>
                  <CopyValue value={"ghcr.io/mashiro0619/perpay:" + data.latest_version} label="复制目标镜像" />
                  <span className="text-muted-foreground">将部署配置中的 x-perpay-image 改为此标签，再拉取并重启。</span>
                </div>
              )}
            </div>
          )}
          {hasNotice && <Separator />}
          <FieldGroup className="system-update-preferences" role="group" aria-label="更新检查设置">
            <Field orientation="horizontal" className="system-update-auto">
              <FieldLabel htmlFor="official-update-automatic">自动检查更新</FieldLabel>
              <Switch id="official-update-automatic" checked={preferences.automatic} onCheckedChange={(automatic) => setUpdatePreferences({ automatic })} />
            </Field>
            <Field orientation="horizontal" className="system-update-channel">
              <FieldLabel htmlFor="official-update-channel">检查通道</FieldLabel>
              <Select items={channels} value={preferences.channel} onValueChange={(channel) => { if (isUpdateChannel(channel)) setUpdatePreferences({ channel }); }}>
                <SelectTrigger id="official-update-channel" size="sm"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>{channels.map(({ value, label }) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
            </Field>
            <Button variant="outline" size="sm" className="system-update-check"
              disabled={update.isFetching} onClick={(event) => { void check(true, event.currentTarget); }}>
              {update.isFetching && <Spinner aria-hidden="true" data-icon="inline-start" />}
              检查更新
            </Button>
          </FieldGroup>
          {(data || (reminder.dismissedVersion !== null && (!hasUpdate || !reminder.ignored))) && (
            <div className="system-update-actions">
              {hasUpdate && <Button variant="ghost" size="sm" onClick={(event) => showDetails(data, event.currentTarget)}>查看更新</Button>}
              {hasUpdate && <Button variant="ghost" size="sm" onClick={() => {
                if (reminder.ignored) restoreUpdateReminders(preferences.channel);
                else dismissUpdateVersion(preferences.channel, data.latest_version);
              }}>{reminder.ignored ? "恢复此通道更新提醒" : "忽略此版本"}</Button>}
              {data && (
                <>
                  <a data-external-link aria-label="查看发布说明"
                    className={buttonVariants({ variant: "ghost", size: "sm" })}
                    href={data.release_url} target="_blank" rel="noopener noreferrer">发布说明</a>
                  <a data-external-link className={buttonVariants({ variant: "ghost", size: "sm" })}
                    href={"https://github.com/Mashiro0619/PerPay/blob/v" + data.latest_version + "/README.md#更新"} target="_blank" rel="noopener noreferrer">更新方法</a>
                </>
              )}
              {reminder.dismissedVersion !== null && (!hasUpdate || !reminder.ignored) && (
                <Button variant="ghost" size="sm" onClick={() => restoreUpdateReminders(preferences.channel)}>
                  恢复此通道更新提醒
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
