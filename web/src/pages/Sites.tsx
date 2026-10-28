import CreateSite from "./CreateSite";
import { SiteManagementCards } from "@/components/site-management-cards";
import { CopyValue } from "@/components/copy-value";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation, useNavigation, useParams } from "react-router";
import { PageHeading } from "@/components/page-heading";
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
import { siteTimeoutError, siteTimeoutSeconds } from "@/lib/site-timeout";
import { SiteConfigurationConflicts } from "@/components/site-configuration-conflicts";
import { mergeSiteConfiguration, resolveSiteConflicts, type SiteConflictChoices } from "@/lib/site-configuration";
import { latestEditorSnapshot, siteEditorKey, siteEditorQueryOptions } from "@/lib/site-editor-query";
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
  return <SiteManagementCards />;
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
  const { clientId, section = "basic" } = useParams();
  const query = useQuery(siteEditorQueryOptions(clientId));
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
  const location = useLocation();
  const navigation = useNavigation();
  const currentNavigation = useRef({ key: location.key, pending: navigation.state !== "idle" });
  useLayoutEffect(() => {
    currentNavigation.current = { key: location.key, pending: navigation.state !== "idle" };
  }, [location.key, navigation.state]);
  const sections = [
    { value: "basic", label: "基本信息" },
    { value: "orders", label: "订单设置" },
    { value: "integration", label: "接入与通知" },
    { value: "display", label: "收银台展示" },
  ];
  const visible = (value: string) => section === "all" || section === value;
  const [saved, setSaved] = useState(initial);
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
        const originKey = currentNavigation.current.key;
        await result(
          api.deleteSite({ path, body: { revision: saved.revision } }),
        );
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
  return (
    <div className="admin-settings-layout flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeading title={sections.find((item) => item.value === section)?.label ?? "网站设置"} />
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
            <CardFooter>
              <Button type="submit" disabled={busy || requiresReview || !!timeoutError}>
                {save.isPending ? "正在保存…" : "保存业务网站"}
              </Button>
            </CardFooter>
          </Card>
        </FieldSet>
      </form>
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
