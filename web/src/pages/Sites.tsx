import CreateSite from "./CreateSite";
import { SiteManagementCards } from "@/components/site-management-cards";
import { CopyValue } from "@/components/copy-value";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation, useNavigation, useParams } from "react-router";
import { PageHeading } from "@/components/page-heading";
import { PageHeaderActions } from "@/components/page-header-actions";
import { RefreshButton } from "@/components/refresh-button";
import { DetailFields, DetailPage } from "@/components/detail/DetailPrimitives";
import { DetailSection } from "@/components/detail/DetailSections";
import { ScrollingTabs } from "@/components/scrolling-tabs";
import { SettingsSummary, type SettingsSummaryRow } from "@/components/settings-summary";
import { OverlayActions } from "@/components/overlay-actions";
import { useOverlayCloseGuard, useOverlayContext } from "@/lib/overlay-context";
import { overviewQueries, overviewRange } from "@/api/workspace-queries";
import { count, dateTime, money } from "@/lib/format";
import {
  api,
  ApiError,
  queryClient,
  result,
  type Site,
  type SiteConfiguration,
} from "@/api/client";
import { Link, useNavigate } from "@/navigation";
import { useDirtyDraft } from "@/drafts";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { useSuccessToast } from "@/components/Feedback";
import { SitePolicyFields, SiteTextField } from "@/components/SitePolicyFields";
import { SiteCollectionFields } from "@/components/site-collection-fields";
import { accountState, alipayAccountsQuery, type AlipayAccount, type SiteCollection } from "@/lib/alipay-accounts";
import { siteTimeoutError, siteTimeoutSeconds } from "@/lib/site-timeout";
import { SiteConfigurationConflicts } from "@/components/site-configuration-conflicts";
import { SiteClientIdChange } from "@/components/site-client-id-change";
import { mergeSiteConfiguration, resolveSiteConflicts, type SiteConflictChoices } from "@/lib/site-configuration";
import { latestEditorSnapshot, siteEditorKey, siteEditorQueryOptions } from "@/lib/site-editor-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@/components/ui/field";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/admin-dialog";

export default function Sites() {
  return <SiteManagementCards />;
}
const siteSections = [
  { value: "basic", label: "基本信息" },
  { value: "collection", label: "收款账号" },
  { value: "orders", label: "订单设置" },
  { value: "integration", label: "接入与通知" },
  { value: "display", label: "收银台展示" },
] as const;

function siteSummaryRows(site: Site, section: string): SettingsSummaryRow[] {
  const value = site.configuration, policy = value.policy;
  if (section === "collection") return [
    ["分配方式", value.collection ? { FIXED: "指定账号", RANDOM: "随机分配", WEIGHTED: "按权重分配" }[value.collection.mode] : "未配置"],
    ["收款账号", <SiteCollectionSummary collection={value.collection} />],
  ];
  if (section === "orders") return [
    ["收银台有效期", policy.orders.order_ttl_seconds + " 秒"],
    ["最大加价金额", money(policy.orders.amount_offset_maximum_cents)],
    ["应付金额复用等待", policy.orders.amount_reuse_cooldown_seconds + " 秒"],
    ["待付款订单上限", policy.orders.pending_order_limit === null ? "不限" : count(policy.orders.pending_order_limit)],
  ];
  if (section === "integration") return [
    ["通知", value.notifications_enabled ? "开启" : "关闭"],
    ["通知地址前缀", value.notification_origin || "未设置"],
    ["返回地址前缀", value.return_origin || "未设置"],
    ["通知超时", siteTimeoutSeconds(policy.notification_delivery.timeout_milliseconds) + " 秒"],
    ["最多发送次数", count(policy.notification_delivery.maximum_attempts)],
    ["首次 / 最大重试间隔", policy.notification_delivery.retry_base_seconds + " / " + policy.notification_delivery.retry_maximum_seconds + " 秒"],
  ];
  if (section === "display") return [
    ["收银台名称", policy.display.checkout_name],
    ["显示商品名称", policy.display.checkout_show_product_name ? "开启" : "关闭"],
    ["帮助链接", policy.display.checkout_help_url || "未设置"],
  ];
  return [
    ["业务网站名称", value.name],
    ["新订单", value.accepting_orders ? "允许接单" : "暂停接单"],
    ["客户端 ID", <CopyValue value={site.api_client_id ?? site.client_id} label="复制客户端 ID" />],
    ["创建时间", dateTime(site.created_at)],
  ];
}

function collectionAvailability(account: AlipayAccount): string {
  if (account.environment !== "PRODUCTION" || !account.enabled || !account.configured) return accountState(account);
  if (!account.health) return "已配置，收款状态待确认";
  return account.health.collection_ready ? "当前可收款" : "当前不可收款";
}

function SiteCollectionSummary({ collection }: { collection: SiteCollection | undefined }) {
  const configured = collection?.accounts ?? [];
  const accounts = useQuery({ ...alipayAccountsQuery, enabled: configured.length > 0 });
  if (!configured.length) return <>未分配</>;
  const catalog = new Map(accounts.data?.data.map(account => [account.id, account]) ?? []);
  const current = accounts.isSuccess && !accounts.isFetching && !accounts.isPaused;
  return <div className="flex min-w-0 flex-col gap-2" data-site-collection-summary>
    <ErrorNotice error={accounts.error} retry={() => { void accounts.refetch(); }} retainedData={!!accounts.data} />
    {accounts.isError && <p className="text-muted-foreground">以下保留已保存的账号分配；当前账号资料与可用状态未确认。</p>}
    {accounts.isPaused ? <p role="status" className="text-muted-foreground">等待网络恢复，账号可用状态未确认。</p>
      : accounts.isFetching && <p role="status" className="text-muted-foreground">正在读取账号资料…</p>}
    <ItemGroup aria-label="已分配收款账号">
      {configured.map(selected => {
        const account = catalog.get(selected.account_id);
        const status = !current ? "可用状态待确认" : account ? collectionAvailability(account) : "账号不存在或已删除，请核对历史配置";
        return <Item key={selected.account_id} size="xs" role="listitem" className="min-w-0 px-0">
          <ItemContent className="min-w-0 gap-1">
            <ItemTitle className="line-clamp-none wrap-anywhere">{account?.name ?? selected.account_id}</ItemTitle>
            {account && <ItemDescription className="line-clamp-none wrap-anywhere">账号 ID：{selected.account_id}</ItemDescription>}
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-muted-foreground">{status}</span>
              {collection?.mode === "WEIGHTED" && <span className="tabular-nums">权重 {count(selected.weight ?? 1)}</span>}
            </div>
          </ItemContent>
        </Item>;
      })}
    </ItemGroup>
  </div>;
}

export function SiteSettingsPage() {
  const { clientId, section = "basic" } = useParams();
  const navigate = useNavigate();
  const query = useQuery(siteEditorQueryOptions(clientId));
  const selected = siteSections.find(item => item.value === section);
  if (!selected) return <ErrorNotice error={new Error("网站设置分组不存在")} />;
  return <div className="admin-settings-layout flex min-w-0 flex-col gap-4">
    <PageHeading title={selected.label} />
    <Tabs value={section} onValueChange={value => { if (value) void navigate("/sites/" + encodeURIComponent(clientId!) + "/settings/" + value); }}>
      <ScrollingTabs><TabsList aria-label="网站设置分组" variant="line" activateOnFocus={false} className="min-w-max">
        {siteSections.map(item => <TabsTrigger key={item.value} value={item.value}>{item.label}</TabsTrigger>)}
      </TabsList></ScrollingTabs>
    </Tabs>
    <QueryView query={query}>{({ site }) => <SettingsSummary title={selected.label} rows={siteSummaryRows(site, section)} editTo={"/sites/" + encodeURIComponent(site.client_id) + "/edit?section=" + section} />}</QueryView>
  </div>;
}

export function SiteSummaryOverlay() {
  const { clientId } = useParams();
  const location = useLocation();
  const range = overviewRange(new URLSearchParams(location.search));
  const site = useQuery(siteEditorQueryOptions(clientId));
  const queries = overviewQueries(clientId ?? null, range);
  const analytics = useQuery({ ...queries.analytics, enabled: !!clientId, placeholderData: undefined });
  const work = useQuery(queries.workSummary);
  return <QueryView query={site}>{({ site: current }) => <DetailPage>
    <PageHeading title={current.configuration.name} />
    <PageHeaderActions><RefreshButton disabled={site.isFetching || analytics.isFetching || work.isFetching} busy={site.isFetching || analytics.isFetching || work.isFetching} onClick={() => {
      void site.refetch();
      void analytics.refetch();
      void work.refetch();
    }} /></PageHeaderActions>
    <ErrorNotice error={analytics.error} retry={() => { void analytics.refetch(); }} />
    <ErrorNotice error={work.error} retry={() => { void work.refetch(); }} />
    <DetailSection title="网站概况"><DetailFields wide={["客户端 ID"]} items={[
      ["接单状态", <Badge variant={current.configuration.accepting_orders ? "success" : "warning"}>{current.configuration.accepting_orders ? "接单中" : "暂停接单"}</Badge>],
      ["通知", current.configuration.notifications_enabled ? "开启" : "关闭"],
      ["近 " + range + " 天实收", analytics.data ? money(analytics.data.data.confirmations.amount_cents) : analytics.isPending ? "正在读取…" : "暂不可用"],
      ["收款确认笔数", analytics.data ? count(analytics.data.data.confirmations.count) : "—"],
      ["当前待付款", analytics.data ? count(analytics.data.data.pending.orders) : "—"],
      ["待处理", work.data?.data ? count(work.data.data.total) : "—"],
      ["客户端 ID", <CopyValue value={current.api_client_id ?? current.client_id} label="复制客户端 ID" />],
    ]} /></DetailSection>
    <OverlayActions>
      <Link to={"/sites/" + encodeURIComponent(current.client_id) + "/edit?section=basic"} className={buttonVariants({ variant: "outline" })}>编辑网站</Link>
      <Link to={"/sites/" + encodeURIComponent(current.client_id) + "?range=" + range} className={buttonVariants()}>进入后台</Link>
    </OverlayActions>
  </DetailPage>}</QueryView>;
}

export function SiteEditorPage() {
  const { clientId } = useParams();
  return clientId ? <ExistingSiteEditor /> : <CreateSite />;
}
async function cacheSite(site: Site): Promise<Site> {
  // A GET begun before this write must not replace the committed snapshot later.
  await queryClient.cancelQueries({ queryKey: siteEditorKey(site.client_id) });
  await queryClient.cancelQueries({ queryKey: ["workspace-site", site.client_id] });
  const snapshot = latestEditorSnapshot(site);
  queryClient.setQueryData(siteEditorKey(site.client_id), snapshot);
  queryClient.setQueryData<{ data: Site }>(["workspace-site", site.client_id], previous =>
    previous && previous.data.revision > snapshot.site.revision ? previous : { data: snapshot.site },
  );
  void queryClient.invalidateQueries({ queryKey: ["site-overview"] });
  return snapshot.site;
}
function isSiteRevisionConflict(error: unknown) {
  return error instanceof ApiError && error.status === 409 && error.code === "site_revision_conflict";
}
function ExistingSiteEditor() {
  const { clientId, section: routeSection = "basic" } = useParams();
  const location = useLocation();
  const overlay = useOverlayContext();
  const section = overlay ? new URLSearchParams(location.search).get("section") ?? "basic" : routeSection;
  const query = useQuery(siteEditorQueryOptions(clientId));
  if (
    clientId &&
    !["basic", "collection", "orders", "integration", "display"].includes(section)
  )
    return <ErrorNotice error={new Error("网站设置分组不存在")} />;
  return (
    <QueryView query={query}>
      {(data) => (
        <SiteEditor
          key={(clientId ?? "new") + (overlay ? "" : section)}
          initial={data.site}
          configuration={data.configuration}
          section={clientId ? section : "all"}
          tabbed={!!overlay}
        />
      )}
    </QueryView>
  );
}
function SiteEditor({
  initial,
  configuration,
  section: initialSection,
  tabbed = false,
}: {
  initial: Site | null;
  configuration: SiteConfiguration;
  section: string;
  tabbed?: boolean;
}) {
  const overlay = useOverlayContext();
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [activeSection, setActiveSection] = useState(initialSection);
  const section = tabbed ? activeSection : initialSection;
  const navigate = useNavigate();
  const location = useLocation();
  const navigation = useNavigation();
  const currentNavigation = useRef({ key: location.key, pending: navigation.state !== "idle" });
  useLayoutEffect(() => {
    currentNavigation.current = { key: location.key, pending: navigation.state !== "idle" };
  }, [location.key, navigation.state]);
  const sections = siteSections;
  const visible = (value: string) => section === "all" || section === value;
  const [saved, setSaved] = useState(initial);
  const [changingClientId, setChangingClientId] = useState(false);
  const changeClientIdTrigger = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState(() => structuredClone(configuration));
  const [timeoutRaw, setTimeoutRaw] = useState(() => siteTimeoutSeconds(configuration.policy.notification_delivery.timeout_milliseconds));
  const timeoutError = siteTimeoutError(timeoutRaw);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved?.configuration ?? configuration) ||
    timeoutRaw !== siteTimeoutSeconds((saved?.configuration ?? configuration).policy.notification_delivery.timeout_milliseconds);
  const clearDraft = useDirtyDraft(dirty);
  const [needsReview, setNeedsReview] = useState(false);
  const [review, setReview] = useState<({ site: Site } & ReturnType<typeof mergeSiteConfiguration>) | null>(null);
  const [choices, setChoices] = useState<SiteConflictChoices>({});
  const reloadController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const deletionConfirmed = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      reloadController.current?.abort();
    };
  }, []);
  const [confirmation, setConfirmation] = useState<
    "save" | "api" | "webhook" | "delete" | null
  >(null);
  const [revealed, setRevealed] = useState<{
    label: string;
    value: string;
  } | null>(null);
  const secretDisplayGeneration = useRef(0);
  const secretDisplayRequest = useRef<number | null>(null);
  const observedSecretRevision = useRef(initial?.revision ?? -1);
  useEffect(
    () => () => {
      secretDisplayGeneration.current++;
      secretDisplayRequest.current = null;
    },
    [],
  );
  const invalidateSecretDisplay = useCallback(() => {
    secretDisplayGeneration.current++;
    setRevealed(null);
  }, []);
  const hideSecret = useCallback(() => {
    secretDisplayRequest.current = null;
    invalidateSecretDisplay();
    // Do not reset/abort the mutation: hiding is not cancellation of a committed rotation.
  }, [invalidateSecretDisplay]);
  const observeSecretRevision = useCallback((revision: number) => {
    if (revision <= observedSecretRevision.current) return;
    observedSecretRevision.current = revision;
    invalidateSecretDisplay();
  }, [invalidateSecretDisplay]);
  useEffect(() => {
    // A newer snapshot can retire a key even while a view/rotation is pending.
    if (initial) observeSecretRevision(initial.revision);
  }, [initial, observeSecretRevision]);
  const setFeedback = useSuccessToast();
  const revisionConflict = (error: unknown) => {
    if (!isSiteRevisionConflict(error)) return;
    setNeedsReview(true);
    setReview(null);
    setChoices({});
    setFeedback("");
  };
  const save = useMutation({
    networkMode: "always",
    retry: false,
    mutationFn: async () => {
      if (timeoutError) throw new Error(timeoutError);
      return (
      saved
        ? result(
            api.updateSite({
              path: { clientId: saved.client_id },
              body: { revision: saved.revision, configuration: draft },
            }),
          )
        : Promise.reject(new Error("缺少业务网站身份")));
    },
    onError: revisionConflict,
    onSuccess: async (response) => {
      const latest = await cacheSite(response.data);
      observeSecretRevision(latest.revision);
      setSaved(response.data);
      setDraft(structuredClone(response.data.configuration));
      setTimeoutRaw(siteTimeoutSeconds(response.data.configuration.policy.notification_delivery.timeout_milliseconds));
      setNeedsReview(false);
      setReview(null);
      clearDraft();
      setFeedback("业务网站配置已保存");
      void queryClient.invalidateQueries({ queryKey: ["sites"] });
      if (!saved) {
        void queryClient.invalidateQueries({ queryKey: ["settings"] });
        void navigate("/sites/" + response.data.client_id);
      }
    },
  });
  const action = useMutation({
    networkMode: "always",
    retry: false,
    mutationFn: async (
      kind: "api" | "webhook" | "view-api" | "view-webhook" | "delete",
    ): Promise<void> => {
      if (!saved) return;
      const path = { clientId: saved.client_id };
      if (kind === "delete") {
        deletionConfirmed.current = false;
        const originKey = currentNavigation.current.key;
        await result(
          api.deleteSite({ path, body: { revision: saved.revision } }),
        );
        deletionConfirmed.current = true;
        const returnToList = mounted.current && currentNavigation.current.key === originKey && !currentNavigation.current.pending;
        clearDraft();
        queryClient.removeQueries({
          queryKey: ["site-editor", saved.client_id],
        });
        queryClient.removeQueries({
          queryKey: ["workspace-site", saved.client_id],
        });
        void queryClient.invalidateQueries({ queryKey: ["site-overview"] });
        void queryClient.invalidateQueries({ queryKey: ["sites"] });
        void queryClient.invalidateQueries({ queryKey: ["settings"] });
        // Clear shared data even after departure, but never replace a newer navigation.
        if (returnToList) void navigate("/sites");
        return;
      }
      observeSecretRevision(latestEditorSnapshot(saved).site.revision);
      const displayGeneration = ++secretDisplayGeneration.current;
      secretDisplayRequest.current = displayGeneration;
      if (kind === "view-api" || kind === "view-webhook") {
        const response = await result(
          kind === "view-api"
            ? api.viewSiteApiSecret({ path, body: {} })
            : api.viewSiteWebhookSecret({ path, body: {} }),
        );
        observeSecretRevision(latestEditorSnapshot(saved).site.revision);
        if (displayGeneration === secretDisplayGeneration.current)
          setRevealed({
            label: kind === "view-api" ? "API 密钥" : "通知签名密钥",
            value: response.data.secret,
          });
        return;
      }
      const response = await result(
        kind === "api"
          ? api.rotateSiteApiSecret({
              path,
              body: { revision: saved.revision },
            })
          : api.rotateSiteWebhookSecret({
              path,
              body: { revision: saved.revision },
            }),
      );
      // Publishing this rotation's own revision must keep its returned key valid.
      // A newer snapshot still invalidates the display without cancelling the write.
      observedSecretRevision.current = Math.max(observedSecretRevision.current, response.data.site.revision);
      const latest = await cacheSite(response.data.site);
      observeSecretRevision(latest.revision);
      setSaved(response.data.site);
      const superseded = response.data.site.revision < observedSecretRevision.current;
      // A GET may already have observed this same committed rotation. Preserve its
      // explicit display request unless the user hid it or another request replaced it.
      if (secretDisplayRequest.current === displayGeneration && !superseded)
        setRevealed({
          label: kind === "api" ? "API 密钥" : "通知签名密钥",
          value: response.data.secret,
        });
      setFeedback(superseded
        ? "密钥操作已完成，请重新查看当前密钥。"
        : "密钥已生成或轮换，请更新业务网站配置。");
    },
    onError: revisionConflict,
  });
  function applyReview(site: Site, configuration: SiteConfiguration, timeoutResolved = false) {
    observeSecretRevision(site.revision);
    setSaved(site);
    setDraft(configuration);
    // The numeric policy omits rejected input; an unrelated merge must retain it.
    setTimeoutRaw(raw => timeoutResolved || !siteTimeoutError(raw)
      ? siteTimeoutSeconds(configuration.policy.notification_delivery.timeout_milliseconds)
      : raw);
    setReview(null);
    setChoices({});
    setNeedsReview(false);
    save.reset();
    action.reset();
    setFeedback("最新配置已合并，尚未保存");
  }
  const reload = useMutation({
    networkMode: "always",
    retry: false,
    mutationFn: async () => {
      if (!saved) throw new Error("缺少业务网站身份");
      const controller = new AbortController();
      reloadController.current = controller;
      const response = await result(api.getSite({ path: { clientId: saved.client_id }, signal: controller.signal }));
      controller.signal.throwIfAborted();
      return cacheSite(response.data);
    },
    onSuccess: site => {
      if (!mounted.current || !saved) return;
      observeSecretRevision(site.revision);
      const merged = mergeSiteConfiguration(saved.configuration, draft, site.configuration, tabbed ? "all" : section);
      setChoices({});
      if (merged.conflicts.length) setReview({ site, ...merged });
      else applyReview(site, merged.configuration);
    },
  });
  const errors = save.error instanceof ApiError ? save.error.fields : {};
  const busy = save.isPending || action.isPending || reload.isPending;
  useOverlayCloseGuard(() => save.isPending || reload.isPending || (action.isPending && !deletionConfirmed.current));
  useEffect(() => {
    if (!tabbed || !(save.error instanceof ApiError)) return;
    const field = Object.keys(save.error.fields)[0] ?? "";
    if (field) setActiveSection(field.includes(".display.") ? "display" : field.includes(".orders.") ? "orders" : field.startsWith("configuration.collection") ? "collection" : /notification|return_origin/.test(field) ? "integration" : "basic");
  }, [save.error, tabbed]);
  useEffect(() => {
    if (!busy && save.error) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [section, save.error, busy]);
  const requiresReview = needsReview || !!review || (!!initial && !!saved && initial.revision > saved.revision && dirty);
  useEffect(() => {
    // The write/reload callback adopts its own response and must finish first.
    if (busy || !initial || !saved || initial.revision <= saved.revision) return;
    if (dirty || needsReview) {
      setNeedsReview(true);
      if (review && initial.revision > review.site.revision) {
        setReview(null);
        setChoices({});
      }
      return;
    }
    setSaved(initial);
    setDraft(structuredClone(initial.configuration));
    setTimeoutRaw(siteTimeoutSeconds(initial.configuration.policy.notification_delivery.timeout_milliseconds));
  }, [initial, saved, dirty, needsReview, review, busy]);
  const change = (edit: (next: SiteConfiguration) => void) => {
    const next = structuredClone(draft);
    edit(next);
    setDraft(next);
    setFeedback("");
    save.reset();
  };
  const impact = [
    saved?.configuration.accepting_orders && !draft.accepting_orders
      ? "暂停新订单，旧订单继续处理。"
      : "",
    saved?.configuration.notifications_enabled && !draft.notifications_enabled
      ? "暂停后续通知发送，正在发送的通知可能完成。"
      : "",
    saved &&
    saved.configuration.notification_origin !== draft.notification_origin
      ? "后续通知按新前缀校验，旧地址可能无法发送。"
      : "",
    saved && saved.configuration.return_origin !== draft.return_origin
      ? "新订单的返回地址将按新前缀校验。"
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const formActions = (
    <OverlayActions>
      {overlay && <Button type="button" variant="outline" disabled={busy} onClick={() => overlay.requestClose()}>关闭</Button>}
      <Button form={formId} type="submit" disabled={busy || requiresReview || !!timeoutError}>
        {save.isPending ? "正在保存…" : "保存业务网站"}
      </Button>
    </OverlayActions>
  );
  return (
    <div className="admin-settings-layout flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeading title={tabbed ? "编辑" + (saved?.configuration.name ?? "业务网站") : sections.find((item) => item.value === section)?.label ?? "网站设置"} />
        {!overlay && <Link to="/sites" className={buttonVariants({ variant: "outline" })}>
          返回网站列表
        </Link>}
      </div>
      {saved && (
        <Tabs
          value={section}
          onValueChange={(value) => {
            if (value) {
              if (tabbed) setActiveSection(value);
              else void navigate("/sites/" + saved.client_id + "/settings/" + value);
            }
          }}
        >
          <ScrollingTabs>
            <TabsList className="min-w-max" aria-label="网站设置分组" activateOnFocus={false}>
              {sections.map((item) => (
                <TabsTrigger value={item.value} key={item.value}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </ScrollingTabs>
        </Tabs>
      )}
      <ErrorNotice error={save.error || action.error} />
      <ErrorNotice error={reload.error} />
      {requiresReview && (
        <Alert>
          <AlertTitle>业务网站配置已变更</AlertTitle>
          <AlertDescription>
            <p>你的修改已保留。读取最新配置将合并无冲突项，冲突需核对；不会自动保存或重试密钥操作。</p>
            <Button variant="outline" disabled={busy} onClick={() => reload.mutate()}>
              {reload.isPending ? "正在读取…" : "读取最新配置并核对"}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {review && (
        <SiteConfigurationConflicts
          conflicts={review.conflicts}
          choices={choices}
          onChoose={setChoices}
          disabled={busy}
          onApply={() => {
            const configuration = resolveSiteConflicts(review.configuration, review.conflicts, choices);
            if (configuration) applyReview(review.site, configuration,
              review.conflicts.some(conflict => conflict.path === "policy.notification_delivery.timeout_milliseconds"));
          }}
        />
      )}
      {saved && visible("integration") && (
        <Card>
          <CardHeader>
            <CardTitle>接入信息</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel>客户端 ID</FieldLabel>
                <CopyValue value={saved.api_client_id ?? saved.client_id} label="复制客户端 ID" />
                <Button ref={changeClientIdTrigger} type="button" variant="outline" className="self-start"
                  disabled={busy || dirty || requiresReview} onClick={() => setChangingClientId(true)}>更换客户端 ID</Button>
                {dirty && <FieldDescription>请先保存或撤销当前配置修改，再更换客户端 ID。</FieldDescription>}
              </Field>
              <Field>
                <FieldLabel>PerPay 地址</FieldLabel>
                <CopyValue
                  value={window.location.origin}
                  label="复制 PerPay 地址"
                />
              </Field>
            </FieldGroup>
          </CardContent>

        </Card>
      )}
      <form
        id={formId}
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || requiresReview || timeoutError) return;
          if (impact) setConfirmation("save");
          else save.mutate();
        }}
      >
        <FieldSet disabled={busy || !!review}>
          <Card>
            <CardContent>
              <FieldGroup>
                {visible("basic") && (
                  <>
                    <SiteTextField
                      label="业务网站名称"
                      required
                      maxLength={40}
                      value={draft.name}
                      error={errors["configuration.name"]}
                      onChange={(text) =>
                        change((p) => {
                          p.name = text;
                        })
                      }
                    />
                    <Field orientation="horizontal">
                      <FieldLabel htmlFor="site-accepting">
                        允许新订单
                      </FieldLabel>
                      <Switch
                        id="site-accepting"
                        checked={draft.accepting_orders}
                        onCheckedChange={(value) =>
                          change((p) => {
                            p.accepting_orders = value;
                          })
                        }
                      />
                    </Field>
                  </>
                )}
                {visible("integration") && (
                  <>
                    <Field orientation="horizontal">
                      <FieldLabel htmlFor="site-notifications">
                        开启通知
                      </FieldLabel>
                      <Switch
                        id="site-notifications"
                        disabled={!saved}
                        checked={draft.notifications_enabled}
                        onCheckedChange={(value) =>
                          change((p) => {
                            p.notifications_enabled = value;
                          })
                        }
                      />
                    </Field>
                    <FieldDescription>
                      开启前需生成通知密钥并填写通知地址前缀。
                    </FieldDescription>
                    <SiteTextField
                      label="通知地址前缀"
                      type="url"
                      placeholder="https://notify.example.com"
                      value={draft.notification_origin ?? ""}
                      error={errors["configuration.notification_origin"]}
                      onChange={(text) =>
                        change((p) => {
                          p.notification_origin = text || null;
                        })
                      }
                    />
                    <SiteTextField
                      label="返回地址前缀"
                      type="url"
                      placeholder="https://shop.example.com"
                      value={draft.return_origin ?? ""}
                      error={errors["configuration.return_origin"]}
                      onChange={(text) =>
                        change((p) => {
                          p.return_origin = text || null;
                        })
                      }
                    />
                    <FieldDescription>
                      不含路径、端口或通配符。
                    </FieldDescription>
                  </>
                )}
                {visible("collection") && <SiteCollectionFields value={draft.collection ?? { mode: "FIXED", accounts: [] }} disabled={busy || requiresReview} error={Object.entries(errors).find(([field]) => field.startsWith("configuration.collection"))?.[1]} onChange={collection => change(next => { next.collection = collection; })} />}
                <SitePolicyFields
                  section={section === "all" ? undefined : section}
                  disabled={busy || requiresReview}
                  value={draft.policy}
                  secondsDraft={timeoutRaw}
                  onSecondsDraftChange={setTimeoutRaw}
                  errors={errors}
                  onChange={(policy) =>
                    change((p) => {
                      p.policy = policy;
                    })
                  }
                />
              </FieldGroup>
            </CardContent>
            {overlay ? formActions : <CardFooter>{formActions}</CardFooter>}
          </Card>
        </FieldSet>
      </form>
      {saved && changingClientId && <SiteClientIdChange site={saved} finalFocus={() => changeClientIdTrigger.current}
        onClose={refresh => { setChangingClientId(false); if (refresh) reload.mutate(); }}
        onChanged={async site => {
          const latest = await cacheSite(site);
          observeSecretRevision(latest.revision);
          setSaved(latest);
          setDraft(structuredClone(latest.configuration));
          setTimeoutRaw(siteTimeoutSeconds(latest.configuration.policy.notification_delivery.timeout_milliseconds));
          clearDraft();
          setChangingClientId(false);
          setFeedback("客户端 ID 操作已完成。");
          void queryClient.invalidateQueries({ queryKey: ["sites"] });
        }} />}
      {saved && visible("integration") && (
        <Card>
          <CardHeader>
            <CardTitle>业务网站密钥</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => action.mutate("view-api")}
            >
              查看 API 密钥
            </Button>
            <Button
              variant="outline"
              disabled={busy || requiresReview}
              onClick={() => setConfirmation("api")}
            >
              生成／轮换 API 密钥
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => action.mutate("view-webhook")}
            >
              查看通知密钥
            </Button>
            <Button
              variant="outline"
              disabled={busy || requiresReview}
              onClick={() => setConfirmation("webhook")}
            >
              生成／轮换通知密钥
            </Button>
          </CardContent>
        </Card>
      )}
      {saved && visible("basic") && (
        <Card>
          <CardHeader>
            <CardTitle>删除空业务网站</CardTitle>
          </CardHeader>
          <CardContent>
            <Button
              variant="destructive"
              disabled={busy || requiresReview}
              onClick={() => setConfirmation("delete")}
            >
              删除空业务网站
            </Button>
          </CardContent>
        </Card>
      )}
      {revealed && (
        <Card>
          <CardHeader>
            <CardTitle>{revealed.label}</CardTitle>
            <CardDescription>
              仅供此网站使用，请勿泄露。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Input
              aria-label={revealed.label}
              readOnly
              value={revealed.value}
              autoComplete="off"
            />
          </CardContent>
          <CardFooter>
            <Button variant="outline" onClick={hideSecret}>
              隐藏密钥
            </Button>
          </CardFooter>
        </Card>
      )}
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              确认
              {confirmation === "delete"
                ? "删除业务网站"
                : confirmation === "save"
                  ? "保存配置"
                  : "生成或轮换密钥"}
              ？
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation === "delete"
                ? "仅限无历史订单的网站。删除后不可恢复，客户端 ID 不可复用。"
                : confirmation === "save"
                  ? impact
                  : confirmation === "webhook"
                    ? "下次发送使用新密钥，正在发送的通知可能仍用旧签名。接收端需短暂兼容新旧签名；疑似泄露时停止信任旧密钥。失败后先查看当前密钥，勿重复轮换。"
                    : "已有 API 密钥将立即失效，请同步更新业务网站。失败后先查看当前密钥，勿重复轮换。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || requiresReview || (confirmation === "save" && !!timeoutError)}
              onClick={() => {
                if (busy || requiresReview || (confirmation === "save" && timeoutError)) return;
                const selected = confirmation;
                setConfirmation(null);
                if (selected === "save") save.mutate();
                else if (selected) action.mutate(selected);
              }}
            >
              确认
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export { default as SiteDefaultsPage } from "./SiteDefaults";
