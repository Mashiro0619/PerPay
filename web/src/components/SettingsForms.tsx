import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useMutation } from "@tanstack/react-query";
import {
  ChartArea,
  ChartColumn,
  ChartLine,
  ChevronDown,
  KeyRound,
  Save,
} from "lucide-react";
import { collectionCodeError } from "../../../src/shared/collection-code";
import {
  ApiError,
  api,
  result,
  type RuntimeSettings,
  type DashboardChartType,
} from "@/api/client";
import { Link } from "@/navigation";
import { cn } from "@/lib/utils";
import { useDraftGuard, useFormDraft } from "@/drafts";
import { SuccessMessage, useFeedback } from "@/components/Feedback";
import { CollectionCodeField } from "@/components/CollectionCodeField";
import { CopyValue } from "@/components/copy-value";
import { ErrorNotice } from "@/components/request-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Field,
  FieldLabel,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldSet,
  FieldLegend,
  FieldGroup,
} from "@/components/ui/field";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
class SettingsInputError extends Error {
  readonly fields: Record<string, string>;
  constructor(field: string, message: string) {
    super(message);
    this.fields = { [field]: message };
  }
}
export type ConfigurationSection =
  | "provider"
  | "collection"
  | "notifications"
  | "backup"
  | "advanced"
  | "display";
export const sections = [
  ["provider", "支付宝接入"],
  ["collection", "经营码与订单"],
  ["notifications", "业务通知"],
  ["security", "密钥与安全"],
  ["backup", "自动备份"],
  ["display", "界面显示"],
  ["advanced", "高级设置"],
] as const;
function NumberField({
  name,
  label,
  value,
  min,
  max,
  hint,
  error,
}: {
  name: string;
  label: string;
  value: number;
  min: number;
  max: number;
  hint?: string;
  error?: string;
}) {
  const id = "setting-" + name;
  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        name={name}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        required
        defaultValue={value}
        aria-invalid={!!error}
        aria-describedby={
          [hint && id + "-hint", error && id + "-error"]
            .filter(Boolean)
            .join(" ") || undefined
        }
      />
      {hint && <FieldDescription id={id + "-hint"}>{hint}</FieldDescription>}
      {error && <FieldError id={id + "-error"}>{error}</FieldError>}
    </Field>
  );
}
function backupInterval(seconds: number) {
  return seconds % 86400 === 0
    ? seconds === 86400
      ? "每天"
      : "每 " + seconds / 86400 + " 天"
    : seconds % 3600 === 0
      ? "每 " + seconds / 3600 + " 小时"
      : "每 " + seconds + " 秒";
}
export function SettingsEditor({
  section,
  settings,
  onSaved,
  guided = false,
  submitLabel = "保存",
  secondaryAction,
}: {
  section: ConfigurationSection;
  settings: RuntimeSettings;
  onSaved: (settings: RuntimeSettings, message?: string) => void;
  guided?: boolean;
  submitLabel?: string;
  secondaryAction?: ReactNode;
}) {
  // Keep defaults stable for this mounted draft when a sibling form saves.
  // Explicit refreshes remount the editor; saves still use the latest revision.
  const [initialSettings] = useState(settings);
  const [advancedOpen, setAdvancedOpen] = useState(
    !guided && (section === "collection" || section === "provider"),
  );
  const [privateOpen, setPrivateOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  function revealField(field: HTMLElement) {
    if (field.closest("[data-settings-advanced]")) setAdvancedOpen(true);
    if (field.closest("[data-settings-private]")) setPrivateOpen(true);
    if (field.closest("[data-settings-backup]")) setBackupOpen(true);
    requestAnimationFrame(() => {
      if (field.isConnected && !field.matches(":disabled")) field.focus();
    });
  }
  const draft = useFormDraft();
  const [decoding, setDecoding] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notificationEnabled, setNotificationEnabled] = useState(
    settings.notifications.enabled,
  );
  const [showProductName, setShowProductName] = useState(
    settings.display?.checkout_show_product_name ?? true,
  );
  const [chartType, setChartType] = useState<DashboardChartType>(
    settings.display?.dashboard_chart_type ?? "AREA",
  );
  useEffect(() => {
    if (section === "display") draft.onChange();
  }, [showProductName, chartType, section]);
  useEffect(() => {
    // Disabled optional fields enter/leave FormData after the checkbox's change event.
    if (section === "notifications") draft.onChange();
  }, [notificationEnabled, guided, section]);
  const mounted = useRef(false);
  const [savedMessage, setSavedMessage] = useFeedback();
  const submitting = useRef(false);
  const canSave =
    guided ||
    draft.dirty ||
    (section === "provider" && !settings.completion.provider) ||
    (section === "collection" && !settings.completion.collection);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const save = useMutation({
    mutationFn: (form: FormData) => saveSettings(section, form, settings),
    onSuccess: (data, form) => {
      if (!mounted.current) return;
      draft.markSaved(form);
      setSavedMessage("已保存");
      onSaved(data);
    },
    onError: (error) => {
      if (
        mounted.current &&
        (error instanceof ApiError || error instanceof SettingsInputError)
      )
        setFieldErrors({ ...error.fields });
    },
    onSettled: () => {
      submitting.current = false;
    },
  });
  useEffect(() => {
    // A mutation can publish field errors before its disabled fieldset is released.
    if (save.isPending) return;
    const field = draft.form.current?.elements.namedItem(
      Object.keys(fieldErrors)[0] ?? "",
    );
    if (!(field instanceof HTMLElement)) return;
    revealField(field);
    requestAnimationFrame(() => field.focus());
  }, [fieldErrors, save.isPending, draft.form]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (decoding || save.isPending || submitting.current || !canSave) return;
    submitting.current = true;
    setFieldErrors({});
    setSavedMessage("");
    save.mutate(new FormData(event.currentTarget));
  }

  const providerIdentity = (
    <FieldGroup>
      <Field data-invalid={!!fieldErrors.app_id}>
        <FieldLabel htmlFor="setting-app-id">应用 ID（App ID）</FieldLabel>
        <Input
          id="setting-app-id"
          name="app_id"
          required
          maxLength={64}
          pattern="[A-Za-z0-9._-]+"
          defaultValue={initialSettings.provider?.app_id ?? ""}
          autoComplete="off"
          aria-invalid={!!fieldErrors.app_id}
          aria-describedby={
            fieldErrors.app_id ? "setting-app-id-error" : undefined
          }
        />
        {fieldErrors.app_id && (
          <FieldError id="setting-app-id-error">
            {fieldErrors.app_id}
          </FieldError>
        )}
      </Field>
      <Field data-invalid={!!fieldErrors.platform_public_key}>
        <FieldLabel htmlFor="setting-platform-key">支付宝公钥</FieldLabel>
        <Textarea
          id="setting-platform-key"
          name="platform_public_key"
          rows={4}
          required={!settings.secrets.provider_public_key.configured}
          maxLength={16384}
          autoComplete="off"
          spellCheck={false}
          placeholder="Base64 或 PEM"
          aria-invalid={!!fieldErrors.platform_public_key}
          aria-describedby={
            fieldErrors.platform_public_key
              ? "setting-platform-key-error" + " setting-platform-key-hint"
              : "setting-platform-key-hint"
          }
        />
        <FieldDescription id="setting-platform-key-hint">
          {settings.secrets.provider_public_key.configured
            ? "已配置，留空不变。"
            : "从支付宝平台复制，不是应用公钥。"}
        </FieldDescription>
        {fieldErrors.platform_public_key && (
          <FieldError id="setting-platform-key-error">
            {fieldErrors.platform_public_key}
          </FieldError>
        )}
      </Field>
      {!guided && (
        <Collapsible
          open={privateOpen}
          onOpenChange={setPrivateOpen}
          data-settings-private
        >
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
            <ChevronDown data-icon="inline-start" />
            导入已有应用私钥（可选）
          </CollapsibleTrigger>
          <CollapsibleContent keepMounted>
            <Field className="pt-4" data-invalid={!!fieldErrors.private_key}>
              <FieldLabel htmlFor="setting-private-key">应用私钥</FieldLabel>
              <Textarea
                id="setting-private-key"
                name="private_key"
                rows={4}
                maxLength={16384}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!fieldErrors.private_key}
                aria-describedby={
                  fieldErrors.private_key
                    ? "setting-private-key-error" + " setting-private-key-hint"
                    : "setting-private-key-hint"
                }
              />
              <FieldDescription id="setting-private-key-hint">
                留空使用已生成的私钥。替换前，请同步支付宝平台中的应用公钥。
              </FieldDescription>
              {fieldErrors.private_key && (
                <FieldError id="setting-private-key-error">
                  {fieldErrors.private_key}
                </FieldError>
              )}
            </Field>
          </CollapsibleContent>
        </Collapsible>
      )}
    </FieldGroup>
  );
  const providerCollection = (
    <FieldGroup>
      <Collapsible
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        data-settings-advanced
      >
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
          <ChevronDown data-icon="inline-start" />
          {settings.provider?.environment === "SANDBOX"
            ? "高级设置 · 沙箱环境"
            : "高级设置"}
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted>
          <FieldGroup className="grid gap-5 pt-4 sm:grid-cols-2">
            <Field data-invalid={!!fieldErrors.environment}>
              <FieldLabel htmlFor="setting-environment">支付宝环境</FieldLabel>
              <NativeSelect
                id="setting-environment"
                name="environment"
                defaultValue={
                  initialSettings.provider?.environment ?? "PRODUCTION"
                }
                aria-invalid={!!fieldErrors.environment}
                aria-describedby={
                  fieldErrors.environment
                    ? "setting-environment-error"
                    : undefined
                }
              >
                <NativeSelectOption value="PRODUCTION">
                  生产环境
                </NativeSelectOption>
                <NativeSelectOption value="SANDBOX">
                  沙箱环境
                </NativeSelectOption>
              </NativeSelect>
              {fieldErrors.environment && (
                <FieldError id="setting-environment-error">
                  {fieldErrors.environment}
                </FieldError>
              )}
            </Field>
            <NumberField
              name="timeout_milliseconds"
              error={fieldErrors.timeout_milliseconds}
              label="请求超时（毫秒）"
              value={initialSettings.provider?.timeout_milliseconds ?? 8000}
              min={1000}
              max={120000}
            />
            <NumberField
              name="scan_interval_seconds"
              error={fieldErrors.scan_interval_seconds}
              label="常规采集间隔（秒）"
              value={initialSettings.provider?.scan_interval_seconds ?? 60}
              min={5}
              max={3600}
              hint="空闲时使用；有效时限至少为此间隔的两倍。"
            />
            <NumberField
              name="active_scan_interval_seconds"
              error={fieldErrors.active_scan_interval_seconds}
              label="活跃采集间隔（秒）"
              value={
                initialSettings.provider?.active_scan_interval_seconds ??
                initialSettings.provider?.scan_interval_seconds ??
                8
              }
              min={5}
              max={3600}
              hint="待支付及收尾时使用，不得大于常规间隔。"
            />
            <NumberField
              name="safety_lag_seconds"
              error={fieldErrors.safety_lag_seconds}
              label="安全延迟（秒）"
              value={initialSettings.provider?.safety_lag_seconds ?? 10}
              min={5}
              max={300}
              hint="避开支付宝尚未稳定返回的最新账单。"
            />
            <NumberField
              name="maximum_success_age_seconds"
              error={fieldErrors.maximum_success_age_seconds}
              label="采集有效时限（秒）"
              value={
                initialSettings.provider?.maximum_success_age_seconds ?? 120
              }
              min={10}
              max={86400}
              hint="超过此时限未成功采集，会暂停新订单收款入口。"
            />
          </FieldGroup>
        </CollapsibleContent>
      </Collapsible>
    </FieldGroup>
  );
  const collectionIdentity = (
    <FieldGroup>
      <CollectionCodeField
        defaultValue={initialSettings.collection?.code_payload ?? ""}
        onDecoded={() => {
          draft.onChange();
          setFieldErrors({});
          setSavedMessage("");
        }}
        error={fieldErrors.code_payload}
        onPendingChange={setDecoding}
        disabled={save.isPending}
      />
    </FieldGroup>
  );
  const collectionRules = (
    <FieldGroup>
      <NumberField
        name="order_ttl_seconds"
        error={fieldErrors.order_ttl_seconds}
        label="收银台有效期（秒）"
        value={initialSettings.collection?.order_ttl_seconds ?? 300}
        min={60}
        max={1800}
      />
      <Collapsible
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        data-settings-advanced
      >
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
          <ChevronDown data-icon="inline-start" />
          高级设置
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted>
          <FieldGroup className="grid gap-5 pt-4 sm:grid-cols-2">
            <NumberField
              name="amount_offset_maximum_cents"
              error={fieldErrors.amount_offset_maximum_cents}
              label="最大金额尾差（分）"
              value={
                initialSettings.collection?.amount_offset_maximum_cents ?? 99
              }
              min={1}
              max={99}
            />
            <NumberField
              name="amount_reuse_cooldown_seconds"
              error={fieldErrors.amount_reuse_cooldown_seconds}
              label="金额复用冷却（秒）"
              value={
                initialSettings.collection?.amount_reuse_cooldown_seconds ?? 600
              }
              min={60}
              max={3600}
              hint="结束后暂不复用应付金额，不延长订单有效期。"
            />
          </FieldGroup>
        </CollapsibleContent>
      </Collapsible>
    </FieldGroup>
  );
  const notificationFields = (
    <FieldGroup>
      <Field orientation="horizontal">
        <Switch
          id="setting-enabled"
          name="enabled"
          checked={notificationEnabled}
          onCheckedChange={setNotificationEnabled}
        />
        <FieldLabel htmlFor="setting-enabled">启用业务通知</FieldLabel>
      </Field>
      {!notificationEnabled && (
        <FieldDescription>通知未启用，网站需主动查单。</FieldDescription>
      )}
      <FieldSet hidden={!notificationEnabled} disabled={!notificationEnabled}>
        <FieldGroup>
          <Field data-invalid={!!fieldErrors.allowed_origin}>
            <FieldLabel htmlFor="setting-origin">
              通知网站（HTTPS 域名）
            </FieldLabel>
            <Input
              id="setting-origin"
              name="allowed_origin"
              type="url"
              required={notificationEnabled}
              defaultValue={initialSettings.notifications.allowed_origin ?? ""}
              placeholder="https://shop.example.com"
              aria-invalid={!!fieldErrors.allowed_origin}
              aria-describedby={
                fieldErrors.allowed_origin
                  ? "setting-origin-error" + " setting-origin-hint"
                  : "setting-origin-hint"
              }
            />
            <FieldDescription id="setting-origin-hint">
              不含端口或路径。
            </FieldDescription>
            {fieldErrors.allowed_origin && (
              <FieldError id="setting-origin-error">
                {fieldErrors.allowed_origin}
              </FieldError>
            )}
          </Field>
          <Collapsible
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            data-settings-advanced
          >
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
              <ChevronDown data-icon="inline-start" />
              高级设置
            </CollapsibleTrigger>
            <CollapsibleContent keepMounted>
              <FieldGroup className="grid gap-5 pt-4 sm:grid-cols-2">
                <NumberField
                  name="timeout_milliseconds"
                  error={fieldErrors.timeout_milliseconds}
                  label="通知超时（毫秒）"
                  value={initialSettings.notifications.timeout_milliseconds}
                  min={1000}
                  max={30000}
                />
                <NumberField
                  name="maximum_attempts"
                  error={fieldErrors.maximum_attempts}
                  label="最大尝试次数"
                  value={initialSettings.notifications.maximum_attempts}
                  min={1}
                  max={100}
                />
                <NumberField
                  name="retry_base_seconds"
                  error={fieldErrors.retry_base_seconds}
                  label="首次重试间隔（秒）"
                  value={initialSettings.notifications.retry_base_seconds}
                  min={1}
                  max={3600}
                />
                <NumberField
                  name="retry_maximum_seconds"
                  error={fieldErrors.retry_maximum_seconds}
                  label="最大重试间隔（秒）"
                  value={initialSettings.notifications.retry_maximum_seconds}
                  min={1}
                  max={86400}
                />
              </FieldGroup>
            </CollapsibleContent>
          </Collapsible>
        </FieldGroup>
      </FieldSet>
    </FieldGroup>
  );
  const backupFields = (
    <FieldGroup>
      <FieldGroup className="grid sm:grid-cols-2">
        <NumberField
          name="interval_seconds"
          error={fieldErrors.interval_seconds}
          label="备份间隔（秒）"
          value={initialSettings.backup.interval_seconds}
          min={3600}
          max={604800}
        />
        <NumberField
          name="keep_count"
          error={fieldErrors.keep_count}
          label="保留备份数量"
          value={initialSettings.backup.keep_count}
          min={1}
          max={365}
        />
      </FieldGroup>
      {!guided && (
        <Link
          className={buttonVariants({
            variant: "link",
            size: "sm",
            className: "w-fit",
          })}
          to="/system"
        >
          查看备份状态
        </Link>
      )}
    </FieldGroup>
  );
  const checkoutDisplay = (
    <FieldGroup>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="checkout-show-product-name">
            收银台显示商品名称
          </FieldLabel>
          <FieldDescription id="checkout-product-hint">
            只影响收银台页面，不修改订单或通知内容。
          </FieldDescription>
        </FieldContent>
        <Switch
          id="checkout-show-product-name"
          name="checkout_show_product_name"
          checked={showProductName}
          onCheckedChange={setShowProductName}
          aria-describedby="checkout-product-hint"
        />
      </Field>
    </FieldGroup>
  );
  const chartDisplay = (
    <FieldGroup>
      <Field>
        <FieldLabel id="dashboard-chart-type-label">首页图表样式</FieldLabel>
        <input type="hidden" name="dashboard_chart_type" value={chartType} />
        <ToggleGroup
          spacing={0}
          variant="outline"
          value={[chartType]}
          onValueChange={(values) => {
            const value = values[0];
            if (value === "AREA" || value === "BAR" || value === "LINE")
              setChartType(value);
          }}
          aria-labelledby="dashboard-chart-type-label"
          aria-describedby="dashboard-chart-type-hint"
        >
          <ToggleGroupItem value="AREA">
            <ChartArea />
            面积图
          </ToggleGroupItem>
          <ToggleGroupItem value="BAR">
            <ChartColumn />
            柱状图
          </ToggleGroupItem>
          <ToggleGroupItem value="LINE">
            <ChartLine />
            折线图
          </ToggleGroupItem>
        </ToggleGroup>
        <FieldDescription id="dashboard-chart-type-hint">
          全体管理员共用，统计口径不变。
        </FieldDescription>
      </Field>
    </FieldGroup>
  );
  const advancedFields = (
    <FieldGroup>
      <FieldGroup className="grid sm:grid-cols-2">
        <NumberField
          name="checkout_key_rotation_days"
          error={fieldErrors.checkout_key_rotation_days}
          label="收银台密钥轮换（天）"
          value={initialSettings.advanced.checkout_key_rotation_days}
          min={1}
          max={3650}
        />
        <NumberField
          name="checkout_terminal_observation_seconds"
          error={fieldErrors.checkout_terminal_observation_seconds}
          label="终态观察期（秒）"
          value={initialSettings.advanced.checkout_terminal_observation_seconds}
          min={60}
          max={604800}
          hint="收银台结束后继续观察迟到付款的时间窗口。"
        />
      </FieldGroup>
    </FieldGroup>
  );

  const panels: Array<{
    title: string;
    description?: string;
    fields: ReactNode;
  }> =
    section === "provider"
      ? [
          {
            title: "支付宝接入",
            description: "应用身份与请求凭据",
            fields: providerIdentity,
          },
          {
            title: "账单采集",
            description: "采集频率、超时与有效时限",
            fields: providerCollection,
          },
        ]
      : section === "collection"
        ? [
            {
              title: "支付宝经营码",
              description: "上传二维码，或粘贴经营码内容",
              fields: collectionIdentity,
            },
            {
              title: "订单规则",
              description: "收银台有效期与金额分配",
              fields: collectionRules,
            },
          ]
        : section === "display"
          ? [
              {
                title: "收银台",
                description: "付款人看到的商品信息",
                fields: checkoutDisplay,
              },
              {
                title: "收款概览",
                description: "管理台首页的图表显示",
                fields: chartDisplay,
              },
            ]
          : [
              {
                title:
                  sections.find(([value]) => value === section)?.[1] ?? "设置",
                description:
                  section === "backup"
                    ? "恢复需要数据库备份和主密钥。"
                    : undefined,
                fields:
                  section === "notifications"
                    ? notificationFields
                    : section === "backup"
                      ? backupFields
                      : advancedFields,
              },
            ];

  const actions = (
    <FieldGroup>
      <ErrorNotice
        error={
          save.error instanceof SettingsInputError ||
          (save.error instanceof ApiError &&
            Object.keys(save.error.fields).length)
            ? null
            : save.error
        }
      />
      <Field orientation="horizontal" className="flex-wrap justify-end">
        <Button type="submit" disabled={decoding || !canSave || save.isPending}>
          {save.isPending ? (
            <Spinner aria-hidden="true" data-icon="inline-start" />
          ) : (
            !guided && <Save data-icon="inline-start" />
          )}
          {submitLabel}
        </Button>
        {secondaryAction}
        {draft.dirty && (
          <span className="text-sm text-muted-foreground" role="status">
            未保存
          </span>
        )}
        <SuccessMessage message={savedMessage} />
      </Field>
    </FieldGroup>
  );

  const editor = (
    <form
      ref={draft.form}
      onSubmit={submit}
      onInvalidCapture={(event) => {
        if (event.target instanceof HTMLElement) revealField(event.target);
      }}
      onChange={(event) => {
        draft.onChange();
        setSavedMessage("");
        save.reset();
        const control = event.target;
        const name =
          control instanceof HTMLInputElement ||
          control instanceof HTMLSelectElement ||
          control instanceof HTMLTextAreaElement
            ? control.name
            : "";
        if (name && fieldErrors[name])
          setFieldErrors((current) => {
            const next = { ...current };
            delete next[name];
            return next;
          });
      }}
      autoComplete="off"
    >
      <FieldSet disabled={save.isPending}>
        <FieldGroup>
          {guided ? (
            panels.map((panel) => (
              <Fragment key={panel.title}>{panel.fields}</Fragment>
            ))
          ) : (
            <Card>
              <CardHeader>
                <CardTitle role="heading" aria-level={2}>
                  {sections.find(([value]) => value === section)?.[1] ?? "设置"}
                </CardTitle>
                <CardDescription>
                  本页修改统一保存，其他分类不受影响。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup
                  className={cn(
                    "grid items-start gap-6",
                    panels.length > 1 && "@3xl/settings:grid-cols-2",
                  )}
                >
                  {panels.map((panel) => (
                    <FieldSet key={panel.title} className="min-w-0">
                      <FieldLegend>{panel.title}</FieldLegend>
                      {panel.description && (
                        <FieldDescription>{panel.description}</FieldDescription>
                      )}
                      {panel.fields}
                    </FieldSet>
                  ))}
                </FieldGroup>
              </CardContent>
              <CardFooter>{actions}</CardFooter>
            </Card>
          )}
          {guided && actions}
        </FieldGroup>
      </FieldSet>
    </form>
  );
  if (!guided)
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {editor}
        {section === "provider" && (
          <ApplicationKey settings={settings} onSaved={onSaved} />
        )}
      </div>
    );
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        {guided && section === "backup" ? (
          <>
            <p className="text-sm">
              {backupInterval(settings.backup.interval_seconds)}备份，保留{" "}
              {settings.backup.keep_count} 份。
            </p>
            <Collapsible
              open={backupOpen}
              onOpenChange={setBackupOpen}
              data-settings-backup
            >
              <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
                <ChevronDown data-icon="inline-start" />
                调整备份策略
              </CollapsibleTrigger>
              <CollapsibleContent keepMounted>
                <div className="pt-4">{editor}</div>
              </CollapsibleContent>
            </Collapsible>
            <p className="text-sm text-muted-foreground">
              恢复需同时保留数据库备份和主密钥。
            </p>
          </>
        ) : (
          editor
        )}
      </CardContent>
    </Card>
  );
}

export function ApplicationKey({
  settings,
  onSaved,
  guided = false,
}: {
  settings: RuntimeSettings;
  onSaved: (settings: RuntimeSettings, message?: string) => void;
  guided?: boolean;
}) {
  const { requestDiscard } = useDraftGuard();
  const generate = useMutation({
    mutationFn: () =>
      result(
        api.generateProviderApplicationKey({
          body: { revision: settings.revision },
        }),
      ),
    onSuccess: ({ data }) => onSaved(data.settings, "应用密钥已生成"),
  });
  return (
    <Card>
      <CardHeader>
        {guided ? (
          <CardDescription>应用公钥</CardDescription>
        ) : (
          <CardTitle role="heading" aria-level={2}>
            应用密钥
          </CardTitle>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {settings.application_public_key ? (
          guided ? (
            <CopyValue
              value={settings.application_public_key}
              label="复制应用公钥"
            />
          ) : (
            <Collapsible>
              <CollapsibleTrigger
                render={<Button variant="outline" size="sm" />}
              >
                查看应用公钥
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="pt-4">
                  <CopyValue
                    value={settings.application_public_key}
                    label="复制应用公钥"
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          )
        ) : (
          <Button
            className="w-fit"
            disabled={generate.isPending}
            onClick={() => requestDiscard(() => generate.mutate())}
          >
            {generate.isPending ? (
              <Spinner aria-hidden="true" data-icon="inline-start" />
            ) : (
              <KeyRound data-icon="inline-start" />
            )}
            生成应用密钥
          </Button>
        )}
        <ErrorNotice error={generate.error} />
      </CardContent>
    </Card>
  );
}
async function saveSettings(
  section: ConfigurationSection,
  form: FormData,
  settings: RuntimeSettings,
): Promise<RuntimeSettings> {
  const revision = settings.revision;
  const text = (key: string) => String(form.get(key) ?? "").trim();
  const integer = (key: string) => {
    const value = Number(text(key));
    if (!Number.isSafeInteger(value))
      throw new Error("数值设置必须是有效整数。");
    return value;
  };
  if (section === "collection") {
    const code = text("code_payload");
    const error = collectionCodeError(code);
    if (error) throw new SettingsInputError("code_payload", error);
    return (
      await result(
        api.updateCollectionSettings({
          body: {
            revision,
            code_payload: code,
            order_ttl_seconds: integer("order_ttl_seconds"),
            amount_offset_maximum_cents: integer("amount_offset_maximum_cents"),
            amount_reuse_cooldown_seconds: integer(
              "amount_reuse_cooldown_seconds",
            ),
          },
        }),
      )
    ).data;
  }
  if (section === "provider") {
    const normalInterval = integer("scan_interval_seconds");
    const activeInterval = integer("active_scan_interval_seconds");
    const maximumSuccessAge = integer("maximum_success_age_seconds");
    if (activeInterval > normalInterval)
      throw new SettingsInputError(
        "active_scan_interval_seconds",
        "活跃采集间隔不能大于常规采集间隔。",
      );
    if (maximumSuccessAge < normalInterval * 2)
      throw new SettingsInputError(
        "maximum_success_age_seconds",
        "采集有效时限须至少为常规采集间隔的两倍。",
      );
    return (
      await result(
        api.updateProviderSettings({
          body: {
            revision,
            environment:
              text("environment") === "SANDBOX" ? "SANDBOX" : "PRODUCTION",
            app_id: text("app_id"),
            timeout_milliseconds: integer("timeout_milliseconds"),
            scan_interval_seconds: normalInterval,
            active_scan_interval_seconds: activeInterval,
            safety_lag_seconds: integer("safety_lag_seconds"),
            maximum_success_age_seconds: maximumSuccessAge,
            ...(text("private_key")
              ? { private_key: text("private_key") }
              : {}),
            ...(text("platform_public_key")
              ? { platform_public_key: text("platform_public_key") }
              : {}),
          },
        }),
      )
    ).data;
  }
  if (section === "notifications") {
    const enabled = form.has("enabled");
    const notificationNumber = (
      key:
        | "timeout_milliseconds"
        | "maximum_attempts"
        | "retry_base_seconds"
        | "retry_maximum_seconds",
    ) => (form.has(key) ? integer(key) : settings.notifications[key]);
    return (
      await result(
        api.updateNotificationSettings({
          body: {
            revision,
            enabled,
            ...(enabled ? { allowed_origin: text("allowed_origin") } : {}),
            timeout_milliseconds: notificationNumber("timeout_milliseconds"),
            maximum_attempts: notificationNumber("maximum_attempts"),
            retry_base_seconds: notificationNumber("retry_base_seconds"),
            retry_maximum_seconds: notificationNumber("retry_maximum_seconds"),
          },
        }),
      )
    ).data;
  }
  if (section === "display") {
    const chartType = text("dashboard_chart_type");
    if (chartType !== "AREA" && chartType !== "BAR" && chartType !== "LINE")
      throw new SettingsInputError(
        "dashboard_chart_type",
        "请选择有效的图表样式。",
      );
    return (
      await result(
        api.updateDisplaySettings({
          body: {
            revision,
            checkout_show_product_name: form.has("checkout_show_product_name"),
            dashboard_chart_type: chartType,
          },
        }),
      )
    ).data;
  }
  if (section === "backup")
    return (
      await result(
        api.updateBackupSettings({
          body: {
            revision,
            interval_seconds: integer("interval_seconds"),
            keep_count: integer("keep_count"),
          },
        }),
      )
    ).data;
  return (
    await result(
      api.updateAdvancedSettings({
        body: {
          revision,
          checkout_key_rotation_days: integer("checkout_key_rotation_days"),
          checkout_terminal_observation_seconds: integer(
            "checkout_terminal_observation_seconds",
          ),
        },
      }),
    )
  ).data;
}
