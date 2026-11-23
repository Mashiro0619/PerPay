import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Clock,
  Hash,
  MousePointerClick,
  Package,
  Plus,
  QrCode,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Smartphone,
  SunMoon,
  Undo2,
} from "lucide-react";
import {
  api,
  ApiError,
  queryClient,
  result,
  type Site,
  type SiteConfiguration,
  type SitePolicy,
} from "@/api/client";
import { useDirtyDraft } from "@/drafts";
import { useSuccessToast } from "@/components/Feedback";
import { ErrorNotice } from "@/components/request-state";
import { SiteConfigurationConflicts } from "@/components/site-configuration-conflicts";
import {
  CheckoutDisplayPreview,
  type CheckoutDisplayTarget,
  type CheckoutPreviewState,
  type CheckoutPreviewViewport,
} from "@/components/CheckoutDisplayPreview";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { isOperationResultUnknown, useOperationWait } from "@/hooks/use-operation-wait";
import { waitForOperation } from "@/lib/operation-timeout";
import {
  mergeSiteConfiguration,
  resolveSiteConflicts,
  type SiteConflictChoices,
} from "@/lib/site-configuration";
import { siteEditorKey } from "@/lib/site-editor-query";
import { cn } from "@/lib/utils";
import {
  CHECKOUT_HELP_LABEL_MAX_LENGTH,
  CHECKOUT_TEXT_MAX_LENGTH,
  DEFAULT_CHECKOUT_COPY,
  DEFAULT_CHECKOUT_HELP_LABEL,
  DEFAULT_SITE_CHECKOUT_DISPLAY_EXTRAS,
} from "../../../src/shared/checkout-display";

type DisplayToggleKey =
  | "checkout_show_product_name"
  | "checkout_show_merchant_order_no"
  | "checkout_show_countdown"
  | "checkout_show_amount_adjustment"
  | "checkout_show_qr_tools"
  | "checkout_show_alipay_launch"
  | "checkout_show_theme_toggle";

type DisplayCopyKey =
  | "checkout_payment_instructions"
  | "checkout_adjustment_hint"
  | "checkout_notice"
  | "checkout_confirmed_detail"
  | "checkout_expired_detail"
  | "checkout_disputed_detail"
  | "checkout_closed_detail";

type InspectorTab = "modules" | "copy" | "brand";

const MODULE_ITEMS: ReadonlyArray<{
  readonly key: DisplayToggleKey;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly icon: typeof Package;
  readonly previewState?: CheckoutPreviewState;
  readonly previewViewport?: CheckoutPreviewViewport;
}> = [
  {
    key: "checkout_show_product_name",
    label: "显示商品名称",
    shortLabel: "商品名称",
    description: "在订单信息区展示商品名称。",
    icon: Package,
  },
  {
    key: "checkout_show_merchant_order_no",
    label: "显示商家订单号",
    shortLabel: "商家订单号",
    description: "展示商家订单号与一键复制。",
    icon: Hash,
  },
  {
    key: "checkout_show_countdown",
    label: "显示剩余支付倒计时",
    shortLabel: "支付倒计时",
    description: "在待付款状态标签中显示剩余时间。",
    icon: Clock,
    previewState: "UNPAID",
  },
  {
    key: "checkout_show_amount_adjustment",
    label: "显示金额微调明细",
    shortLabel: "微调明细",
    description: "展示原价与自动核对微调拆解。",
    icon: SlidersHorizontal,
    previewState: "UNPAID",
  },
  {
    key: "checkout_show_qr_tools",
    label: "显示二维码工具栏",
    shortLabel: "二维码工具",
    description: "提供放大二维码与保存二维码操作。",
    icon: QrCode,
    previewState: "UNPAID",
  },
  {
    key: "checkout_show_alipay_launch",
    label: "显示“打开支付宝”按钮",
    shortLabel: "打开支付宝",
    description: "手机端待付款页提供一键跳转支付宝。",
    icon: Smartphone,
    previewState: "UNPAID",
    previewViewport: "mobile",
  },
  {
    key: "checkout_show_theme_toggle",
    label: "显示顶部外观切换",
    shortLabel: "外观切换",
    description: "在收银台右上角展示浅色/深色切换。",
    icon: SunMoon,
  },
];

const COPY_GROUPS: ReadonlyArray<{
  readonly title: string;
  readonly items: ReadonlyArray<{
    readonly key: DisplayCopyKey;
    readonly label: string;
    readonly placeholder: string;
    readonly hint?: string;
    readonly token?: { readonly text: string; readonly label: string };
    readonly previewState?: CheckoutPreviewState;
  }>;
}> = [
  {
    title: "待付款提示与公告",
    items: [
      {
        key: "checkout_payment_instructions",
        label: "待付款指引文案",
        placeholder: DEFAULT_CHECKOUT_COPY.paymentInstructionsDesktop,
        hint: "留空按设备自动使用默认指引。",
        token: { text: "{amount}", label: "插入实付金额 {amount}" },
        previewState: "UNPAID",
      },
      {
        key: "checkout_adjustment_hint",
        label: "金额微调提示文案",
        placeholder: "选填，例如：为自动核对已微调 +{offset}，请按此金额付款",
        hint: "选填；留空不额外展示（右侧明细区已展示微调）。",
        token: { text: "{offset}", label: "插入微调金额 {offset}" },
        previewState: "UNPAID",
      },
      {
        key: "checkout_notice",
        label: "收银台自定义公告",
        placeholder: "选填，例如：付款后 1 分钟内自动发货，如有疑问请联系客服。",
        hint: "展示在订单信息区底部，留空不展示。",
      },
    ],
  },
  {
    title: "订单结果说明",
    items: [
      {
        key: "checkout_confirmed_detail",
        label: "付款成功说明",
        placeholder: "选填，例如：权益已自动生效，请点击返回商家查看。",
        hint: "留空不额外展示说明。",
        previewState: "CONFIRMED",
      },
      {
        key: "checkout_expired_detail",
        label: "付款时间已过说明",
        placeholder: DEFAULT_CHECKOUT_COPY.expiredDetail,
        previewState: "EXPIRED",
      },
      {
        key: "checkout_disputed_detail",
        label: "付款待商家核实说明",
        placeholder: DEFAULT_CHECKOUT_COPY.disputedDetail,
        previewState: "DISPUTED",
      },
      {
        key: "checkout_closed_detail",
        label: "订单已关闭说明",
        placeholder: DEFAULT_CHECKOUT_COPY.closedDetail,
        previewState: "CLOSED",
      },
    ],
  },
];

function normalizeDisplay(display: SitePolicy["display"]): SitePolicy["display"] {
  return {
    ...DEFAULT_SITE_CHECKOUT_DISPLAY_EXTRAS,
    ...display,
  };
}

function targetTab(target: CheckoutDisplayTarget): InspectorTab {
  if (
    target === "checkout_name" ||
    target === "checkout_help_url" ||
    target === "checkout_help_label"
  ) {
    return "brand";
  }
  if (target.startsWith("checkout_show_")) return "modules";
  return "copy";
}

function targetPreviewState(
  target: CheckoutDisplayTarget,
): CheckoutPreviewState | undefined {
  switch (target) {
    case "checkout_show_countdown":
    case "checkout_show_amount_adjustment":
    case "checkout_show_qr_tools":
    case "checkout_show_alipay_launch":
    case "checkout_payment_instructions":
    case "checkout_adjustment_hint":
      return "UNPAID";
    case "checkout_confirmed_detail":
      return "CONFIRMED";
    case "checkout_expired_detail":
      return "EXPIRED";
    case "checkout_disputed_detail":
      return "DISPUTED";
    case "checkout_closed_detail":
      return "CLOSED";
    default:
      return undefined;
  }
}

function isSiteRevisionConflict(error: unknown) {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.code === "site_revision_conflict"
  );
}

export function CheckoutDisplayStudio({
  site,
  onCacheSite,
}: {
  site: Site;
  onCacheSite: (site: Site, signal?: AbortSignal) => Promise<Site>;
}) {
  const studioId = useId();
  const run = useOperationWait();
  const setFeedback = useSuccessToast();
  const inspectorRef = useRef<HTMLDivElement>(null);
  const reloadController = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  const [saved, setSaved] = useState(site);
  const [draftDisplay, setDraftDisplay] = useState<SitePolicy["display"]>(() =>
    normalizeDisplay(structuredClone(site.configuration.policy.display)),
  );
  const [previewState, setPreviewState] =
    useState<CheckoutPreviewState>("UNPAID");
  const [viewport, setViewport] = useState<CheckoutPreviewViewport>("desktop");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("modules");
  const [activeTarget, setActiveTarget] =
    useState<CheckoutDisplayTarget | null>(null);
  const [nameChecked, setNameChecked] = useState(false);

  const [needsReview, setNeedsReview] = useState(false);
  const [review, setReview] = useState<
    ({ site: Site } & ReturnType<typeof mergeSiteConfiguration>) | null
  >(null);
  const [choices, setChoices] = useState<SiteConflictChoices>({});

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      reloadController.current?.abort();
    };
  }, []);

  const savedNormalized = normalizeDisplay(saved.configuration.policy.display);
  const draftNormalized = normalizeDisplay(draftDisplay);
  const dirty =
    JSON.stringify(draftNormalized) !== JSON.stringify(savedNormalized);
  const clearDraft = useDirtyDraft(dirty);

  const buildConfiguration = (
    base: SiteConfiguration,
    display: SitePolicy["display"],
  ): SiteConfiguration => {
    const next = structuredClone(base);
    next.policy.display = structuredClone(display);
    return next;
  };

  const save = useMutation({
    networkMode: "always",
    retry: false,
    mutationFn: async () => {
      if (draftDisplay.checkout_name.trim() === "") {
        setNameChecked(true);
        setInspectorTab("brand");
        setActiveTarget("checkout_name");
        throw new Error("请输入收银台名称。");
      }
      void queryClient.invalidateQueries({
        queryKey: siteEditorKey(saved.client_id),
        refetchType: "none",
      });
      const configuration = buildConfiguration(
        saved.configuration,
        draftDisplay,
      );
      return run((signal) =>
        result(
          api.updateSite({
            path: { clientId: saved.client_id },
            body: { revision: saved.revision, configuration },
            signal,
          }),
        ),
      );
    },
    onError: (error) => {
      if (!isSiteRevisionConflict(error) && !isOperationResultUnknown(error)) {
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: siteEditorKey(saved.client_id),
        refetchType: "none",
      });
      if (!mounted.current) return;
      setNeedsReview(true);
      setReview(null);
      setChoices({});
      setFeedback("");
    },
    onSuccess: async (response) => {
      await onCacheSite(response.data);
      void queryClient.invalidateQueries({ queryKey: ["sites"] });
      if (!mounted.current) return;
      setSaved(response.data);
      setDraftDisplay(
        normalizeDisplay(structuredClone(response.data.configuration.policy.display)),
      );
      setNameChecked(false);
      setNeedsReview(false);
      setReview(null);
      setChoices({});
      clearDraft();
      setFeedback("收银台展示配置已保存");
    },
  });

  function applyReview(nextSite: Site, configuration: SiteConfiguration) {
    setSaved(nextSite);
    setDraftDisplay(normalizeDisplay(structuredClone(configuration.policy.display)));
    setReview(null);
    setChoices({});
    setNeedsReview(false);
    save.reset();
    const aligned =
      JSON.stringify(normalizeDisplay(configuration.policy.display)) ===
      JSON.stringify(normalizeDisplay(nextSite.configuration.policy.display));
    setFeedback(
      aligned
        ? "已重新读取，当前收银台展示配置与服务器一致。"
        : "最新配置已合并，尚未保存",
    );
  }

  const reload = useMutation({
    networkMode: "always",
    retry: false,
    mutationFn: async () => {
      const controller = new AbortController();
      reloadController.current = controller;
      try {
        return await waitForOperation(controller, async (signal) => {
          const response = await result(
            api.getSite({ path: { clientId: saved.client_id }, signal }),
          );
          signal.throwIfAborted();
          return onCacheSite(response.data, signal);
        });
      } finally {
        if (reloadController.current === controller) {
          reloadController.current = null;
        }
      }
    },
    onSuccess: (latestSite) => {
      if (!latestSite || !mounted.current) return;
      const merged = mergeSiteConfiguration(
        saved.configuration,
        buildConfiguration(saved.configuration, draftDisplay),
        latestSite.configuration,
        "display",
      );
      setChoices({});
      if (merged.conflicts.length) {
        setReview({ site: latestSite, ...merged });
      } else {
        applyReview(latestSite, merged.configuration);
      }
    },
  });

  const busy = save.isPending || reload.isPending;
  const writeResultUnknown = isOperationResultUnknown(save.error);
  const requiresReview =
    writeResultUnknown ||
    needsReview ||
    Boolean(review) ||
    (site.revision > saved.revision && dirty);

  // Sync cleanly when the site prop updates (e.g. saved from the overlay modal).
  useEffect(() => {
    if (busy || site.client_id !== saved.client_id) {
      if (site.client_id !== saved.client_id) {
        setSaved(site);
        setDraftDisplay(
          normalizeDisplay(structuredClone(site.configuration.policy.display)),
        );
        setNeedsReview(false);
        setReview(null);
        setChoices({});
        save.reset();
      }
      return;
    }
    if (site.revision <= saved.revision) return;
    if (dirty || needsReview) {
      setNeedsReview(true);
      if (review && site.revision > review.site.revision) {
        setReview(null);
        setChoices({});
      }
      return;
    }
    setSaved(site);
    setDraftDisplay(
      normalizeDisplay(structuredClone(site.configuration.policy.display)),
    );
  }, [site, saved, dirty, needsReview, review, busy, save]);

  const apiErrors = save.error instanceof ApiError ? save.error.fields : {};
  const fieldError = (field: CheckoutDisplayTarget) => {
    if (
      field === "checkout_name" &&
      nameChecked &&
      draftDisplay.checkout_name.trim() === ""
    ) {
      return "请输入收银台名称。";
    }
    return (
      apiErrors["configuration.policy.display." + field] ??
      apiErrors["policy.display." + field]
    );
  };

  useEffect(() => {
    if (!(save.error instanceof ApiError)) return;
    const first = Object.keys(save.error.fields)[0];
    if (!first) return;
    const match = first.match(/display\.([a-z0-9_]+)$/);
    const key = match?.[1] as CheckoutDisplayTarget | undefined;
    if (!key) return;
    setInspectorTab(targetTab(key));
    setActiveTarget(key);
    requestAnimationFrame(() => {
      inspectorRef.current
        ?.querySelector<HTMLElement>(`[data-studio-control="${key}"]`)
        ?.focus();
    });
  }, [save.error]);

  const updateDisplay = (
    edit: (next: SitePolicy["display"]) => void,
  ) => {
    if (busy || requiresReview) return;
    const next = structuredClone(draftNormalized);
    edit(next);
    setDraftDisplay(next);
    setFeedback("");
    save.reset();
  };

  const handleSelectTarget = (target: CheckoutDisplayTarget) => {
    setActiveTarget(target);
    const nextTab = targetTab(target);
    setInspectorTab(nextTab);
    const nextState = targetPreviewState(target);
    if (nextState) setPreviewState(nextState);
    if (target === "checkout_show_alipay_launch") setViewport("mobile");
    requestAnimationFrame(() => {
      const control = inspectorRef.current?.querySelector<HTMLElement>(
        `[data-studio-control="${target}"]`,
      );
      control?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      control?.focus();
    });
  };

  const hiddenModules = MODULE_ITEMS.filter(
    (item) => draftNormalized[item.key] === false,
  );
  const hasCustomCopy = Boolean(
    draftNormalized.checkout_help_label ||
      COPY_GROUPS.some((group) =>
        group.items.some((item) => Boolean(draftNormalized[item.key])),
      ),
  );

  return (
    <div className="checkout-studio-host min-w-0">
      <div
        className="checkout-studio"
        data-checkout-display-studio
        data-dirty={dirty || undefined}
      >
      <div className="checkout-studio-canvas-column flex min-w-0 flex-col gap-3">
        <CheckoutDisplayPreview
          display={draftNormalized}
          previewState={previewState}
          onPreviewStateChange={setPreviewState}
          viewport={viewport}
          onViewportChange={setViewport}
          activeTarget={activeTarget}
          onSelectTarget={handleSelectTarget}
        />

        <div className="checkout-studio-canvas-footer flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <MousePointerClick className="size-3.5 shrink-0" aria-hidden="true" />
            <span>点击预览画布中的任意元素，可直达对应配置</span>
          </span>
          {hiddenModules.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-1.5"
              aria-label="已隐藏模块快捷恢复"
            >
              <span className="text-muted-foreground">已隐藏：</span>
              {hiddenModules.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  disabled={busy || requiresReview}
                  className="checkout-studio-restore-chip"
                  onClick={() => {
                    updateDisplay((next) => {
                      next[item.key] = true;
                    });
                    setActiveTarget(item.key);
                    if (item.previewState) setPreviewState(item.previewState);
                    if (item.previewViewport) setViewport(item.previewViewport);
                  }}
                >
                  <Plus className="size-3" aria-hidden="true" />
                  <span>{item.shortLabel}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <Card
        ref={inspectorRef}
        className="checkout-studio-inspector min-w-0 gap-0 overflow-hidden py-0"
        data-checkout-studio-inspector
      >
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/25 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <CardTitle className="text-sm font-semibold">收银台配置</CardTitle>
            {dirty ? (
              <Badge variant="warning">未保存</Badge>
            ) : (
              <span className="text-xs text-muted-foreground">已同步</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {dirty && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setDraftDisplay(
                    normalizeDisplay(
                      structuredClone(saved.configuration.policy.display),
                    ),
                  );
                  setNameChecked(false);
                  save.reset();
                  setFeedback("");
                }}
              >
                <Undo2 aria-hidden="true" data-icon="inline-start" />
                撤销
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              disabled={busy || requiresReview || !dirty}
              onClick={() => save.mutate()}
            >
              {save.isPending ? (
                <Spinner aria-hidden="true" data-icon="inline-start" />
              ) : (
                <Save aria-hidden="true" data-icon="inline-start" />
              )}
              {save.isPending ? "保存中…" : "保存配置"}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="flex min-w-0 flex-col gap-3.5 px-4 py-4">
          <ErrorNotice
            error={
              save.error instanceof ApiError ||
              (save.error instanceof Error &&
                save.error.message !== "请输入收银台名称。")
                ? save.error
                : null
            }
          />
          <ErrorNotice error={reload.error} />

          {requiresReview && (
            <Alert>
              <AlertTitle>
                {writeResultUnknown ? "保存结果待确认" : "网站配置已变更"}
              </AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-2">
                <p>
                  {writeResultUnknown
                    ? "你的修改已保留。请读取最新配置核对保存结果，再决定是否重新提交。"
                    : "你的展示修改已保留。读取最新配置将合并无冲突项，冲突项需人工核对。"}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => reload.mutate()}
                >
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
                const resolved = resolveSiteConflicts(
                  review.configuration,
                  review.conflicts,
                  choices,
                );
                if (resolved) applyReview(review.site, resolved);
              }}
            />
          )}

          <Tabs
            value={inspectorTab}
            onValueChange={(value) => {
              if (value === "modules" || value === "copy" || value === "brand") {
                setInspectorTab(value);
              }
            }}
          >
            <TabsList
              aria-label="收银台可视化编辑分组"
              className="grid w-full grid-cols-3"
              activateOnFocus={false}
            >
              <TabsTrigger value="modules">模块</TabsTrigger>
              <TabsTrigger value="copy">文案</TabsTrigger>
              <TabsTrigger value="brand">品牌</TabsTrigger>
            </TabsList>

            <TabsContent value="modules" className="pt-3">
              <FieldSet disabled={busy || requiresReview} className="gap-2">
                <div
                  className="settings-display-sections"
                  role="group"
                  aria-label="收银台显示模块开关"
                >
                  {MODULE_ITEMS.map((item) => {
                    const Icon = item.icon;
                    const checked = draftNormalized[item.key] !== false;
                    const switchId = `${studioId}-${item.key}`;
                    const hintId = `${switchId}-hint`;
                    const active = activeTarget === item.key;
                    return (
                      <div
                        key={item.key}
                        className={cn(
                          "settings-display-section-row checkout-studio-module-row",
                          active && "checkout-studio-row-active",
                        )}
                        data-checked={checked || undefined}
                        onMouseEnter={() => setActiveTarget(item.key)}
                        onMouseLeave={() =>
                          setActiveTarget((current) =>
                            current === item.key ? null : current,
                          )
                        }
                      >
                        <span
                          className="checkout-studio-module-icon"
                          aria-hidden="true"
                        >
                          <Icon className="size-4" />
                        </span>
                        <div className="settings-display-section-copy">
                          <FieldLabel
                            htmlFor={switchId}
                            className="settings-display-section-label"
                          >
                            {item.label}
                          </FieldLabel>
                          <FieldDescription
                            id={hintId}
                            className="settings-display-section-desc"
                          >
                            {item.description}
                          </FieldDescription>
                        </div>
                        <Switch
                          id={switchId}
                          data-studio-control={item.key}
                          disabled={busy || requiresReview}
                          checked={checked}
                          aria-describedby={hintId}
                          onFocus={() => setActiveTarget(item.key)}
                          onCheckedChange={(nextChecked) => {
                            updateDisplay((next) => {
                              next[item.key] = nextChecked;
                            });
                            setActiveTarget(item.key);
                            if (item.previewState) {
                              setPreviewState(item.previewState);
                            }
                            if (item.previewViewport) {
                              setViewport(item.previewViewport);
                            }
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              </FieldSet>
            </TabsContent>

            <TabsContent value="copy" className="pt-3">
              <FieldSet disabled={busy || requiresReview} className="gap-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    留空即使用系统默认文案；聚焦输入框自动切换到对应预览状态。
                  </p>
                  {hasCustomCopy && (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={busy || requiresReview}
                      onClick={() =>
                        updateDisplay((next) => {
                          next.checkout_help_label = null;
                          next.checkout_payment_instructions = null;
                          next.checkout_adjustment_hint = null;
                          next.checkout_notice = null;
                          next.checkout_confirmed_detail = null;
                          next.checkout_expired_detail = null;
                          next.checkout_disputed_detail = null;
                          next.checkout_closed_detail = null;
                        })
                      }
                    >
                      <RotateCcw aria-hidden="true" data-icon="inline-start" />
                      全部恢复默认
                    </Button>
                  )}
                </div>

                {COPY_GROUPS.map((group, groupIndex) => (
                  <div key={group.title} className="flex flex-col gap-3.5">
                    {groupIndex > 0 && <Separator />}
                    <p className="text-xs font-medium text-muted-foreground">
                      {group.title}
                    </p>
                    {group.items.map((item) => {
                      const controlId = `${studioId}-${item.key}`;
                      const hintId = `${controlId}-hint`;
                      const errorId = `${controlId}-error`;
                      const currentValue = draftNormalized[item.key] ?? "";
                      const err = fieldError(item.key);
                      const active = activeTarget === item.key;
                      const describedBy =
                        [item.hint && hintId, err && errorId]
                          .filter(Boolean)
                          .join(" ") || undefined;
                      return (
                        <Field
                          key={item.key}
                          data-invalid={!!err}
                          data-active={active || undefined}
                          className={cn(
                            "checkout-studio-field",
                            active && "checkout-studio-field-active",
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <FieldLabel htmlFor={controlId}>
                              {item.label}
                            </FieldLabel>
                            {currentValue.length > 0 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                className="h-auto px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                                disabled={busy || requiresReview}
                                onClick={() =>
                                  updateDisplay((next) => {
                                    next[item.key] = null;
                                  })
                                }
                              >
                                恢复默认
                              </Button>
                            )}
                          </div>
                          <Textarea
                            id={controlId}
                            data-studio-control={item.key}
                            aria-label={item.label}
                            aria-invalid={!!err}
                            aria-describedby={describedBy}
                            rows={2}
                            maxLength={CHECKOUT_TEXT_MAX_LENGTH}
                            placeholder={item.placeholder}
                            value={currentValue}
                            disabled={busy || requiresReview}
                            onFocus={() => {
                              setActiveTarget(item.key);
                              if (item.previewState) {
                                setPreviewState(item.previewState);
                              }
                            }}
                            onChange={(event) =>
                              updateDisplay((next) => {
                                next[item.key] =
                                  event.target.value === ""
                                    ? null
                                    : event.target.value;
                              })
                            }
                          />
                          {item.token && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <button
                                type="button"
                                disabled={busy || requiresReview}
                                className="checkout-studio-token-chip"
                                onClick={() => {
                                  const appended = currentValue
                                    ? `${currentValue}${item.token!.text}`
                                    : item.key === "checkout_payment_instructions"
                                      ? `请严格按 ${item.token!.text} 付款`
                                      : `为自动核对已微调 +${item.token!.text}`;
                                  updateDisplay((next) => {
                                    next[item.key] = appended.slice(
                                      0,
                                      CHECKOUT_TEXT_MAX_LENGTH,
                                    );
                                  });
                                  setActiveTarget(item.key);
                                  if (item.previewState) {
                                    setPreviewState(item.previewState);
                                  }
                                }}
                              >
                                <Plus className="size-3" aria-hidden="true" />
                                <span>{item.token.label}</span>
                              </button>
                            </div>
                          )}
                          {item.hint && (
                            <FieldDescription id={hintId}>
                              {item.hint}
                            </FieldDescription>
                          )}
                          {err && <FieldError id={errorId}>{err}</FieldError>}
                        </Field>
                      );
                    })}
                  </div>
                ))}
              </FieldSet>
            </TabsContent>

            <TabsContent value="brand" className="pt-3">
              <FieldSet disabled={busy || requiresReview}>
                <FieldGroup className="gap-4">
                  <Field
                    data-invalid={!!fieldError("checkout_name")}
                    className={cn(
                      "checkout-studio-field",
                      activeTarget === "checkout_name" &&
                        "checkout-studio-field-active",
                    )}
                  >
                    <FieldLabel htmlFor={`${studioId}-checkout_name`}>
                      收银台名称
                    </FieldLabel>
                    <Input
                      id={`${studioId}-checkout_name`}
                      data-studio-control="checkout_name"
                      aria-label="收银台名称"
                      aria-invalid={!!fieldError("checkout_name")}
                      aria-describedby={
                        fieldError("checkout_name")
                          ? `${studioId}-checkout_name-error`
                          : undefined
                      }
                      required
                      maxLength={40}
                      value={draftNormalized.checkout_name}
                      onFocus={() => setActiveTarget("checkout_name")}
                      onChange={(event) => {
                        setNameChecked(true);
                        updateDisplay((next) => {
                          next.checkout_name = event.target.value;
                        });
                      }}
                    />
                    {fieldError("checkout_name") && (
                      <FieldError id={`${studioId}-checkout_name-error`}>
                        {fieldError("checkout_name")}
                      </FieldError>
                    )}
                  </Field>

                  <Field
                    data-invalid={!!fieldError("checkout_help_url")}
                    className={cn(
                      "checkout-studio-field",
                      activeTarget === "checkout_help_url" &&
                        "checkout-studio-field-active",
                    )}
                  >
                    <FieldLabel htmlFor={`${studioId}-checkout_help_url`}>
                      帮助链接
                    </FieldLabel>
                    <Input
                      id={`${studioId}-checkout_help_url`}
                      data-studio-control="checkout_help_url"
                      aria-label="帮助链接"
                      aria-invalid={!!fieldError("checkout_help_url")}
                      aria-describedby={
                        [
                          `${studioId}-checkout_help_url-hint`,
                          fieldError("checkout_help_url") &&
                            `${studioId}-checkout_help_url-error`,
                        ]
                          .filter(Boolean)
                          .join(" ")
                      }
                      type="url"
                      placeholder="https://help.example.com"
                      value={draftNormalized.checkout_help_url ?? ""}
                      onFocus={() => setActiveTarget("checkout_help_url")}
                      onChange={(event) =>
                        updateDisplay((next) => {
                          next.checkout_help_url =
                            event.target.value.trim() === ""
                              ? null
                              : event.target.value;
                        })
                      }
                    />
                    <FieldDescription id={`${studioId}-checkout_help_url-hint`}>
                      配置后会展示在收银台卡片右下角，方便付款人联系商家客服或查看指引。
                    </FieldDescription>
                    {fieldError("checkout_help_url") && (
                      <FieldError id={`${studioId}-checkout_help_url-error`}>
                        {fieldError("checkout_help_url")}
                      </FieldError>
                    )}
                  </Field>

                  <Field
                    data-invalid={!!fieldError("checkout_help_label")}
                    className={cn(
                      "checkout-studio-field",
                      activeTarget === "checkout_help_label" &&
                        "checkout-studio-field-active",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <FieldLabel htmlFor={`${studioId}-checkout_help_label`}>
                        帮助链接文案
                      </FieldLabel>
                      {draftNormalized.checkout_help_label && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="h-auto px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                          disabled={busy || requiresReview}
                          onClick={() =>
                            updateDisplay((next) => {
                              next.checkout_help_label = null;
                            })
                          }
                        >
                          恢复默认
                        </Button>
                      )}
                    </div>
                    <Input
                      id={`${studioId}-checkout_help_label`}
                      data-studio-control="checkout_help_label"
                      aria-label="帮助链接文案"
                      aria-invalid={!!fieldError("checkout_help_label")}
                      aria-describedby={
                        [
                          `${studioId}-checkout_help_label-hint`,
                          fieldError("checkout_help_label") &&
                            `${studioId}-checkout_help_label-error`,
                        ]
                          .filter(Boolean)
                          .join(" ")
                      }
                      maxLength={CHECKOUT_HELP_LABEL_MAX_LENGTH}
                      placeholder={`默认：${DEFAULT_CHECKOUT_HELP_LABEL}`}
                      value={draftNormalized.checkout_help_label ?? ""}
                      onFocus={() => setActiveTarget("checkout_help_label")}
                      onChange={(event) =>
                        updateDisplay((next) => {
                          next.checkout_help_label =
                            event.target.value === ""
                              ? null
                              : event.target.value;
                        })
                      }
                    />
                    <FieldDescription
                      id={`${studioId}-checkout_help_label-hint`}
                    >
                      仅在配置有效帮助链接后展示；留空使用“{DEFAULT_CHECKOUT_HELP_LABEL}”。
                    </FieldDescription>
                    {fieldError("checkout_help_label") && (
                      <FieldError id={`${studioId}-checkout_help_label-error`}>
                        {fieldError("checkout_help_label")}
                      </FieldError>
                    )}
                  </Field>
                </FieldGroup>
              </FieldSet>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
