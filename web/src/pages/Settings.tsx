import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DatabaseBackup,
  KeyRound,
  Mail,
  Monitor,
  QrCode,
  RefreshCw,
  SlidersHorizontal,
  Wallet,
} from "lucide-react";
import { useParams } from "react-router";
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
import { SuccessMessage, useFeedback } from "@/components/Feedback";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SecuritySettings } from "./SecuritySettings";

const sectionIcons = {
  provider: Wallet,
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
  const [success, setSuccess] = useFeedback();
  const [editorVersion, setEditorVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const { requestDiscard } = useDraftGuard();
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
  }, [requestedSection, settings.isSuccess]);
  function saved(data: RuntimeSettings, message = "已保存") {
    queryClient.setQueryData(["settings"], { data });
    setSuccess(message);
    void refreshOperationalData();
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
    <div className="@container/settings flex w-full min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-2xl font-semibold tracking-tight">实例设置</h2>
          <p className="text-sm text-muted-foreground">
            管理收款接入、订单和界面显示。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            className={buttonVariants({ variant: "outline" })}
            to="/settings/onboarding"
          >
            配置向导
          </Link>
          <Button
            variant="outline"
            disabled={settings.isFetching}
            onClick={refresh}
          >
            {settings.isFetching ? (
              <Spinner aria-hidden="true" data-icon="inline-start" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            刷新
          </Button>
        </div>
      </div>
      <QueryView query={settings}>
        {({ data }) => {
          const section =
            sections.find(([value]) => value === requestedSection)?.[0] ??
            (data.completion.complete ? "collection" : "provider");
          const changeSection = (value: string | null) => {
            if (!value) return;
            setSuccess("");
            void navigate("/settings/" + value);
          };
          return (
            <Tabs
              value={section}
              onValueChange={changeSection}
              className="min-w-0 gap-6"
            >
              <div
                className="min-w-0 overflow-x-auto p-1"
                data-settings-tabs-scroll
              >
                <TabsList
                  ref={tabList}
                  aria-label="设置分类"
                  activateOnFocus={false}
                  className="min-w-max justify-start"
                >
                  {sections.map(([value, title]) => {
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
              </div>
              <TabsContent value={section}>
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
                      key={section + ":" + data.revision + ":" + editorVersion}
                      section={section}
                      settings={data}
                      onSaved={saved}
                    />
                  )}
                  <SuccessMessage message={success} />
                </div>
              </TabsContent>
            </Tabs>
          );
        }}
      </QueryView>
    </div>
  );
}
