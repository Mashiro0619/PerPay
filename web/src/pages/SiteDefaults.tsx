import { useEffect, useRef, useState } from "react";
import { PageHeading } from "@/components/page-heading";
import { onlineManager, useMutation, useQuery } from "@tanstack/react-query";
import { api, ApiError, queryClient, result, type SitePolicy } from "@/api/client";
import { useDirtyDraft } from "@/drafts";
import { useSuccessToast } from "@/components/Feedback";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { SitePolicyFields } from "@/components/SitePolicyFields";
import { siteTimeoutError, siteTimeoutSeconds } from "@/lib/site-timeout";
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
  const [timeoutRaw, setTimeoutRaw] = useState(() => siteTimeoutSeconds(initial.policy.notification_delivery.timeout_milliseconds));
  const timeoutError = siteTimeoutError(timeoutRaw);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved.policy) ||
    timeoutRaw !== siteTimeoutSeconds(saved.policy.notification_delivery.timeout_milliseconds);
  const clearDraft = useDirtyDraft(dirty);
  const setFeedback = useSuccessToast();
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
      if (timeoutError) throw new Error(timeoutError);
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
      setTimeoutRaw(siteTimeoutSeconds(latest.policy.notification_delivery.timeout_milliseconds));
      setNeedsReview(false);
      setReview(null);
      setChoices({});
      clearDraft();
      setFeedback("模板已保存");
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

  function applyReview(snapshot: DefaultsSnapshot, policy: SitePolicy, timeoutResolved = false) {
    setSaved(snapshot);
    setDraft(policy);
    // The numeric policy omits rejected input; an unrelated merge must retain it.
    setTimeoutRaw(raw => timeoutResolved || !siteTimeoutError(raw)
      ? siteTimeoutSeconds(policy.notification_delivery.timeout_milliseconds)
      : raw);
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
    setTimeoutRaw(siteTimeoutSeconds(initial.policy.notification_delivery.timeout_milliseconds));
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
            <p>你的修改已保留。读取最新模板将合并无冲突项，冲突需核对；不会自动保存。</p>
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
            if (policy) applyReview(review.snapshot, policy,
              review.conflicts.some(conflict => conflict.path === "policy.notification_delivery.timeout_milliseconds"));
          }}
          disabled={busy}
          saveLabel="保存默认模板"
        />
      )}
      <form ref={formRef} onSubmit={event => {
        event.preventDefault();
        if (!busy && !requiresReview && !timeoutError) save.mutate();
      }}>
        <FieldSet disabled={busy || requiresReview}>
          <SitePolicyFields
            section={section}
            disabled={busy || requiresReview}
            value={draft}
            secondsDraft={timeoutRaw}
            onSecondsDraftChange={setTimeoutRaw}
            errors={save.error instanceof ApiError ? save.error.fields : {}}
            onChange={policy => {
              setDraft(policy);
              setFeedback("");
              save.reset();
            }}
          />
          <Button type="submit" className="w-fit" disabled={busy || requiresReview || !!timeoutError}>保存默认模板</Button>
        </FieldSet>
      </form>
    </div>
  );
}
