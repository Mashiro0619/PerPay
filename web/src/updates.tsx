import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { isReleaseVersion, isPrereleaseVersion } from "../../src/shared/release-version";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, queryClient, result, sessionKey, type OfficialUpdate } from "@/api/client";
import { isUpdateChannel, setUpdatePreferences, useUpdatePreferences, type UpdateChannel } from "@/lib/update-preferences";
import { dismissUpdateVersion, restoreUpdateReminders, useUpdateReminder } from "@/lib/update-reminders";
import { UpdateDialog, type UpdateDialogRequest } from "@/components/update-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
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

function refreshDeadline(raw: string | null | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) return 0;
  const seconds = Number(raw);
  const deadline = Date.now() + seconds * 1000;
  return Number.isSafeInteger(seconds) && seconds > 0 && Number.isSafeInteger(deadline) ? deadline : 0;
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
      let refreshAfter = 0;
      const response = await result(api.checkOfficialUpdate({
        signal,
        query: { channel, ...(selection.pending?.manual ? { refresh: true } : {}) },
      }).then((response) => {
        // Read metadata locally, but only publish it after result() has validated
        // the response and the administrator session generation.
        refreshAfter = refreshDeadline(response.response?.headers.get("X-PerPay-Update-Refresh-After"));
        return response;
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
      return { ...response, refreshAfter };
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
    const cached = queryClient.getQueryData<{ refreshAfter: number }>(selection.queryKey);
    if (Date.now() < Math.max(retryDeadline(state?.error, state?.errorUpdatedAt ?? 0), manual ? cached?.refreshAfter ?? 0 : 0)) return;
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
function retryWait(seconds: number) {
  if (seconds > 0 && seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  if (seconds > 0 && seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
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
  const [clock, setClock] = useState(Date.now);
  const retryAt = Math.max(retryDeadline(update.error, update.errorUpdatedAt), update.data?.refreshAfter ?? 0);
  const remaining = Math.max(0, Math.ceil((retryAt - Math.max(clock, update.errorUpdatedAt)) / 1000));
  useEffect(() => {
    setClock(Date.now());
    if (retryAt <= Date.now()) return;
    let timer: number;
    const tick = () => {
      const now = Date.now(); setClock(now);
      if (now < retryAt) timer = window.setTimeout(tick, Math.min(retryAt - now, retryAt - now > 60_000 ? 60_000 : 1000));
    };
    timer = window.setTimeout(tick, Math.min(retryAt - Date.now(), retryAt - Date.now() > 60_000 ? 60_000 : 1000));
    return () => window.clearTimeout(timer);
  }, [retryAt]);
  const status = checking
    ? "正在检查更新…"
    : failed
      ? update.error instanceof ApiError ? update.error.message : "暂时无法检查更新。"
      : data?.status === "update_available"
        ? "有可用更新：v" + data.latest_version + (latestIsPrerelease ? "（预发布）" : "") + (reminder.ignored ? "（已忽略）" : "")
        : null;
  return (
    <section className="system-update-strip" aria-label="官方更新" data-update-state={checking ? "checking" : failed ? "unavailable" : data?.status ?? "idle"}>
        <div className="system-update-main">
          <div className="system-update-summary">
            <h2>官方更新</h2>
              <span className="system-update-current">
                <span>当前版本</span>{" "}
                <span className="font-mono">{knownVersion ? `v${knownVersion}` : "未知"}</span>
                {isPrereleaseVersion(knownVersion) && <span>（预发布）</span>}
              </span>
            {(status || remaining > 0) && <p className="system-update-status">
              {status && <span role="status">{status}</span>}
              {!checking && remaining > 0 && (
                <span id="official-update-wait"> 请至少等待 {retryWait(remaining)}后重试。</span>
              )}
            </p>}
          </div>
        </div>
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
            aria-describedby={remaining > 0 ? "official-update-wait" : undefined}
            disabled={update.isFetching || remaining > 0} onClick={(event) => { void check(true, event.currentTarget); }}>
            {update.isFetching && <Spinner aria-hidden="true" data-icon="inline-start" />}
            检查更新
          </Button>
          {data && <div className="system-update-actions">
            {data.status === "update_available" && <Button variant="ghost" size="sm" onClick={(event) => showDetails(data, event.currentTarget)}>查看更新</Button>}
            {data.status === "update_available" && <Button variant="ghost" size="sm" onClick={() => {
              if (reminder.ignored) restoreUpdateReminders(preferences.channel);
              else dismissUpdateVersion(preferences.channel, data.latest_version);
            }}>{reminder.ignored ? "恢复此通道更新提醒" : "忽略此版本"}</Button>}
            <a data-external-link aria-label="查看发布说明"
              className={buttonVariants({ variant: "ghost", size: "sm" })}
              href={data.release_url} target="_blank" rel="noopener noreferrer">发布说明</a>
            <a data-external-link className={buttonVariants({ variant: "ghost", size: "sm" })}
              href={upgradeGuide} target="_blank" rel="noopener noreferrer">更新方法</a>
          </div>}
          {reminder.dismissedVersion !== null && (data?.status !== "update_available" || !reminder.ignored) && <Button variant="ghost" size="sm" onClick={() => restoreUpdateReminders(preferences.channel)}>恢复此通道更新提醒</Button>}
        </FieldGroup>
    </section>
  );
}
