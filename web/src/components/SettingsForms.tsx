import { integerUnits } from "../../../src/shared/time-units";
import { BackupStatus } from "@/components/backup-status";
import { setSystemName } from "@/branding";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { onlineManager, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChartArea,
  ChartColumn,
  ChartLine,
  ChevronDown,
  Save,
} from "lucide-react";
import { collectionCodeError } from "../../../src/shared/collection-code";
import { PROVIDER_TIMING_DEFAULTS } from "../../../src/shared/provider-defaults";
import {
  ApiError,
  api,
  result,
  type RuntimeSettings,
  type DashboardChartType,
} from "@/api/client";
import { Link } from "@/navigation";
import { cn } from "@/lib/utils";
import { applicationKeyState } from "@/lib/application-key";
import { useFormDraft } from "@/drafts";
import { useSuccessToast } from "@/components/Feedback";
import { CollectionCodeField } from "@/components/CollectionCodeField";
import { ApplicationKey } from "@/components/ApplicationKey";
export { ApplicationKey } from "@/components/ApplicationKey";
import { ErrorNotice } from "@/components/request-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  | "collection-policy"
  | "collection"
  | "notifications"
  | "backup"
  | "advanced"
  | "display";
export const sections = [
  ["provider", "支付宝接入"],
  ["collection", "经营码"],
  ["collection-policy", "查账设置"],
  ["notifications", "通知"],
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
  scale = 1,
}: {
  name: string;
  label: string;
  value: number;
  min: number;
  max: number;
  hint?: string;
  error?: string;
  scale?: number;
}) {
  const id = "setting-" + name;
  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        name={name}
        type="number"
        inputMode={scale === 1 ? "numeric" : "decimal"}
        min={min / scale}
        max={max / scale}
        step={1 / scale}
        required
        defaultValue={value / scale}
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
function BackupIntervalField({
  value,
  error,
  onChange,
}: {
  value: number;
  error?: string;
  onChange: () => void;
}) {
  const initialUnit =
    value % 86400 === 0 ? 86400 : value % 3600 === 0 ? 3600 : 1;
  const [unit, setUnit] = useState(initialUnit);
  const [amount, setAmount] = useState(String(value / initialUnit));
  const canonical = integerUnits(amount, unit);
  useEffect(() => {
    onChange();
  }, [unit, amount]);
  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor="setting-interval_seconds">备份间隔</FieldLabel>
      <div className="flex max-w-xs items-center gap-2">
        <Input
          id="setting-interval_seconds"
          name="interval_seconds"
          type="number"
          min={3600 / unit}
          max={604800 / unit}
          step="any"
          required
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          aria-invalid={!!error}
          aria-describedby={
            error ? "setting-interval_seconds-error" : undefined
          }
        />
        <Select
          name="_backup_interval_unit"
          value={String(unit)}
          items={[
            { value: "1", label: "秒" },
            { value: "3600", label: "小时" },
            { value: "86400", label: "天" },
          ]}
          onValueChange={(value) => {
            const next = Number(value);
            if (
              canonical !== null &&
              [1, 3600, 86400].includes(next) &&
              canonical % next === 0
            ) {
              setUnit(next);
              setAmount(String(canonical / next));
            }
          }}
        >
          <SelectTrigger aria-label="备份间隔单位">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {[
                [1, "秒"],
                [3600, "小时"],
                [86400, "天"],
              ].map(([n, label]) => (
                <SelectItem
                  key={n}
                  value={String(n)}
                  disabled={canonical === null || canonical % Number(n) !== 0}
                >
                  {label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      {error && (
        <FieldError id="setting-interval_seconds-error">{error}</FieldError>
      )}
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
  onFeedback,
  guided = false,
  submitLabel = "保存",
  secondaryAction,
  renderGuidedActions,
}: {
  section: ConfigurationSection;
  settings: RuntimeSettings;
  onSaved: (settings: RuntimeSettings, message?: string) => void;
  onFeedback?: (message: string) => void;
  guided?: boolean;
  submitLabel?: string;
  secondaryAction?: ReactNode;
  renderGuidedActions?: (actions: ReactNode) => ReactNode;
}) {
  // Keep defaults stable for this mounted draft when a sibling form saves.
  // Explicit refreshes remount the editor; saves still use the latest revision.
  const [initialSettings] = useState(settings);
  const [privateOpen, setPrivateOpen] = useState(false);
  function revealField(field: HTMLElement) {
    if (field.closest("[data-settings-private]")) setPrivateOpen(true);
    requestAnimationFrame(() => {
      if (field.isConnected && !field.matches(":disabled")) field.focus();
    });
  }
  const draft = useFormDraft();
  const queryClient = useQueryClient();
  const [environment, setEnvironment] = useState(
    initialSettings.provider?.environment ?? "PRODUCTION",
  );
  useEffect(() => {
    // Select updates its form input after committing the selected value.
    if (section === "provider") draft.onChange();
  }, [environment, section]);
  const [decoding, setDecoding] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notificationEnabled, setNotificationEnabled] = useState(
    settings.notifications?.enabled ?? false,
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
  const localFeedback = useSuccessToast();
  // A parent that remounts this editor after saving keeps the same toast owner.
  const setSavedMessage = onFeedback ?? localFeedback;
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
    networkMode: "always",
    retry: false,
    mutationFn: (form: FormData) => {
      if (!onlineManager.isOnline() || !navigator.onLine)
        throw new Error("网络已断开，设置未提交。恢复连接后请重新提交。");
      return saveSettings(section, form, settings);
    },
    onSuccess: (data, form) => {
      if (!mounted.current) {
        // A dispatched save can complete after navigation; reread it on return.
        void queryClient.invalidateQueries({ queryKey: ["settings"], exact: true, refetchType: "none" });
        return;
      }
      if (section === "display" && data.display?.system_name)
        setSystemName(data.display.system_name);
      draft.markSaved(form);
      const message = section === "backup" ? "备份策略已保存" : "已保存";
      setSavedMessage(message);
      onSaved(data, ...(section === "backup" ? [message] : []));
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
          className="settings-long-text"
          name="platform_public_key"
          rows={4}
          required
          defaultValue={initialSettings.provider?.platform_public_key ?? ""}
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
          从支付宝应用的接口加签设置复制，支持 Base64 或 PEM 格式。
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
                className="settings-long-text"
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
                {settings.provider || settings.provider_generations.length > 0
                  ? "留空保留当前应用私钥。此导入入口不能替换当前应用的私钥；更换请使用下方“更换应用密钥对”，上传后再验证启用。"
                  : applicationKeyState(settings) === "missing"
                    ? "首次接入可导入已有应用私钥，并将对应的应用公钥配置到支付宝；不导入则先生成应用密钥对。"
                    : "已有应用私钥，留空即可复用。这里只接受与当前应用公钥匹配的私钥；需要更换时请使用下方“更换应用密钥对”。"}
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
  function recommendedProvider() {
    const values = {
      timeout_milliseconds: PROVIDER_TIMING_DEFAULTS.timeoutMilliseconds / 1000,
      scan_interval_seconds: PROVIDER_TIMING_DEFAULTS.scanIntervalSeconds,
      active_scan_interval_seconds:
        PROVIDER_TIMING_DEFAULTS.activeScanIntervalSeconds,
      minimum_scan_interval_seconds: PROVIDER_TIMING_DEFAULTS.activeScanIntervalSeconds,
      safety_lag_seconds: PROVIDER_TIMING_DEFAULTS.safetyLagSeconds,
      maximum_success_age_seconds:
        PROVIDER_TIMING_DEFAULTS.maximumSuccessAgeSeconds,
    };
    for (const [name, value] of Object.entries(values)) {
      const input = draft.form.current?.elements.namedItem(name);
      if (input instanceof HTMLInputElement) input.value = String(value);
    }
    draft.onChange();
    setFieldErrors({});
    setSavedMessage("");
    save.reset();
  }
  const providerEnvironment = (
      <Field data-invalid={!!fieldErrors.environment}>
        <FieldLabel htmlFor="setting-environment">支付宝环境</FieldLabel>
        <Select
          name="environment"
          value={environment}
          disabled={save.isPending}
          items={[
            { value: "PRODUCTION", label: "生产环境" },
            { value: "SANDBOX", label: "沙箱环境" },
          ]}
          onValueChange={(value) => {
            if (value !== "PRODUCTION" && value !== "SANDBOX") return;
            setEnvironment(value);
            setSavedMessage("");
            save.reset();
            setFieldErrors((current) => {
              const next = { ...current };
              delete next.environment;
              return next;
            });
          }}
        >
          <SelectTrigger
            id="setting-environment"
            className="w-full"
            aria-invalid={!!fieldErrors.environment}
            aria-describedby={
              fieldErrors.environment ? "setting-environment-error" : undefined
            }
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="PRODUCTION">生产环境</SelectItem>
              <SelectItem value="SANDBOX">沙箱环境</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        {fieldErrors.environment && (
          <FieldError id="setting-environment-error">
            {fieldErrors.environment}
          </FieldError>
        )}
      </Field>
  );
  const providerCollection = (
    <FieldGroup className="settings-fields">
      <Button
        type="button"
        variant="outline"
        className="w-fit col-span-full"
        onClick={recommendedProvider}
      >
        采用推荐值
      </Button>

      <NumberField
        name="timeout_milliseconds"
        error={fieldErrors.timeout_milliseconds}
        label="请求超时（秒）"
        scale={1000}
        value={
          initialSettings.collection_policy?.timeout_milliseconds ?? initialSettings.provider?.timeout_milliseconds ??
          PROVIDER_TIMING_DEFAULTS.timeoutMilliseconds
        }
        min={1000}
        max={120000}
      />
      <NumberField
        name="scan_interval_seconds"
        error={fieldErrors.scan_interval_seconds}
        label="常规查账间隔（秒）"
        value={
          initialSettings.collection_policy?.scan_interval_seconds ?? initialSettings.provider?.scan_interval_seconds ??
          PROVIDER_TIMING_DEFAULTS.scanIntervalSeconds
        }
        min={5}
        max={3600}
        hint="没有待付款订单时，隔多久查一次账。"
      />
      <NumberField
        name="active_scan_interval_seconds"
        error={fieldErrors.active_scan_interval_seconds}
        label="活跃查账间隔（秒）"
        value={
          initialSettings.collection_policy?.active_scan_interval_seconds ?? initialSettings.provider?.active_scan_interval_seconds ??
          initialSettings.collection_policy?.scan_interval_seconds ?? initialSettings.provider?.scan_interval_seconds ??
          PROVIDER_TIMING_DEFAULTS.activeScanIntervalSeconds
        }
        min={5}
        max={3600}
        hint="有待付款订单时，隔多久查一次账；不能大于常规间隔。"
      />
      <NumberField
        name="minimum_scan_interval_seconds"
        error={fieldErrors.minimum_scan_interval_seconds}
        label="查账最小间隔（秒）"
        value={initialSettings.collection_policy?.minimum_scan_interval_seconds ?? initialSettings.provider?.minimum_scan_interval_seconds ?? initialSettings.collection_policy?.active_scan_interval_seconds ?? initialSettings.provider?.active_scan_interval_seconds ?? PROVIDER_TIMING_DEFAULTS.activeScanIntervalSeconds}
        min={5}
        max={3600}
        hint="两轮查账之间至少等多久；手动核实也不能更早；不能大于活跃间隔。"
      />
      <NumberField
        name="safety_lag_seconds"
        error={fieldErrors.safety_lag_seconds}
        label="查账延迟（秒）"
        value={
          initialSettings.collection_policy?.safety_lag_seconds ?? initialSettings.provider?.safety_lag_seconds ??
          PROVIDER_TIMING_DEFAULTS.safetyLagSeconds
        }
        min={5}
        max={300}
        hint="只查到 N 秒前的账单，等支付宝记录稳定，避免刚发生的交易被漏掉。"
      />
      <NumberField
        name="maximum_success_age_seconds"
        error={fieldErrors.maximum_success_age_seconds}
        label="查账有效时限（秒）"
        value={
          initialSettings.collection_policy?.maximum_success_age_seconds ?? initialSettings.provider?.maximum_success_age_seconds ??
          PROVIDER_TIMING_DEFAULTS.maximumSuccessAgeSeconds
        }
        min={10}
        max={86400}
        hint="超过这个时间没有成功查账，所有网站都会暂停新订单，未付款的收银台也会暂不可用。"
      />
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
  const notificationFields = (
    <FieldGroup>
      <Field orientation="horizontal">
        <Switch
          id="setting-enabled"
          name="enabled"
          checked={notificationEnabled}
          onCheckedChange={setNotificationEnabled}
        />
        <FieldLabel htmlFor="setting-enabled">启用通知</FieldLabel>
      </Field>
      {!notificationEnabled && (
        <FieldDescription>通知未启用，网站需主动查单。</FieldDescription>
      )}
      <FieldSet hidden={!notificationEnabled} disabled={!notificationEnabled}>
        <FieldGroup>
          <Field data-invalid={!!fieldErrors.allowed_origin}>
            <FieldLabel htmlFor="setting-origin">
              通知地址前缀
            </FieldLabel>
            <Input
              id="setting-origin"
              name="allowed_origin"
              type="url"
              required={notificationEnabled}
              defaultValue={initialSettings.notifications?.allowed_origin ?? ""}
              placeholder="https://shop.example.com"
              aria-invalid={!!fieldErrors.allowed_origin}
              aria-describedby={
                fieldErrors.allowed_origin
                  ? "setting-origin-error" + " setting-origin-hint"
                  : "setting-origin-hint"
              }
            />
            <FieldDescription id="setting-origin-hint">
              例如 https://shop.example.com，只填域名部分，不含端口或路径。
            </FieldDescription>
            {fieldErrors.allowed_origin && (
              <FieldError id="setting-origin-error">
                {fieldErrors.allowed_origin}
              </FieldError>
            )}
          </Field>
          <FieldGroup className="settings-fields">
            <NumberField
              name="timeout_milliseconds"
              error={fieldErrors.timeout_milliseconds}
              label="通知超时（秒）"
              scale={1000}
              value={(initialSettings.notifications?.timeout_milliseconds ?? 5000)}
              min={1000}
              max={30000}
            />
            <NumberField
              name="maximum_attempts"
              error={fieldErrors.maximum_attempts}
              label="最多发送次数"
              value={(initialSettings.notifications?.maximum_attempts ?? 12)}
              min={1}
              max={100}
            />
            <NumberField
              name="retry_base_seconds"
              error={fieldErrors.retry_base_seconds}
              label="首次重试间隔（秒）"
              value={(initialSettings.notifications?.retry_base_seconds ?? 5)}
              min={1}
              max={3600}
            />
            <NumberField
              name="retry_maximum_seconds"
              error={fieldErrors.retry_maximum_seconds}
              label="最大重试间隔（秒）"
              value={(initialSettings.notifications?.retry_maximum_seconds ?? 3600)}
              min={1}
              max={86400}
            />
          </FieldGroup>
        </FieldGroup>
      </FieldSet>
    </FieldGroup>
  );
  const backupFields = (
    <FieldGroup>
      <BackupStatus />
      <FieldGroup className="settings-fields">
        <BackupIntervalField
          value={initialSettings.backup.interval_seconds}
          error={fieldErrors.interval_seconds}
          onChange={draft.onChange}
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
  const displayRowClassName =
    "gap-2";
  const displayFields = (
    <FieldGroup className="gap-6">
      <Field
        orientation="vertical"
        className={displayRowClassName}
        data-invalid={!!fieldErrors.system_name}
      >
        <FieldLabel htmlFor="setting-system-name">支付系统名称</FieldLabel>
        <FieldContent className="min-w-0">
          <Input
            className="max-w-md"
            id="setting-system-name"
            name="system_name"
            required
            maxLength={40}
            defaultValue={initialSettings.display?.system_name ?? "PerPay"}
            aria-invalid={!!fieldErrors.system_name}
            aria-describedby={
              fieldErrors.system_name ? "system-name-error" : undefined
            }
          />
          {fieldErrors.system_name && (
            <FieldError id="system-name-error">
              {fieldErrors.system_name}
            </FieldError>
          )}
        </FieldContent>
      </Field>
      {!settings.site_mode && <>
      <Field
        orientation="vertical"
        className={displayRowClassName}
        data-invalid={!!fieldErrors.checkout_help_url}
      >
        <FieldLabel htmlFor="setting-checkout-help-url">
          商家帮助链接
        </FieldLabel>
        <FieldContent className="min-w-0">
          <Input
            id="setting-checkout-help-url"
            name="checkout_help_url"
            type="url"
            placeholder="可选，留空不显示"
            defaultValue={initialSettings.display?.checkout_help_url ?? ""}
            aria-invalid={!!fieldErrors.checkout_help_url}
            aria-describedby={
              fieldErrors.checkout_help_url ? "checkout-help-error" : undefined
            }
          />
          {fieldErrors.checkout_help_url && (
            <FieldError id="checkout-help-error">
              {fieldErrors.checkout_help_url}
            </FieldError>
          )}
        </FieldContent>
      </Field>
      </>}
      <Field orientation="vertical" className={displayRowClassName}>
        <FieldLabel id="dashboard-chart-type-label">首页图表样式</FieldLabel>
        <FieldContent className="min-w-0 items-start">
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
        </FieldContent>
      </Field>
      {!settings.site_mode && <>
      <Field orientation="vertical" className={displayRowClassName}>
        <FieldLabel htmlFor="checkout-show-product-name">
          收银台显示商品名称
        </FieldLabel>
        <FieldContent className="min-w-0 items-start">
          <Switch
            id="checkout-show-product-name"
            name="checkout_show_product_name"
            checked={showProductName}
            onCheckedChange={setShowProductName}
          />
        </FieldContent>
      </Field>
      </>}
    </FieldGroup>
  );
  const advancedFields = (
    <FieldGroup>
      <FieldGroup className="settings-fields">
        <NumberField
          name="checkout_key_rotation_days"
          error={fieldErrors.checkout_key_rotation_days}
          label="收银台链接密钥轮换周期（天）"
          value={initialSettings.advanced.checkout_key_rotation_days}
          min={1}
          max={3650}
          hint="自动更新用于生成收银台链接的内部密钥，不影响已有订单链接；通常无需修改。"
        />
        <NumberField
          name="checkout_terminal_observation_seconds"
          error={fieldErrors.checkout_terminal_observation_seconds}
          label="结束后可查询时长（秒）"
          value={initialSettings.advanced.checkout_terminal_observation_seconds}
          min={60}
          max={604800}
          hint="收银台结束后，公开链接继续提供状态查询的时长；不延长付款期限，也不控制后台迟到账单处理。仅影响新订单。"
        />
      </FieldGroup>
    </FieldGroup>
  );

  const panels: Array<{ title: string; description?: string; fields: ReactNode }> =
    section === "provider" ? [{ title: "开放平台应用", description: "应用身份、密钥与支付宝环境；查账策略在查账设置中单独调整。", fields: <FieldGroup>{providerIdentity}{providerEnvironment}</FieldGroup> }]
    : section === "collection" ? [{ title: "经营码", description: "只管理二维码；订单规则在各业务网站中设置。", fields: collectionIdentity }]
    : section === "collection-policy" ? [{ title: "PerPay 查账设置", description: "控制 PerPay 的查询频率与安全窗口，不属于支付宝官方应用配置。", fields: providerCollection }]
    : section === "display" ? [{ title: "界面显示", fields: displayFields }]
    : [{ title: sections.find(([value]) => value === section)?.[1] ?? "设置", ...(section === "backup" ? { description: "恢复需要数据库备份和主密钥。" } : {}), fields: section === "notifications" ? notificationFields : section === "backup" ? backupFields : advancedFields }];

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
      </Field>
    </FieldGroup>
  );

  const editor = (
    <form
      className={cn(
        "w-full min-w-0",
        guided && renderGuidedActions && "flex min-w-0 flex-col gap-5",
      )}
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
            renderGuidedActions ? (
              <Card>
                <CardContent>
                  <FieldGroup>
                    {panels.map((panel) => (
                      <FieldSet key={panel.title} className="min-w-0">
                        <FieldLegend>{panel.title}</FieldLegend>
                        {panel.fields}
                      </FieldSet>
                    ))}
                  </FieldGroup>
                </CardContent>
              </Card>
            ) : (
              panels.map((panel) => (
                <Fragment key={panel.title}>{panel.fields}</Fragment>
              ))
            )
          ) : (
            <Card>
              <CardHeader
                className={section === "display" ? "sr-only" : undefined}
              >
                <CardTitle role="heading" aria-level={2}>
                  {sections.find(([value]) => value === section)?.[1] ?? "设置"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <FieldGroup
                  className={cn(
                    "grid items-start gap-6",
                    section === "display" && "w-full max-w-2xl",
                    panels.length > 1 && "@3xl/settings:grid-cols-2",
                  )}
                >
                  {panels.map((panel) => (
                    <FieldSet key={panel.title} className="min-w-0">
                      <FieldLegend
                        className={panels.length === 1 ? "sr-only" : undefined}
                      >
                        {panel.title}
                      </FieldLegend>
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
          {guided && !renderGuidedActions && actions}
        </FieldGroup>
      </FieldSet>
      {guided && renderGuidedActions?.(actions)}
    </form>
  );
  if (guided && renderGuidedActions) return editor;
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
            {editor}
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

async function saveSettings(
  section: ConfigurationSection,
  form: FormData,
  settings: RuntimeSettings,
): Promise<RuntimeSettings> {
  const revision = settings.revision;
  const text = (key: string) => String(form.get(key) ?? "").trim();
  const integer = (key: string) => {
    const value = integerUnits(
      text(key),
      key === "timeout_milliseconds"
        ? 1000
        : key === "interval_seconds"
          ? Number(text("_backup_interval_unit") || 1)
          : 1,
    );
    if (value === null)
      throw new SettingsInputError(key, "请输入能精确换算的有效时间或整数。");
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
          },
        }),
      )
    ).data;
  }
  if (section === "provider") {
    const platformPublicKey = text("platform_public_key");
    if (!platformPublicKey) throw new SettingsInputError("platform_public_key", "请填写支付宝公钥。");
    return (await result(api.updateProviderSettings({ body: {
      revision, environment: text("environment") === "SANDBOX" ? "SANDBOX" : "PRODUCTION",
      app_id: text("app_id"), platform_public_key: platformPublicKey,
      ...(text("private_key") ? { private_key: text("private_key") } : {}),
    } }))).data;
  }
  if (section === "collection-policy") {
    const normal = integer("scan_interval_seconds"), active = integer("active_scan_interval_seconds"), minimum = integer("minimum_scan_interval_seconds"), maximumAge = integer("maximum_success_age_seconds");
    if (minimum > active) throw new SettingsInputError("minimum_scan_interval_seconds", "最小查账间隔不能大于活跃查账间隔。");
    if (active > normal) throw new SettingsInputError("active_scan_interval_seconds", "活跃查账间隔不能大于常规查账间隔。");
    if (maximumAge < normal * 2) throw new SettingsInputError("maximum_success_age_seconds", "查账有效时限至少要是常规查账间隔的两倍。");
    return (await result(api.updateCollectionPolicy({ body: {
      revision, timeout_milliseconds: integer("timeout_milliseconds"), scan_interval_seconds: normal,
      active_scan_interval_seconds: active, minimum_scan_interval_seconds: minimum,
      safety_lag_seconds: integer("safety_lag_seconds"), maximum_success_age_seconds: maximumAge,
    } }))).data;
  }
  if (section === "notifications") {
    if (settings.site_mode || !settings.notifications) throw new Error("通知设置已迁移至业务网站。");
    const notifications = settings.notifications;
    const enabled = form.has("enabled");
    const notificationNumber = (
      key:
        | "timeout_milliseconds"
        | "maximum_attempts"
        | "retry_base_seconds"
        | "retry_maximum_seconds",
    ) => (form.has(key) ? integer(key) : notifications[key]);
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
            system_name: text("system_name"),
            ...(settings.site_mode ? {} : { checkout_help_url: text("checkout_help_url") || null, checkout_show_product_name: form.has("checkout_show_product_name") }),
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
