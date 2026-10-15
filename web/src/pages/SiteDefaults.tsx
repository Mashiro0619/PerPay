import { useEffect, useRef, useState } from "react";
import { PageHeading } from "@/components/page-heading";
import { onlineManager, useMutation, useQuery } from "@tanstack/react-query";
import { api, ApiError, queryClient, result, type SitePolicy } from "@/api/client";
import { useDirtyDraft } from "@/drafts";
import { SuccessMessage, useFeedback } from "@/components/Feedback";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { SitePolicyFields } from "@/components/SitePolicyFields";
import { SiteConfigurationConflicts } from "@/components/site-configuration-conflicts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FieldSet } from "@/components/ui/field";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  mergeSitePolicy,
  resolveSitePolicyConflicts,
  type SiteConflictChoices,
} from "@/lib/site-configuration";

type DefaultsSnapshot = { revision: number; policy: SitePolicy };
const defaultsKey = ["site-defaults"] as const;

function latestDefaults(snapshot: DefaultsSnapshot): DefaultsSnapshot {
  const cached = queryClient.getQueryData<{ data: DefaultsSnapshot }>(defaultsKey);
  return cached && cached.data.revision > snapshot.revision ? cached.data : snapshot;
}

async function cacheDefaults(snapshot: DefaultsSnapshot, signal?: AbortSignal) {
  await queryClient.cancelQueries({ queryKey: defaultsKey, exact: true });
  signal?.throwIfAborted();
  const latest = latestDefaults(snapshot);
  queryClient.setQueryData(defaultsKey, { data: latest });
  return latest;
}

export default function SiteDefaultsPage() {
  const query = useQuery({
    queryKey: defaultsKey,
    queryFn: async ({ signal }) => {
      const response = await result(api.getSiteDefaults({ signal }));
      return { data: latestDefaults(response.data) };
    },
    staleTime: Infinity,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return <QueryView query={query}>{response => <DefaultsEditor initial={response.data} />}</QueryView>;
}

function DefaultsEditor({ initial }: { initial: DefaultsSnapshot }) {
  const [section, setSection] = useState("orders");
  const formRef = useRef<HTMLFormElement>(null);
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(() => structuredClone(initial.policy));
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved.policy);
  const clearDraft = useDirtyDraft(dirty);
  const [feedback, setFeedback] = useFeedback();
  const [needsReview, setNeedsReview] = useState(false);
  const [review, setReview] = useState<({ snapshot: DefaultsSnapshot } & ReturnType<typeof mergeSitePolicy>) | null>(null);
  const [choices, setChoices] = useState<SiteConflictChoices>({});
  const reloadController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      reloadController.current?.abort();
    };
  }, []);

  const save = useMutation({
    networkMode: "always",
    retry: false,
    mutationFn: () => {
      if (!onlineManager.isOnline() || !navigator.onLine)
        throw new Error("网络已断开，模板未提交。恢复连接后请重新提交。");
      return result(api.updateSiteDefaults({ body: { revision: saved.revision, policy: draft } }));
    },
    onSuccess: async response => {
      // Publish a completed save even when its editor has been left.
      const latest = await cacheDefaults(response.data);
      if (!mounted.current) return;
      setSaved(latest);
      setDraft(structuredClone(latest.policy));
      setNeedsReview(false);
      setReview(null);
      setChoices({});
      clearDraft();
      setFeedback("模板已保存，已有网站不受影响。");
    },
    onError: error => {
      if (!(error instanceof ApiError) || error.status !== 409 || error.code !== "site_revision_conflict") return;
      void queryClient.invalidateQueries({ queryKey: defaultsKey, exact: true, refetchType: "none" });
      if (!mounted.current) return;
      setNeedsReview(true);
      setReview(null);
      setChoices({});
      setFeedback("");
    },
  });

  function applyReview(snapshot: DefaultsSnapshot, policy: SitePolicy) {
    setSaved(snapshot);
    setDraft(policy);
    setNeedsReview(false);
    setReview(null);
    setChoices({});
    save.reset();
    setFeedback("最新模板已合并，尚未保存");
  }

  const reload = useMutation({
    networkMode: "always",
    retry: false,
    mutationFn: async () => {
      if (!onlineManager.isOnline() || !navigator.onLine)
        throw new Error("网络已断开，尚未重新读取模板。恢复连接后请重试。");
      const controller = new AbortController();
      reloadController.current = controller;
      const response = await result(api.getSiteDefaults({ signal: controller.signal }));
      controller.signal.throwIfAborted();
      return cacheDefaults(response.data, controller.signal);
    },
    onSuccess: snapshot => {
      if (!mounted.current) return;
      const merged = mergeSitePolicy(saved.policy, draft, snapshot.policy);
      setChoices({});
      if (merged.conflicts.length) setReview({ snapshot, ...merged });
      else applyReview(snapshot, merged.policy);
    },
  });

  const busy = save.isPending || reload.isPending;
  const requiresReview = needsReview || !!review || (initial.revision > saved.revision && dirty);
  useEffect(() => {
    if (busy || initial.revision <= saved.revision) return;
    if (dirty || needsReview) {
      setNeedsReview(true);
      if (review && initial.revision > review.snapshot.revision) {
        setReview(null);
        setChoices({});
      }
      return;
    }
    setSaved(initial);
    setDraft(structuredClone(initial.policy));
  }, [initial, saved.revision, dirty, needsReview, review, busy]);

  useEffect(() => {
    if (!(save.error instanceof ApiError)) return;
    const field = Object.keys(save.error.fields)[0];
    if (field) setSection(field.includes("display.") ? "display" : field.includes("notification_delivery.") ? "integration" : "orders");
  }, [save.error]);
  useEffect(() => {
    if (!busy && save.error) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [section, save.error, busy]);

  return (
    <div className="admin-settings-layout flex flex-col gap-6">
      <PageHeading title="网站默认模板" />
      <p className="text-sm text-muted-foreground">仅用于新网站，已有网站不变。</p>
      <Tabs value={section} onValueChange={value => { if (value) setSection(value); }}>
        <TabsList aria-label="模板分组">
          <TabsTrigger value="orders">订单设置</TabsTrigger>
          <TabsTrigger value="display">收银台展示</TabsTrigger>
          <TabsTrigger value="integration">通知策略</TabsTrigger>
        </TabsList>
      </Tabs>
      <ErrorNotice error={save.error} />
      <ErrorNotice error={reload.error} />
      {requiresReview && (
        <Alert>
          <AlertTitle>默认模板已变更</AlertTitle>
          <AlertDescription>
            <p>你的修改仍保留。读取最新模板后会合并各分组中无冲突的修改；同一字段的不同修改需要核对选择。读取和核对不会自动保存。</p>
            <Button variant="outline" disabled={busy} onClick={() => reload.mutate()}>
              {reload.isPending ? "正在读取…" : "读取最新模板并核对"}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {review && (
        <SiteConfigurationConflicts
          conflicts={review.conflicts}
          choices={choices}
          onChoose={setChoices}
          onApply={() => {
            const policy = resolveSitePolicyConflicts(review.policy, review.conflicts, choices);
            if (policy) applyReview(review.snapshot, policy);
          }}
          disabled={busy}
          saveLabel="保存默认模板"
        />
      )}
      <SuccessMessage message={feedback} />
      <form ref={formRef} onSubmit={event => {
        event.preventDefault();
        if (!busy && !requiresReview) save.mutate();
      }}>
        <FieldSet disabled={busy || requiresReview}>
          <SitePolicyFields
            section={section}
            disabled={busy || requiresReview}
            value={draft}
            errors={save.error instanceof ApiError ? save.error.fields : {}}
            onChange={policy => {
              setDraft(policy);
              setFeedback("");
              save.reset();
            }}
          />
          <Button type="submit" className="w-fit" disabled={busy || requiresReview}>保存默认模板</Button>
        </FieldSet>
      </form>
    </div>
  );
}
