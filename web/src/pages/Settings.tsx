import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
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
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { SecuritySettings } from "./SecuritySettings";

export default function Settings() {
  const { section: requestedSection } = useParams();
  const navigate = useNavigate();
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
    <div className="@container/settings flex w-full min-w-0 max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
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
              className="min-w-0 gap-4"
            >
              <NativeSelect
                aria-label="设置分类"
                className="w-full @2xl/settings:hidden"
                value={section}
                onChange={(event) => changeSection(event.currentTarget.value)}
              >
                {sections.map(([value, title]) => (
                  <NativeSelectOption key={value} value={value}>
                    {title}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <TabsList
                aria-label="设置分类"
                className="hidden @2xl/settings:inline-flex"
              >
                {sections.map(([value, title]) => (
                  <TabsTrigger key={value} value={value}>
                    {title}
                  </TabsTrigger>
                ))}
              </TabsList>
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
