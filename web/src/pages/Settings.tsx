import { RefreshButton } from "@/components/refresh-button";
import { PageHeaderActionLink, PageHeaderActions } from "@/components/page-header-actions";
import { useEffect, useRef, useState } from "react";
import { useIsMutating, useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  Archive,
  Clock,
  DatabaseBackup,
  Monitor,
  Settings2,
  ShieldCheck,
  Wallet,
  Wrench,
} from "lucide-react";
import { Navigate, useLocation, useParams } from "react-router";
import { PageHeading } from "@/components/page-heading";
import { ScrollingTabs } from "@/components/scrolling-tabs";
import { SelectionMotionGroup, SelectionMotionIndicator } from "@/components/selection-motion";
import { Link, useNavigate } from "@/navigation";
import { SettingsEditor, sections, type ConfigurationSection } from "@/components/SettingsForms";
import { ErrorNotice } from "@/components/request-state";
import {
  api,
  getRestoreSessionHold,
  queryClient,
  refreshOperationalData,
  result,
  type RuntimeSettings,
  type RuntimeSettingsEnvelope,
} from "@/api/client";
import { useDraftGuard } from "@/drafts";
import { useOverlayCloseGuard } from "@/lib/overlay-context";
import { Loading, QueryView, ReadPausedNotice } from "@/components/request-state";
import { useSuccessToast } from "@/components/Feedback";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { SecuritySettings } from "./SecuritySettings";
import { AlipayAccountList } from "./AlipayAccounts";
import { BackupOverview } from "@/components/backup-status";
import { backupFilesKey } from "@/components/backup-files";
import { maintenanceKey } from "@/api/maintenance";
import { useMaintenanceJobs } from "@/hooks/use-maintenance";
import { MaintenanceJobResult } from "@/components/maintenance-operation";

const sectionIcons = {
  accounts: Wallet,
  "collection-policy": Clock,
  security: ShieldCheck,
  backup: DatabaseBackup,
  display: Monitor,
  advanced: Wrench,
};

export default function Settings() {
  const { section: requestedSection } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const overlayRoute = new URLSearchParams(location.search).get("overlay");
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
  function refresh() {
    if (getRestoreSessionHold() !== null) {
      void queryClient.invalidateQueries({ queryKey: maintenanceKey });
      return;
    }
    requestDiscard(() => {
      setRefreshing(true);
      void Promise.all([
        settings.refetch(),
        queryClient.invalidateQueries({ queryKey: ["alipay-accounts"] }),
        ...(requestedSection === "backup" ? [
          queryClient.invalidateQueries({ queryKey: backupFilesKey }),
          queryClient.invalidateQueries({ queryKey: ["status"] }),
          queryClient.invalidateQueries({ queryKey: maintenanceKey }),
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
    <div className="admin-settings-layout @container/settings flex w-full min-w-0 flex-col gap-4" data-settings-section={requestedSection}>
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
      {requestedSection === "backup" && settings.data === undefined ? <BackupSettingsPending settings={settings} /> : <QueryView query={settings}>
        {({ data }) => {
          if (requestedSection === "notifications") return <Navigate to="/sites" replace />;
          if (requestedSection === "provider" || requestedSection === "collection") return <Navigate to="/settings/accounts" replace />;
          const availableSections = sections;
          const section =
            availableSections.find(([value]) => value === requestedSection)?.[0] ??
            "accounts";
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
          function handleInlineSaved(next: RuntimeSettings) {
            queryClient.setQueryData(["settings"], { data: next });
            void refreshOperationalData();
          }
          const paneContent = (
            <div
              data-settings-content
              className="settings-pane"
              inert={refreshing}
              aria-busy={refreshing}
            >
              {section === "accounts" ? (
                <AlipayAccountList />
              ) : section === "backup" ? (
                <>
                  <BackupOverview settings={data} />
                  <Card size="sm" data-settings-archives-card>
                    <CardHeader>
                      <CardTitle role="heading" aria-level={2} className="flex items-center gap-2">
                        <Archive className="size-4 text-muted-foreground" aria-hidden="true" />
                        历史归档
                      </CardTitle>
                      <CardDescription>
                        历史数据可归档后长期保留，减少主库和日常备份体积。
                      </CardDescription>
                      <CardAction>
                        <Link global to="/settings/archives" className={buttonVariants({ variant: "outline", size: "sm" })}>
                          历史归档
                        </Link>
                      </CardAction>
                    </CardHeader>
                  </Card>
                </>
              ) : section === "security" ? (
                <SecuritySettings
                  key={"security:" + editorVersion}
                  settings={data}
                />
              ) : overlayRoute === "/settings/" + section + "/edit" ? (
                <Card size="sm" data-settings-editing-backdrop={section}>
                  <CardHeader>
                    <CardTitle role="heading" aria-level={2}>
                      {availableSections.find(([value]) => value === section)?.[1]}
                    </CardTitle>
                    <CardDescription>正在弹窗中编辑当前配置。</CardDescription>
                  </CardHeader>
                </Card>
              ) : (
                <SettingsEditor
                  key={section + ":" + editorVersion}
                  section={section}
                  settings={data}
                  onSaved={handleInlineSaved}
                  onFeedback={setSuccess}
                />
              )}
            </div>
          );
          return (
            <Tabs
              orientation="horizontal"
              value={section}
              onValueChange={changeSection}
              className={isMobile ? "min-w-0 gap-4" : "settings-shell"}
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
                <div className="settings-rail">
                  <ScrollingTabs>
                    <SelectionMotionGroup>
                      <TabsList
                        ref={tabList}
                        aria-label="设置分类"
                        activateOnFocus={false}
                        variant="line"
                        data-selection-motion="underline"
                        className="settings-rail-list"
                      >
                        {availableSections.map(([value, title]) => {
                          const Icon = sectionIcons[value];
                          return (
                            <TabsTrigger
                              key={value}
                              value={value}
                              className="settings-rail-item"
                            >
                              <SelectionMotionIndicator active={section === value} variant="underline" />
                              <Icon />
                              <span>{title}</span>
                            </TabsTrigger>
                          );
                        })}
                      </TabsList>
                    </SelectionMotionGroup>
                  </ScrollingTabs>
                </div>
              )}
              <TabsContent
                value={section}
                className="min-w-0"
                render={
                  isMobile
                    ? ({ role: _role, tabIndex: _tabIndex, "aria-labelledby": _labelledBy, ...panelProps }) => (
                        <div {...panelProps} />
                      )
                    : undefined
                }
              >
                {paneContent}
              </TabsContent>
            </Tabs>
          );
        }}
      </QueryView>}
    </div>
  );
}

function BackupSettingsPending({ settings }: { settings: UseQueryResult<RuntimeSettingsEnvelope> }) {
  const maintenance = useMaintenanceJobs();
  return <div className="flex min-w-0 flex-col gap-3">
    <ErrorNotice error={maintenance.error} retry={() => { void maintenance.refetch(); }} />
    <MaintenanceJobResult job={maintenance.active ?? maintenance.latest} />
    {!maintenance.active && !maintenance.requiresLogin && <QueryView query={settings}>{() => null}</QueryView>}
  </div>;
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
  if (section === "provider" || section === "collection") return <Navigate to="/settings/accounts" replace />;
  if (section === "notifications") return <Navigate to="/sites" replace />;
  if (!section || section === "security" || section === "accounts" || !sections.some(([value]) => value === section)) return <ErrorNotice error={new Error("设置分类不存在")} />;
  const selected = section as ConfigurationSection;
  const title = sections.find(([value]) => value === selected)![1];
  function updated(data: RuntimeSettings) { queryClient.setQueryData(["settings"], { data }); void refreshOperationalData(); }
  const initialRead = settings.isPaused ? <ReadPausedNotice /> : settings.isError
    ? <ErrorNotice scope="page" error={settings.error} retry={() => { void settings.refetch(); }} />
    : <Loading label="正在读取最新设置…" />;
  return <div className="flex min-w-0 flex-col gap-4"><PageHeaderActions><RefreshButton disabled={settings.isFetching || refreshing || mutating} busy={settings.isFetching || refreshing} onClick={refresh} /></PageHeaderActions><PageHeading title={"编辑" + title} /><div data-settings-content inert={refreshing} aria-busy={refreshing}>{!initialReadReady ? initialRead : <QueryView query={settings}>{({ data }) => {
    return <SettingsEditor key={selected + ":" + editorVersion} section={selected} settings={data} onSaved={updated} onFeedback={success} />;
  }}</QueryView>}</div></div>;
}
