import { useEffect, useRef, useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { useId } from "react";
import type { SitePolicy } from "@/api/client";
import { integerUnits, siteTimeoutError, siteTimeoutSeconds } from "@/lib/site-timeout";
import {
  CHECKOUT_HELP_LABEL_MAX_LENGTH,
  CHECKOUT_TEXT_MAX_LENGTH,
  DEFAULT_CHECKOUT_COPY,
  DEFAULT_CHECKOUT_HELP_LABEL,
} from "../../../src/shared/checkout-display";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  CheckoutDisplayPreview,
  type CheckoutPreviewState,
  type CheckoutPreviewViewport,
} from "@/components/CheckoutDisplayPreview";
import { cn } from "@/lib/utils";

type SiteDisplayToggleKey =
  | "checkout_show_product_name"
  | "checkout_show_merchant_order_no"
  | "checkout_show_countdown"
  | "checkout_show_amount_adjustment"
  | "checkout_show_qr_tools"
  | "checkout_show_alipay_launch"
  | "checkout_show_theme_toggle";

type SiteDisplayCopyKey =
  | "checkout_payment_instructions"
  | "checkout_adjustment_hint"
  | "checkout_notice"
  | "checkout_confirmed_detail"
  | "checkout_expired_detail"
  | "checkout_disputed_detail"
  | "checkout_closed_detail";

const SITE_DISPLAY_TOGGLES: ReadonlyArray<{
  readonly key: SiteDisplayToggleKey;
  readonly label: string;
  readonly description: string;
}> = [
  {
    key: "checkout_show_product_name",
    label: "显示商品名称",
    description: "在订单信息区展示下单传入的商品名称。",
  },
  {
    key: "checkout_show_merchant_order_no",
    label: "显示商家订单号",
    description: "在订单信息区展示商家订单号与复制按钮。",
  },
  {
    key: "checkout_show_countdown",
    label: "显示剩余支付倒计时",
    description: "在待付款状态标签中显示剩余支付时间。",
  },
  {
    key: "checkout_show_amount_adjustment",
    label: "显示金额微调明细",
    description: "在订单信息区展示原价与自动核对微调拆解；应付金额始终保留以防付错。",
  },
  {
    key: "checkout_show_qr_tools",
    label: "显示二维码工具栏",
    description: "在二维码下方提供“放大二维码”与“保存二维码”操作。",
  },
  {
    key: "checkout_show_alipay_launch",
    label: "显示“打开支付宝”快捷按钮",
    description: "在手机端待付款页展示免扫码一键跳转支付宝按钮。",
  },
  {
    key: "checkout_show_theme_toggle",
    label: "显示顶部外观切换",
    description: "在收银台右上角展示浅色/深色外观切换按钮。",
  },
];

const SITE_DISPLAY_COPY_FIELDS: ReadonlyArray<{
  readonly key: SiteDisplayCopyKey;
  readonly label: string;
  readonly placeholder: string;
  readonly hint?: string;
}> = [
  {
    key: "checkout_payment_instructions",
    label: "待付款指引文案",
    placeholder: DEFAULT_CHECKOUT_COPY.paymentInstructionsDesktop,
    hint: "支持 {amount} 代表实付金额；留空按设备自动使用系统默认指引。",
  },
  {
    key: "checkout_adjustment_hint",
    label: "金额微调提示文案",
    placeholder: "选填，例如：为自动核对已微调 +{offset}，请按此金额付款",
    hint: "选填，支持 {offset} 代表微调金额（如 ¥0.01）；留空不额外展示（右侧明细区已展示微调）。",
  },
  {
    key: "checkout_notice",
    label: "收银台自定义公告",
    placeholder: "选填，例如：付款后 1 分钟内自动发货，如有疑问请联系客服。",
    hint: "选填；填写后展示在订单信息区底部，留空不展示。",
  },
  {
    key: "checkout_confirmed_detail",
    label: "付款成功说明",
    placeholder: "选填，例如：权益已自动生效，请点击返回商家查看。",
    hint: "默认关闭无文案；留空不展示说明。",
  },
  {
    key: "checkout_expired_detail",
    label: "付款时间已过说明",
    placeholder: DEFAULT_CHECKOUT_COPY.expiredDetail,
  },
  {
    key: "checkout_disputed_detail",
    label: "付款待商家核实说明",
    placeholder: DEFAULT_CHECKOUT_COPY.disputedDetail,
  },
  {
    key: "checkout_closed_detail",
    label: "订单已关闭说明",
    placeholder: DEFAULT_CHECKOUT_COPY.closedDetail,
  },
];

export function SitePolicyFields({
  value,
  onChange,
  errors = {},
  section,
  expandedNotificationPolicy = false,
  disabled = false,
  secondsDraft,
  onSecondsDraftChange,
  timeoutSubmitted = false,
}: {
  section?: string | undefined;
  expandedNotificationPolicy?: boolean;
  disabled?: boolean;
  value: SitePolicy;
  onChange: (value: SitePolicy) => void;
  errors?: Readonly<Record<string, string>>;
  secondsDraft?: string;
  onSecondsDraftChange?: (raw: string) => void;
  timeoutSubmitted?: boolean;
}) {
  const limitId = useId();
  const zeroOffsetId = useId();
  const timeoutId = useId();
  const displayId = useId();
  const hasCustomCheckoutCopy = Boolean(
    value.display.checkout_help_label ||
      SITE_DISPLAY_COPY_FIELDS.some((item) => Boolean(value.display[item.key])),
  );
  const timeoutRaw = secondsDraft ?? siteTimeoutSeconds(value.notification_delivery.timeout_milliseconds);
  const [timeoutTouched, setTimeoutTouched] = useState(false);
  const clientTimeoutError = siteTimeoutError(timeoutRaw);
  const serverTimeoutError =
    errors["configuration.policy.notification_delivery.timeout_milliseconds"] ??
    errors["policy.notification_delivery.timeout_milliseconds"];
  const timeoutError =
    (timeoutTouched || timeoutSubmitted ? clientTimeoutError : undefined) ??
    serverTimeoutError;
  const [advanced, setAdvanced] = useState(false);
  const [displaySubTab, setDisplaySubTab] = useState<
    "basic" | "modules" | "copy" | "preview"
  >("basic");
  const [previewState, setPreviewState] =
    useState<CheckoutPreviewState>("UNPAID");
  const [previewViewport, setPreviewViewport] =
    useState<CheckoutPreviewViewport>("desktop");
  const notificationPolicyOpen = expandedNotificationPolicy || advanced;
  const content = useRef<HTMLDivElement>(null);
  const failedAdvanced = Object.keys(errors).some((key) =>
    key.includes("notification_delivery."),
  );
  useEffect(() => {
    const displayErrorKey = Object.keys(errors).find((key) =>
      key.includes("display."),
    );
    if (!displayErrorKey) return;
    if (
      displayErrorKey.endsWith(".checkout_name") ||
      displayErrorKey.endsWith(".checkout_help_url") ||
      displayErrorKey.endsWith(".checkout_show_product_name")
    ) {
      setDisplaySubTab("basic");
    } else if (displayErrorKey.includes("checkout_show_")) {
      setDisplaySubTab("modules");
    } else {
      setDisplaySubTab("copy");
    }
  }, [errors]);
  useEffect(() => {
    if (failedAdvanced || (timeoutSubmitted && clientTimeoutError)) setAdvanced(true);
  }, [errors, failedAdvanced, timeoutSubmitted, clientTimeoutError]);
  useEffect(() => {
    if (notificationPolicyOpen && (failedAdvanced || (timeoutSubmitted && clientTimeoutError)))
      content.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?.focus();
  }, [notificationPolicyOpen, failedAdvanced, errors, timeoutSubmitted, clientTimeoutError]);
  const error = (path: string) =>
    errors["configuration.policy." + path] ?? errors["policy." + path];
  const change = (edit: (next: SitePolicy) => void) => {
    if (disabled) return;
    const next = structuredClone(value);
    edit(next);
    onChange(next);
  };
  return (
    <FieldGroup>
      {(!section || section === "orders") && (
        <FieldSet className="settings-fields" disabled={disabled}>
          <FieldLegend className={section ? "sr-only" : undefined}>订单设置</FieldLegend>
          <Field orientation="horizontal" className="col-span-full settings-toggle-card" data-disabled={disabled}>
            <FieldContent>
              <FieldLabel htmlFor={zeroOffsetId}>允许原价起（从 ¥0.00 开始加价）</FieldLabel>
              <FieldDescription id={zeroOffsetId + "-hint"}>
                关闭时默认从 +¥0.01 起加价，以避开个人日常整数收款撞单；开启后首笔订单按原价收款，同金额并发时再依次 +¥0.01 递增。
              </FieldDescription>
            </FieldContent>
            <Switch
              id={zeroOffsetId}
              aria-describedby={zeroOffsetId + "-hint"}
              disabled={disabled}
              checked={Boolean(value.orders.allow_zero_amount_offset)}
              onCheckedChange={(checked) =>
                change((p) => {
                  p.orders.allow_zero_amount_offset = checked;
                  if (!checked && p.orders.amount_offset_maximum_cents < 1) {
                    p.orders.amount_offset_maximum_cents = 1;
                  }
                })
              }
            />
          </Field>
          <NumberField
            label="收银台有效期（秒）"
            error={error("orders.order_ttl_seconds")}
            value={value.orders.order_ttl_seconds}
            min={60}
            max={1800}
            onChange={(n) =>
              change((p) => {
                p.orders.order_ttl_seconds = n;
              })
            }
          />
          <NumberField
            label="最大加价金额（分）"
            hint={value.orders.allow_zero_amount_offset
              ? "已开启原价起：首笔按原价（+0 分）收款，同金额并发时依次递增至此处设定值（0～99 分；设为 0 表示完全不加价，同金额同时仅限 1 笔待付款）。"
              : "每笔订单默认在原金额上加价 1 分起以区分付款，同金额并发时依次递增，上限为此处设定值（1～99 分）。"}
            error={error("orders.amount_offset_maximum_cents")}
            value={value.orders.amount_offset_maximum_cents}
            min={value.orders.allow_zero_amount_offset ? 0 : 1}
            max={99}
            onChange={(n) =>
              change((p) => {
                p.orders.amount_offset_maximum_cents = n;
              })
            }
          />
          <NumberField
            label="同金额冷却时长（秒）"
            hint="收银台关闭后，需等待此时长才允许新订单再次分配相同应付金额；过期订单从原到期时间起算，仅对新订单生效。"
            error={error("orders.amount_reuse_cooldown_seconds")}
            value={value.orders.amount_reuse_cooldown_seconds}
            min={60}
            max={3600}
            onChange={(n) =>
              change((p) => {
                p.orders.amount_reuse_cooldown_seconds = n;
              })
            }
          />

            <Field data-invalid={!!error("orders.pending_order_limit")}>
            <FieldLabel htmlFor={limitId}>待付款订单上限（笔）</FieldLabel>
            <Input
              id={limitId}
              name="pending_order_limit"
              aria-invalid={!!error("orders.pending_order_limit")}
              aria-describedby={
                [limitId + "-hint", error("orders.pending_order_limit") ? limitId + "-error" : ""]
                  .filter(Boolean)
                  .join(" ")
              }
              type="number"
              min={1}
              step={1}
              value={value.orders.pending_order_limit ?? ""}
              onChange={(e) =>
                change((p) => {
                  p.orders.pending_order_limit =
                    e.target.value === "" ? null : Number(e.target.value);
                })
              }
            />
            <FieldDescription id={limitId + "-hint"}>单个网站同时允许处于待付款状态的订单总数上限，留空表示不限。</FieldDescription>
            {error("orders.pending_order_limit") && (
              <FieldError id={limitId + "-error"}>
                {error("orders.pending_order_limit")}
              </FieldError>
            )}
          </Field>
        </FieldSet>
      )}
      {(!section || section === "display") && (
        <FieldSet disabled={disabled} className="gap-4">
          <FieldLegend className={section ? "sr-only" : undefined}>收银台展示</FieldLegend>
          <Tabs
            value={displaySubTab}
            onValueChange={(next) => {
              if (
                next === "basic" ||
                next === "modules" ||
                next === "copy" ||
                next === "preview"
              ) {
                setDisplaySubTab(next);
              }
            }}
          >
            <TabsList
              aria-label="收银台展示子分组"
              className="grid w-full grid-cols-4"
              activateOnFocus={false}
            >
              <TabsTrigger value="basic">基础</TabsTrigger>
              <TabsTrigger value="modules">模块</TabsTrigger>
              <TabsTrigger value="copy">文案</TabsTrigger>
              <TabsTrigger value="preview">预览</TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="pt-3">
              <div className="flex flex-col gap-4">
                <SiteTextField
                  label="收银台名称"
                  fullWidth
                  required
                  maxLength={40}
                  error={error("display.checkout_name")}
                  value={value.display.checkout_name}
                  onChange={(text) =>
                    change((p) => {
                      p.display.checkout_name = text;
                    })
                  }
                />
                <SiteTextField
                  label="帮助链接"
                  type="url"
                  placeholder="https://help.example.com"
                  error={error("display.checkout_help_url")}
                  value={value.display.checkout_help_url ?? ""}
                  onChange={(text) =>
                    change((p) => {
                      p.display.checkout_help_url = text || null;
                    })
                  }
                />
                <Field orientation="horizontal" data-disabled={disabled}>
                  <FieldLabel htmlFor={displayId + "-show-product-basic"}>
                    显示商品名称
                  </FieldLabel>
                  <Switch
                    id={displayId + "-show-product-basic"}
                    disabled={disabled}
                    checked={value.display.checkout_show_product_name}
                    onCheckedChange={(checked) =>
                      change((p) => {
                        p.display.checkout_show_product_name = checked;
                      })
                    }
                  />
                </Field>
              </div>
            </TabsContent>

            <TabsContent value="modules" className="pt-3">
              <Field orientation="vertical" className="gap-2" data-disabled={disabled}>
                <span id={displayId + "-modules-label"} className="sr-only">
                  收银台显示模块
                </span>
                <FieldContent className="min-w-0">
                  <div
                    role="group"
                    aria-labelledby={displayId + "-modules-label"}
                    className="settings-display-sections"
                    data-site-display-toggles
                  >
                    {SITE_DISPLAY_TOGGLES.map((item) => {
                      const checked = value.display[item.key] ?? true;
                      const switchId = `${displayId}-${item.key}`;
                      const hintId = `${switchId}-hint`;
                      return (
                        <div
                          key={item.key}
                          className="settings-display-section-row"
                          data-checked={checked || undefined}
                        >
                          <div className="settings-display-section-copy">
                            <FieldLabel htmlFor={switchId} className="settings-display-section-label">
                              {item.label}
                            </FieldLabel>
                            <FieldDescription id={hintId} className="settings-display-section-desc">
                              {item.description}
                            </FieldDescription>
                          </div>
                          <Switch
                            id={switchId}
                            disabled={disabled}
                            checked={checked}
                            aria-describedby={hintId}
                            onCheckedChange={(nextChecked) =>
                              change((p) => {
                                p.display[item.key] = nextChecked;
                              })
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                </FieldContent>
              </Field>
            </TabsContent>

            <TabsContent value="copy" className="pt-3">
              <div className="flex flex-col gap-4" data-site-display-copy>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    所有文案均提供系统默认内容；留空即使用默认文案，可随时恢复默认。
                  </p>
                  {hasCustomCheckoutCopy && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={disabled}
                      onClick={() =>
                        change((p) => {
                          p.display.checkout_help_label = null;
                          for (const item of SITE_DISPLAY_COPY_FIELDS) {
                            p.display[item.key] = null;
                          }
                        })
                      }
                    >
                      <RotateCcw aria-hidden="true" data-icon="inline-start" />
                      恢复全部默认文案
                    </Button>
                  )}
                </div>
                <OptionalCopyField
                  id={displayId + "-help-label"}
                  label="帮助链接文案"
                  placeholder={`默认：${DEFAULT_CHECKOUT_HELP_LABEL}`}
                  hint="仅在配置帮助链接后展示；留空使用“商家帮助”。"
                  maxLength={CHECKOUT_HELP_LABEL_MAX_LENGTH}
                  value={value.display.checkout_help_label ?? ""}
                  error={error("display.checkout_help_label")}
                  disabled={disabled}
                  multiline={false}
                  onChange={(text) =>
                    change((p) => {
                      p.display.checkout_help_label = text === "" ? null : text;
                    })
                  }
                />
                {SITE_DISPLAY_COPY_FIELDS.map((item) => (
                  <OptionalCopyField
                    key={item.key}
                    id={`${displayId}-${item.key}`}
                    label={item.label}
                    placeholder={item.placeholder}
                    hint={item.hint}
                    maxLength={CHECKOUT_TEXT_MAX_LENGTH}
                    value={value.display[item.key] ?? ""}
                    error={error(`display.${item.key}`)}
                    disabled={disabled}
                    onChange={(text) =>
                      change((p) => {
                        p.display[item.key] = text === "" ? null : text;
                      })
                    }
                  />
                ))}
              </div>
            </TabsContent>

            <TabsContent value="preview" className="pt-3">
              <CheckoutDisplayPreview
                display={value.display}
                previewState={previewState}
                onPreviewStateChange={setPreviewState}
                viewport={previewViewport}
                onViewportChange={setPreviewViewport}
                compact
              />
            </TabsContent>
          </Tabs>
        </FieldSet>
      )}
      {(!section || section === "integration") && (
        <Collapsible
          open={notificationPolicyOpen}
          onOpenChange={setAdvanced}
          onInvalidCapture={(event) => {
            const target = event.target as HTMLInputElement;
            if (!isFirstInvalidControl(target)) return;
            setAdvanced(true);
            requestAnimationFrame(() => target.focus());
          }}
        >
          {!expandedNotificationPolicy && (
            <CollapsibleTrigger
              render={<Button type="button" variant="outline" size="sm" />}
            >
              通知超时与重试设置
              <ChevronDown
                data-icon="inline-end"
                className={cn("transition-transform motion-reduce:transition-none", notificationPolicyOpen && "rotate-180")}
                aria-hidden="true"
              />
            </CollapsibleTrigger>
          )}
          <CollapsibleContent ref={content} keepMounted>
            <FieldSet className={cn("settings-fields", !expandedNotificationPolicy && "pt-4")} disabled={disabled}>
              <FieldLegend className="sr-only">通知发送设置</FieldLegend>
              <Field data-invalid={!!timeoutError}>
                <FieldLabel htmlFor={timeoutId}>通知超时（秒）</FieldLabel>
                <Input
                  id={timeoutId}
                  name="timeout_seconds"
                  data-site-timeout-input
                  aria-invalid={!!timeoutError}
                  aria-describedby={timeoutError ? timeoutId + "-error" : undefined}
                  type="number"
                  inputMode="decimal"
                  min={1}
                  max={30}
                  step={0.001}
                  required
                  value={timeoutRaw}
                  onBlur={() => setTimeoutTouched(true)}
                  onChange={(event) => {
                    if (disabled) return;
                    const raw = event.target.value;
                    onSecondsDraftChange?.(raw);
                    if (siteTimeoutError(raw)) return;
                    setTimeoutTouched(false);
                    const milliseconds = integerUnits(raw, 1000)!;
                    change((p) => {
                      p.notification_delivery.timeout_milliseconds = milliseconds;
                    });
                  }}
                />
                {timeoutError && <FieldError id={timeoutId + "-error"}>{timeoutError}</FieldError>}
              </Field>
              <NumberField
                label="最多发送次数（次）"
                hint="包含首次发送在内的最大尝试总次数；全部失败后将停止自动重试。"
                error={error("notification_delivery.maximum_attempts")}
                value={value.notification_delivery.maximum_attempts}
                min={1}
                max={100}
                onChange={(n) =>
                  change((p) => {
                    p.notification_delivery.maximum_attempts = n;
                  })
                }
              />
              <NumberField
                label="首次重试间隔（秒）"
                error={error("notification_delivery.retry_base_seconds")}
                value={value.notification_delivery.retry_base_seconds}
                min={1}
                max={3600}
                onChange={(n) =>
                  change((p) => {
                    p.notification_delivery.retry_base_seconds = n;
                  })
                }
              />
              <NumberField
                label="最大重试间隔（秒）"
                error={error("notification_delivery.retry_maximum_seconds")}
                value={value.notification_delivery.retry_maximum_seconds}
                min={1}
                max={86400}
                onChange={(n) =>
                  change((p) => {
                    p.notification_delivery.retry_maximum_seconds = n;
                  })
                }
              />
            </FieldSet>
          </CollapsibleContent>
        </Collapsible>
      )}
    </FieldGroup>
  );
}
function NumberField({
  label,
  value,
  min,
  max,
  onChange,
  error,
  hint,
}: {
  hint?: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  error?: string | undefined;
}) {
  const errorId = useId(),
    inputId = errorId + "-input";
  const [requiredChecked, setRequiredChecked] = useState(false);
  const fieldError = error || (requiredChecked && !Number.isFinite(value) ? `请输入${label}。` : undefined);
  return (
    <Field data-invalid={!!fieldError}>
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
      <Input
        id={inputId}
        aria-describedby={
          [hint && errorId + "-hint", fieldError && errorId]
            .filter(Boolean)
            .join(" ") || undefined
        }
        aria-invalid={!!fieldError}
        required
        type="number"
        min={min}
        max={max}
        step={1}
        value={Number.isFinite(value) ? value : ""}
        onInvalid={(event) => {
          if (!event.currentTarget.validity.valueMissing) return;
          event.preventDefault();
          setRequiredChecked(true);
          if (isFirstInvalidControl(event.currentTarget)) event.currentTarget.focus();
        }}
        onChange={(e) =>
          onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))
        }
      />
      {hint && (
        <FieldDescription id={errorId + "-hint"}>{hint}</FieldDescription>
      )}
      {fieldError && <FieldError id={errorId}>{fieldError}</FieldError>}
    </Field>
  );
}

export function SiteTextField({
  label,
  value,
  onChange,
  error,
  required,
  maxLength,
  type = "text",
  placeholder,
  fullWidth = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  required?: boolean;
  maxLength?: number;
  type?: "text" | "url";
  placeholder?: string;
  fullWidth?: boolean;
}) {
  const id = useId(),
    errorId = id + "-error";
  const [requiredChecked, setRequiredChecked] = useState(false);
  const missingRequired = !!required && value.trim().length === 0;
  const fieldError = error || (requiredChecked && missingRequired ? `请输入${label}。` : undefined);
  return (
    <Field
      className={cn(type === "text" && !fullWidth && "max-w-md")}
      data-invalid={!!fieldError}
    >
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        aria-invalid={!!fieldError}
        aria-describedby={fieldError ? errorId : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        type={type}
        autoCorrect={type === "url" ? "off" : undefined}
        autoCapitalize={type === "url" ? "none" : undefined}
        spellCheck={type === "url" ? false : undefined}
        required={required}
        pattern={required ? ".*\\S.*" : undefined}
        onInvalid={(event) => {
          if (!missingRequired) return;
          event.preventDefault();
          setRequiredChecked(true);
          if (isFirstInvalidControl(event.currentTarget)) event.currentTarget.focus();
        }}
        maxLength={maxLength}
        placeholder={placeholder}
      />
      {fieldError && <FieldError id={errorId}>{fieldError}</FieldError>}
    </Field>
  );
}

function OptionalCopyField({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
  error,
  maxLength,
  disabled,
  multiline = true,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  hint?: string | undefined;
  error?: string | undefined;
  maxLength: number;
  disabled?: boolean;
  multiline?: boolean;
}) {
  const errorId = id + "-error";
  const hintId = id + "-hint";
  const describedBy =
    [hint && hintId, error && errorId].filter(Boolean).join(" ") || undefined;
  return (
    <Field data-invalid={!!error} data-disabled={disabled}>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {value.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={"恢复默认：" + label}
            className="h-auto px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            disabled={disabled}
            onClick={() => onChange("")}
          >
            恢复默认
          </Button>
        )}
      </div>
      {multiline ? (
        <Textarea
          id={id}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          rows={2}
          maxLength={maxLength}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          maxLength={maxLength}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {hint && <FieldDescription id={hintId}>{hint}</FieldDescription>}
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </Field>
  );
}

function isFirstInvalidControl(input: HTMLInputElement): boolean {
  const first = input.form?.querySelector("input:invalid, select:invalid, textarea:invalid");
  return !first || first === input;
}
