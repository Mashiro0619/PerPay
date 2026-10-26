import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { RefreshButton } from "@/components/refresh-button";
import { PageHeaderActionLink, PageHeaderActions } from "@/components/page-header-actions";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { useParams } from "react-router";
import { PageHeading } from "@/components/page-heading";
import { ScrollingTabs } from "@/components/scrolling-tabs";
import { Link, useNavigate } from "@/navigation";
import { SettingsEditor, sections } from "@/components/SettingsForms";
import {
  api,
  queryClient,
  refreshOperationalData,
  result,
  type RuntimeSettings,
} from "@/api/client";
import { useDraftGuard } from "@/drafts";
import { QueryView } from "@/components/request-state";
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

const sectionIcons = {
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
      void settings.refetch().then(
        (response) => {
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
        <RefreshButton disabled={settings.isFetching} onClick={refresh} busy={settings.isFetching} />
      </PageHeaderActions>
      <PageHeading title="系统设置" />
      <QueryView query={settings}>
        {({ data }) => {
          if (data.site_mode && requestedSection === "notifications") return <Alert><AlertTitle>通知设置已迁移</AlertTitle><AlertDescription><Link to="/sites">前往业务网站配置通知</Link></AlertDescription></Alert>;
          const availableSections = data.site_mode ? sections.filter(([value]) => value !== "notifications") : sections;
          const section =
            availableSections.find(([value]) => value === requestedSection)?.[0] ??
            (data.completion.complete ? "collection" : "provider");
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
                  <TabsList
                    ref={tabList}
                    aria-label="设置分类"
                    activateOnFocus={false}
                    className="min-w-max justify-start"
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
                          <Icon />
                          {title}
                        </TabsTrigger>
                      );
                    })}
                  </TabsList>
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
                  {section === "security" ? (
                    <SecuritySettings
                      key={"security:" + editorVersion}
                      settings={data}
                      onSaved={saved}
                    />
                  ) : (
                    <SettingsEditor
                      key={
                        section +
                        ":" +
                        (section === "notifications"
                          ? "draft"
                          : data.revision) +
                        ":" +
                        editorVersion
                      }
                      section={section}
                      settings={data}
                      onSaved={updated}
                      onFeedback={setSuccess}
                      secondaryAction={
                        section === "notifications" ? (
                          <NotificationKeyActions
                            settings={data}
                            onSaved={saved}
                          />
                        ) : undefined
                      }
                    />
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
