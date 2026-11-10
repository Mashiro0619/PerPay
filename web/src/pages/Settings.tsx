import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { RefreshButton } from "@/components/refresh-button";
import { PageHeaderActionLink, PageHeaderActions } from "@/components/page-header-actions";
import { useEffect, useRef, useState } from "react";
import { useIsMutating, useQuery } from "@tanstack/react-query";
import {
  DatabaseBackup,
  KeyRound,
  Mail,
  Monitor,
  QrCode,
  SlidersHorizontal,
  Settings2,
  Wallet,
} from "lucide-react";
import { Navigate, useParams } from "react-router";
import { PageHeading } from "@/components/page-heading";
import { ScrollingTabs } from "@/components/scrolling-tabs";
import { SelectionMotionGroup, SelectionMotionIndicator } from "@/components/selection-motion";
import { Link, useNavigate } from "@/navigation";
import { SettingsEditor, sections, type ConfigurationSection } from "@/components/SettingsForms";
import { SettingsSummary, type SettingsSummaryRow } from "@/components/settings-summary";
import { ErrorNotice } from "@/components/request-state";
import {
  api,
  queryClient,
  refreshOperationalData,
  result,
  type RuntimeSettings,
} from "@/api/client";
import { useDraftGuard } from "@/drafts";
import { useOverlayCloseGuard } from "@/lib/overlay-context";
import { Loading, QueryView, ReadPausedNotice } from "@/components/request-state";
import { useSuccessToast } from "@/components/Feedback";
import { buttonVariants } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIsMobile } from "@/hooks/use-mobile";
import { NotificationKeyActions, SecuritySettings } from "./SecuritySettings";
import { AlipayAccountList } from "./AlipayAccounts";
import { BackupOverview } from "@/components/backup-status";
import { backupFilesKey } from "@/components/backup-files";
import { durationLabel } from "@/lib/format";

const sectionIcons = {
  accounts: Wallet,
  provider: Wallet,
  "collection-policy": SlidersHorizontal,
  collection: QrCode,
  notifications: Mail,
  security: KeyRound,
  backup: DatabaseBackup,
  display: Monitor,
  advanced: SlidersHorizontal,
};

export default function Settings() {
  const { section: requestedSection } = useParams();
  const navigate = useNavigate();
  const tabList = useRef<HTMLDivElement>(null);
  const categoryTrigger = useRef<HTMLButtonElement>(null);
  const isMobile = useIsMobile();
  const setSuccess = useSuccessToast();
  const [editorVersion, setEditorVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const { requestDiscard, setDialogFinalFocus } = useDraftGuard();
  useEffect(() => {
    setDialogFinalFocus(null);
    return () => setDialogFinalFocus(null);
  }, [requestedSection, isMobile, setDialogFinalFocus]);
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => result(api.getRuntimeSettings({ signal })),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  useEffect(() => {
    tabList.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [requestedSection, settings.isSuccess, isMobile]);
  function updated(data: RuntimeSettings) {
    queryClient.setQueryData(["settings"], { data });
    void refreshOperationalData();
  }
  function saved(data: RuntimeSettings, message = "已保存") {
    updated(data);
    setSuccess(message);
  }
  function refresh() {
    requestDiscard(() => {
      setRefreshing(true);
      void Promise.all([
        settings.refetch(),
        queryClient.invalidateQueries({ queryKey: ["alipay-accounts"] }),
        ...(requestedSection === "backup" ? [
          queryClient.invalidateQueries({ queryKey: backupFilesKey }),
          queryClient.invalidateQueries({ queryKey: ["status"] }),
        ] : []),
      ]).then(
        ([response]) => {
          if (!response.isError) {
            setEditorVersion((value) => value + 1);
            setSuccess("");
          }
          setRefreshing(false);
        },
        () => setRefreshing(false),
      );
    });
  }
  return (
    <div className="admin-settings-layout @container/settings flex w-full min-w-0 flex-col gap-6" data-settings-section={requestedSection}>
      <PageHeaderActions>
        <PageHeaderActionLink><Link
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          to="/settings/onboarding"
          aria-label="配置向导"
          title="配置向导"
        >
          <Settings2 data-icon="inline-start" />
          <span className="hidden sm:inline">配置向导</span>
        </Link></PageHeaderActionLink>
        <RefreshButton disabled={settings.isFetching || refreshing} onClick={refresh} busy={settings.isFetching || refreshing} />
      </PageHeaderActions>
      <PageHeading title="系统设置" />
      <QueryView query={settings}>
        {({ data }) => {
          if (data.site_mode && requestedSection === "notifications") return <Alert><AlertTitle>通知设置已迁移</AlertTitle><AlertDescription><Link to="/sites">前往业务网站配置通知</Link></AlertDescription></Alert>;
          if (data.site_mode && (requestedSection === "provider" || requestedSection === "collection")) return <Navigate to="/settings/accounts" replace />;
          const availableSections = data.site_mode ? [["accounts", "支付宝账号"] as const, ...sections.filter(([value]) => !["notifications", "provider", "collection"].includes(value))] : sections;
          const section =
            availableSections.find(([value]) => value === requestedSection)?.[0] ??
            (data.site_mode ? "accounts" : data.completion.complete ? "collection" : "provider");
          const changeSection = (value: string | null) => {
            if (!value) return;
            // The selected option unmounts before a blocked navigation closes.
            // Capture a stable return target for the unsaved-changes dialog.
            if (isMobile) {
              setDialogFinalFocus(categoryTrigger.current);
              categoryTrigger.current?.focus({ preventScroll: true });
            }
            setSuccess("");
            void navigate("/settings/" + value);
          };
          return (
            <Tabs
              value={section}
              onValueChange={changeSection}
              className="min-w-0 gap-6"
            >
              {isMobile ? (
                <Select
                  value={section}
                  onValueChange={changeSection}
                  items={availableSections.map(([value, label]) => ({ value, label }))}
                >
                  <SelectTrigger ref={categoryTrigger} aria-label="设置分类" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {availableSections.map(([value, title]) => {
                        const Icon = sectionIcons[value];
                        return (
                          <SelectItem key={value} value={value}>
                            <Icon />
                            {title}
                          </SelectItem>
                        );
                      })}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : (
                <ScrollingTabs>
                  <SelectionMotionGroup>
                    <TabsList
                      ref={tabList}
                      aria-label="设置分类"
                      activateOnFocus={false}
                      variant="line"
                      data-selection-motion="underline"
                      className="mb-1 min-w-max justify-start"
                    >
                      {availableSections.map(([value, title]) => {
                        const Icon = sectionIcons[value];
                        return (
                          <TabsTrigger
                            key={value}
                            value={value}
                            className="shrink-0"
                            onFocus={(event) =>
                              event.currentTarget.scrollIntoView({
                                block: "nearest",
                                inline: "nearest",
                              })
                            }
                          >
                            <SelectionMotionIndicator active={section === value} variant="underline" />
                            <Icon />
                            {title}
                          </TabsTrigger>
                        );
                      })}
                    </TabsList>
                  </SelectionMotionGroup>
                </ScrollingTabs>
              )}
              <TabsContent
                value={section}
                aria-label={isMobile ? availableSections.find(([value]) => value === section)?.[1] : undefined}
              >
                <div
                  data-settings-content
                  className="flex min-w-0 flex-col gap-4"
                  inert={refreshing}
                  aria-busy={refreshing}
                >
                  {section === "accounts" ? <AlipayAccountList /> : section === "backup" ? <BackupOverview settings={data} /> : section === "security" ? (
                    <SecuritySettings
                      key={"security:" + editorVersion}
                      settings={data}
                      onSaved={saved}
                    />
                  ) : (
                    <SettingsSummary title={availableSections.find(([value]) => value === section)?.[1] ?? "设置"} rows={settingsSummaryRows(data, section)} editTo={"/settings/" + section + "/edit"} />
                  )}
                </div>
              </TabsContent>
            </Tabs>
          );
        }}
      </QueryView>
    </div>
  );
}

function settingsSummaryRows(settings: RuntimeSettings, section: ConfigurationSection): SettingsSummaryRow[] {
  if (section === "provider") return [["应用 ID", settings.provider?.app_id || "未配置"], ["应用密钥", settings.completion.application_key ? "已配置" : "未配置"], ["接入状态", settings.completion.provider ? "已配置" : "待完成"]];
  if (section === "collection") return [["收款码", settings.collection?.code_payload ? "已配置" : "未配置"]];
  if (section === "collection-policy") {
    const policy = settings.collection_policy ?? settings.provider;
    return [["请求超时", policy?.timeout_milliseconds === undefined ? "未配置" : policy.timeout_milliseconds / 1000 + " 秒"], ["常规查账间隔", policy?.scan_interval_seconds === undefined ? "未配置" : policy.scan_interval_seconds + " 秒"], ["活跃 / 最小间隔", policy?.active_scan_interval_seconds === undefined ? "未配置" : policy.active_scan_interval_seconds + " / " + (policy.minimum_scan_interval_seconds ?? policy.active_scan_interval_seconds) + " 秒"], ["查账延迟", policy?.safety_lag_seconds === undefined ? "未配置" : policy.safety_lag_seconds + " 秒"], ["查账有效时限", policy?.maximum_success_age_seconds === undefined ? "未配置" : policy.maximum_success_age_seconds + " 秒"]];
  }
  if (section === "notifications") return [["通知", settings.notifications?.enabled ? "开启" : "关闭"], ["通知地址前缀", settings.notifications?.allowed_origin || "未设置"], ["通知超时", settings.notifications ? settings.notifications.timeout_milliseconds / 1000 + " 秒" : "未配置"], ["最多发送次数", settings.notifications?.maximum_attempts ?? "未配置"], ["首次 / 最大重试间隔", settings.notifications ? settings.notifications.retry_base_seconds + " / " + settings.notifications.retry_maximum_seconds + " 秒" : "未配置"]];
  if (section === "backup") return [["备份间隔", settings.backup.interval_seconds % 86400 === 0 ? "每 " + settings.backup.interval_seconds / 86400 + " 天" : settings.backup.interval_seconds % 3600 === 0 ? "每 " + settings.backup.interval_seconds / 3600 + " 小时" : settings.backup.interval_seconds + " 秒"], ["保留备份数量", settings.backup.keep_count]];
  if (section === "display") return [["系统名称", settings.display.system_name || "PerPay"], ["收款趋势默认图形", { AREA: "面积图", BAR: "柱状图", LINE: "折线图" }[settings.display.dashboard_chart_type]], ...(!settings.site_mode ? [["显示商品名称", settings.display.checkout_show_product_name !== false ? "开启" : "关闭"], ["帮助链接", settings.display.checkout_help_url || "未设置"]] as SettingsSummaryRow[] : [])];
  return [["收银台链接密钥轮换周期", settings.advanced.checkout_key_rotation_days + " 天"], ["结束后可查询时长", durationLabel(settings.advanced.checkout_terminal_observation_seconds)]];
}

export function SettingsEditorOverlay() {
  const { section } = useParams();
  const success = useSuccessToast();
  const { requestDiscard } = useDraftGuard();
  const [editorVersion, setEditorVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const mutating = useIsMutating() > 0;
  const settings = useQuery({ queryKey: ["settings"], queryFn: ({ signal }) => result(api.getRuntimeSettings({ signal })), staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false });
  // A save that finished after unmount invalidates the cached settings. Do not
  // freeze those old defaults into a new draft while its first read is pending.
  const [initialReadReady, setInitialReadReady] = useState(settings.isSuccess && !settings.isFetching && !settings.isPaused);
  useEffect(() => {
    if (settings.isSuccess && !settings.isFetching && !settings.isPaused) setInitialReadReady(true);
  }, [settings.isSuccess, settings.isFetching, settings.isPaused]);
  useOverlayCloseGuard(() => refreshing);
  function refresh() {
    if (refreshing || settings.isFetching || queryClient.isMutating()) return;
    requestDiscard(() => {
      setRefreshing(true);
      void Promise.all([settings.refetch(), queryClient.invalidateQueries({ queryKey: ["alipay-accounts"] })]).then(
        ([response]) => {
          if (!response.isError) { setEditorVersion(value => value + 1); success(""); }
          setRefreshing(false);
        },
        () => setRefreshing(false),
      );
    });
  }
  if (!section || section === "security" || !sections.some(([value]) => value === section)) return <ErrorNotice error={new Error("设置分类不存在")} />;
  const selected = section as ConfigurationSection;
  const title = sections.find(([value]) => value === selected)![1];
  function updated(data: RuntimeSettings) { queryClient.setQueryData(["settings"], { data }); void refreshOperationalData(); }
  function saved(data: RuntimeSettings, message?: string) { updated(data); if (message) success(message); }
  const initialRead = settings.isPaused ? <ReadPausedNotice /> : settings.isError
    ? <ErrorNotice scope="page" error={settings.error} retry={() => { void settings.refetch(); }} />
    : <Loading label="正在读取最新设置…" />;
  return <div className="flex min-w-0 flex-col gap-4"><PageHeaderActions><RefreshButton disabled={settings.isFetching || refreshing || mutating} busy={settings.isFetching || refreshing} onClick={refresh} /></PageHeaderActions><PageHeading title={"编辑" + title} /><div data-settings-content inert={refreshing} aria-busy={refreshing}>{!initialReadReady ? initialRead : <QueryView query={settings}>{({ data }) => {
    if (data.site_mode && ["provider", "collection", "notifications"].includes(selected)) return <Alert><AlertTitle>设置已迁移</AlertTitle><AlertDescription><Link to={selected === "notifications" ? "/sites" : "/settings/accounts"}>前往{selected === "notifications" ? "业务网站" : "支付宝账号"}</Link></AlertDescription></Alert>;
    return <SettingsEditor key={selected + ":" + editorVersion} section={selected} settings={data} onSaved={updated} onFeedback={success} secondaryAction={selected === "notifications" ? <NotificationKeyActions settings={data} onSaved={saved} /> : undefined} />;
  }}</QueryView>}</div></div>;
}
