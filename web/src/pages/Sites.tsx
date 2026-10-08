import CreateSite from "./CreateSite";
import { siteChoiceLabel } from "@/lib/site-choice-label";
import { CopyValue } from "@/components/copy-value";
import { Badge } from "@/components/ui/badge";
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemActions,
} from "@/components/ui/item";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCallback, useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import {
  api,
  ApiError,
  queryClient,
  result,
  type Site,
  type SiteConfiguration,
  type SitePolicy,
} from "@/api/client";
import { Link, useNavigate } from "@/navigation";
import { useDirtyDraft } from "@/drafts";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { SuccessMessage, useFeedback } from "@/components/Feedback";
import { SitePolicyFields, SiteTextField } from "@/components/SitePolicyFields";
import { SiteConfigurationConflicts } from "@/components/site-configuration-conflicts";
import { mergeSiteConfiguration, resolveSiteConflicts, type SiteConflictChoices } from "@/lib/site-configuration";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
  const query = useInfiniteQuery({
    queryKey: ["sites", "list"],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      result(
        api.listSites({
          query: { limit: 30, ...(pageParam ? { after: pageParam } : {}) },
          signal,
        }),
      ),
    getNextPageParam: (page) => page.page.next_cursor ?? undefined,
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap justify-end gap-2">
        <Link
          to="/sites/defaults"
          className={buttonVariants({ variant: "outline" })}
        >
          默认模板
        </Link>
        <Link to="/sites/new" className={buttonVariants()}>
          创建网站
        </Link>
      </div>
      <QueryView query={query}>
        {(data) => (
          <>
            <ItemGroup>
              {data.pages
                .flatMap((p) => p.data)
                .map((site) => (
                  <Item key={site.client_id} variant="outline">
                    <ItemContent>
                      <ItemTitle>
                        <Link to={"/sites/" + site.client_id}>
                          {siteChoiceLabel(
                            site,
                            data.pages.flatMap((p) => p.data),
                          )}
                        </Link>
                      </ItemTitle>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="secondary">
                          {site.configuration.accepting_orders
                            ? "接单中"
                            : "暂停接单"}
                        </Badge>
                        <Badge variant="outline">
                          {site.configuration.notifications_enabled
                            ? "通知开启"
                            : "通知关闭"}
                        </Badge>
                      </div>
                    </ItemContent>
                    <ItemActions>
                      <Link
                        to={"/sites/" + site.client_id}
                        className={buttonVariants({
                          variant: "outline",
                          size: "sm",
                        })}
                      >
                        进入后台
                      </Link>
                    </ItemActions>
                  </Item>
                ))}
            </ItemGroup>
            {!data.pages.some((p) => p.data.length) && <p>暂无网站</p>}
            {query.hasNextPage && (
              <Button
                variant="outline"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                加载更多
              </Button>
            )}
          </>
        )}
      </QueryView>
    </div>
  );
}
export function SiteEditorPage() {
  const { clientId } = useParams();
  return clientId ? <ExistingSiteEditor /> : <CreateSite />;
}
type SiteEditorSnapshot = { site: Site; configuration: SiteConfiguration };
const siteEditorKey = (clientId: string) => ["site-editor", clientId] as const;
function latestEditorSnapshot(site: Site): SiteEditorSnapshot {
  const cached = queryClient.getQueryData<SiteEditorSnapshot>(siteEditorKey(site.client_id));
  return cached && cached.site.revision > site.revision
    ? cached
    : { site, configuration: site.configuration };
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
  const { clientId, section = "basic" } = useParams();
  const query = useQuery({
    queryKey: siteEditorKey(clientId ?? "new"),
    staleTime: Infinity,
    gcTime: clientId ? 5 * 60_000 : 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({
      signal,
    }): Promise<SiteEditorSnapshot> => {
      if (clientId) {
        const response = await result(
          api.getSite({ path: { clientId }, signal }),
        );
        return latestEditorSnapshot(response.data);
      }
      throw new Error("缺少网站身份");
    },
  });
  if (
    clientId &&
    !["basic", "orders", "integration", "display"].includes(section)
  )
    return <ErrorNotice error={new Error("网站设置分组不存在")} />;
  return (
    <QueryView query={query}>
      {(data) => (
        <SiteEditor
          key={(clientId ?? "new") + section}
          initial={data.site}
          configuration={data.configuration}
          section={clientId ? section : "all"}
        />
      )}
    </QueryView>
  );
}
function SiteEditor({
  initial,
  configuration,
  section,
}: {
  initial: Site | null;
  configuration: SiteConfiguration;
  section: string;
}) {
  const navigate = useNavigate();
  const sections = [
    { value: "basic", label: "基本信息" },
    { value: "orders", label: "订单设置" },
    { value: "integration", label: "接入与通知" },
    { value: "display", label: "收银台展示" },
  ];
  const visible = (value: string) => section === "all" || section === value;
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(() => structuredClone(configuration));
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved?.configuration ?? configuration);
  const clearDraft = useDirtyDraft(dirty);
  const [needsReview, setNeedsReview] = useState(false);
  const [review, setReview] = useState<({ site: Site } & ReturnType<typeof mergeSiteConfiguration>) | null>(null);
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
  const [feedback, setFeedback] = useFeedback();
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
    mutationFn: async () =>
      saved
        ? result(
            api.updateSite({
              path: { clientId: saved.client_id },
              body: { revision: saved.revision, configuration: draft },
            }),
          )
        : Promise.reject(new Error("缺少网站身份")),
    onError: revisionConflict,
    onSuccess: async (response) => {
      const latest = await cacheSite(response.data);
      observeSecretRevision(latest.revision);
      setSaved(response.data);
      setDraft(structuredClone(response.data.configuration));
      setNeedsReview(false);
      setReview(null);
      clearDraft();
      setFeedback("网站配置已保存");
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
        await result(
          api.deleteSite({ path, body: { revision: saved.revision } }),
        );
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
        void navigate("/sites");
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
        ? "密钥操作已完成，网站配置已有更新，请重新查看当前密钥。"
        : "密钥已生成或轮换，请更新业务网站配置。");
    },
    onError: revisionConflict,
  });
  function applyReview(site: Site, configuration: SiteConfiguration) {
    observeSecretRevision(site.revision);
    setSaved(site);
    setDraft(configuration);
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
      if (!saved) throw new Error("缺少网站身份");
      const controller = new AbortController();
      reloadController.current = controller;
      const response = await result(api.getSite({ path: { clientId: saved.client_id }, signal: controller.signal }));
      controller.signal.throwIfAborted();
      return cacheSite(response.data);
    },
    onSuccess: site => {
      if (!mounted.current || !saved) return;
      observeSecretRevision(site.revision);
      const merged = mergeSiteConfiguration(saved.configuration, draft, site.configuration, section);
      setChoices({});
      if (merged.conflicts.length) setReview({ site, ...merged });
      else applyReview(site, merged.configuration);
    },
  });
  const errors = save.error instanceof ApiError ? save.error.fields : {};
  const busy = save.isPending || action.isPending || reload.isPending;
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
      ? "停止领取新的通知投递，在途请求可能继续完成。"
      : "",
    saved &&
    (saved.configuration.notification_origin !== draft.notification_origin ||
      saved.configuration.return_origin !== draft.return_origin)
      ? "来源变更将限制后续请求；旧通知目标可能不再允许投递。"
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="admin-settings-layout flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold">
          {sections.find((item) => item.value === section)?.label ?? "网站设置"}
        </h2>
        <Link to="/sites" className={buttonVariants({ variant: "outline" })}>
          返回网站列表
        </Link>
      </div>
      {saved && (
        <Tabs
          value={section}
          onValueChange={(value) => {
            if (value)
              void navigate("/sites/" + saved.client_id + "/settings/" + value);
          }}
        >
          <TabsList className="flex h-auto flex-wrap" aria-label="网站设置分组">
            {sections.map((item) => (
              <TabsTrigger value={item.value} key={item.value}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
      <ErrorNotice error={save.error || action.error} />
      <ErrorNotice error={reload.error} />
      {requiresReview && (
        <Alert>
          <AlertTitle>网站配置已变更</AlertTitle>
          <AlertDescription>
            <p>你的修改仍保留。读取最新配置后会合并无冲突的字段；同一字段的不同修改需要核对选择。核对不会自动保存或重试密钥操作。</p>
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
            if (configuration) applyReview(review.site, configuration);
          }}
        />
      )}
      <SuccessMessage message={feedback} />
      {saved && visible("integration") && (
        <Card>
          <CardHeader>
            <CardTitle>接入信息</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel>客户端 ID</FieldLabel>
                <CopyValue value={saved.client_id} label="复制客户端 ID" />
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
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || requiresReview) return;
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
                      label="网站名称"
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
                      开启前需生成通知密钥并填写通知来源。
                    </FieldDescription>
                    <SiteTextField
                      label="通知来源"
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
                      label="返回来源"
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
                      填写 HTTPS 来源，不包含路径。
                    </FieldDescription>
                  </>
                )}
                <SitePolicyFields
                  section={section === "all" ? undefined : section}
                  value={draft.policy}
                  errors={errors}
                  onChange={(policy) =>
                    change((p) => {
                      p.policy = policy;
                    })
                  }
                />
              </FieldGroup>
            </CardContent>
            <CardFooter>
              <Button type="submit" disabled={busy || requiresReview}>
                {save.isPending ? "正在保存…" : "保存网站"}
              </Button>
            </CardFooter>
          </Card>
        </FieldSet>
      </form>
      {saved && visible("integration") && (
        <Card>
          <CardHeader>
            <CardTitle>网站密钥</CardTitle>
            <CardDescription>
              API 密钥轮换后旧密钥立即退役。通知密钥轮换时，已在途的通知仍可能使用旧签名，下一次投递尝试使用新密钥；接收端过渡期间应兼容新旧签名，密钥疑似泄露时应停止信任旧密钥。
            </CardDescription>
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
            <CardTitle>删除空网站</CardTitle>
            <CardDescription>
              有历史订单的网站只能暂停接单；删除后客户端 ID 不可复用。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="destructive"
              disabled={busy || requiresReview}
              onClick={() => setConfirmation("delete")}
            >
              删除空网站
            </Button>
          </CardContent>
        </Card>
      )}
      {revealed && (
        <Card>
          <CardHeader>
            <CardTitle>{revealed.label}</CardTitle>
            <CardDescription>
              仅在当前页面显示，请勿发送给其他网站。隐藏不会撤销已提交的生成或轮换操作。
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
                ? "删除网站"
                : confirmation === "save"
                  ? "保存配置"
                  : "生成或轮换密钥"}
              ？
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation === "delete"
                ? "此操作不能撤销，客户端 ID 不会再次使用。有历史订单的网站只能暂停接单。"
                : confirmation === "save"
                  ? impact
                  : confirmation === "webhook"
                    ? "下一次通知投递尝试将使用新密钥，已在途的请求仍可能使用旧签名。请在接收端过渡期间兼容新旧签名，密钥疑似泄露时应停止信任旧密钥。失败时不要盲目再次轮换，应先查看当前密钥。"
                    : "如果已有 API 密钥，本次会使其立即退役。请同步更新对应业务网站，失败时不要盲目再次轮换，应先查看当前密钥。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || requiresReview}
              onClick={() => {
                if (busy || requiresReview) return;
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

export function SiteDefaultsPage() {
  const query = useQuery({
    queryKey: ["site-defaults"],
    queryFn: ({ signal }) => result(api.getSiteDefaults({ signal })),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return (
    <QueryView query={query}>
      {(response) => <DefaultsEditor initial={response.data} />}
    </QueryView>
  );
}
function DefaultsEditor({
  initial,
}: {
  initial: { revision: number; policy: SitePolicy };
}) {
  const [section, setSection] = useState("orders");
  const formRef = useRef<HTMLFormElement>(null);
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(() => structuredClone(initial.policy));
  const clearDraft = useDirtyDraft(
    JSON.stringify(draft) !== JSON.stringify(saved.policy),
  );
  const [feedback, setFeedback] = useFeedback();
  const save = useMutation({
    networkMode: "always",
    retry: false,
    mutationFn: () =>
      result(
        api.updateSiteDefaults({
          body: { revision: saved.revision, policy: draft },
        }),
      ),
    onSuccess: (response) => {
      setSaved(response.data);
      setDraft(structuredClone(response.data.policy));
      clearDraft();
      setFeedback("模板已保存，已有网站不受影响。");
      queryClient.setQueryData(["site-defaults"], response);
    },
  });
  useEffect(() => {
    if (!(save.error instanceof ApiError)) return;
    const field = Object.keys(save.error.fields)[0];
    if (!field) return;
    setSection(
      field.includes("display.")
        ? "display"
        : field.includes("notification_delivery.")
          ? "integration"
          : "orders",
    );
  }, [save.error]);
  useEffect(() => {
    if (save.error)
      formRef.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?.focus();
  }, [section, save.error]);
  return (
    <div className="admin-settings-layout flex flex-col gap-6">
      <h2 className="text-2xl font-semibold">网站默认模板</h2>
      <p className="text-sm text-muted-foreground">
        仅用于新网站，已有网站不变。
      </p>
      <Tabs
        value={section}
        onValueChange={(value) => {
          if (value) setSection(value);
        }}
      >
        <TabsList aria-label="模板分组">
          <TabsTrigger value="orders">订单设置</TabsTrigger>
          <TabsTrigger value="display">收银台展示</TabsTrigger>
          <TabsTrigger value="integration">通知策略</TabsTrigger>
        </TabsList>
      </Tabs>
      <ErrorNotice error={save.error} />
      <SuccessMessage message={feedback} />
      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <FieldSet disabled={save.isPending}>
          <SitePolicyFields
            section={section}
            value={draft}
            errors={save.error instanceof ApiError ? save.error.fields : {}}
            onChange={setDraft}
          />
          <Button type="submit" className="w-fit" disabled={save.isPending}>
            保存默认模板
          </Button>
        </FieldSet>
      </form>
    </div>
  );
}
