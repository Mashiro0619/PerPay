import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, RefreshCw } from "lucide-react";
import { useParams } from "react-router";

import { Link } from "../navigation";
import { SelectionIndicator } from "../components/SelectionIndicator";
import { SettingsEditor, sections } from "../components/SettingsForms";

import { api, queryClient, refreshOperationalData, result, type RuntimeSettings } from "../api/client";
import { Button, PageHeading, QueryView } from "../components/ui";
import { useDraftGuard } from "../drafts";
import { SuccessMessage, useFeedback } from "../components/Feedback";
import { SecuritySettings } from "./SecuritySettings";

export default function Settings() {
  const { section: requestedSection } = useParams();
  const [success, setSuccess] = useFeedback();
  const [editorVersion, setEditorVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const { requestDiscard } = useDraftGuard();
  const settings = useQuery({ queryKey: ["settings"], queryFn: ({ signal }) => result(api.getRuntimeSettings({ signal })), staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false });
  function saved(data: RuntimeSettings, message = "已保存") {
    queryClient.setQueryData(["settings"], { data });
    setSuccess(message);
    void refreshOperationalData();
  }
  return <><PageHeading title="实例设置" actions={<><Link className="button" to="/settings/onboarding">配置向导</Link><Button pending={settings.isFetching} onClick={() => requestDiscard(() => {
    setRefreshing(true);
    void settings.refetch().then((response) => { if (!response.isError) { setEditorVersion((value) => value + 1); setSuccess(""); } setRefreshing(false); }, () => setRefreshing(false));
  })}><RefreshCw size={16} />刷新</Button></>} />
    <QueryView query={settings}>{({ data }) => {
      const section = sections.find(([value]) => value === requestedSection)?.[0] ?? (data.completion.complete ? "collection" : "provider");
      return <div className="settings-layout"><nav className="settings-nav" aria-label="设置分类"><SelectionIndicator active={section} />{sections.map(([value, title]) => <Link key={value} to={`/settings/${value}`} className={section === value ? "is-active" : ""} aria-current={section === value ? "page" : undefined} onClick={() => setSuccess("")}>{title}{((value === "provider" && data.completion.provider) || (value === "collection" && data.completion.collection)) && <Check size={14} aria-label="已配置" />}</Link>)}</nav>
        <div className="settings-content" inert={refreshing} aria-busy={refreshing}>{section === "security" ? <SecuritySettings key={`security:${editorVersion}`} settings={data} onSaved={saved} /> : <SettingsEditor key={`${section}:${data.revision}:${editorVersion}`} section={section} settings={data} onSaved={saved} />}<SuccessMessage message={success} /></div>
      </div>;
    }}</QueryView>
  </>;
}
