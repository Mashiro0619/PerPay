import { integerUnits } from "../../../src/shared/time-units";
import { BackupStatus } from "@/components/backup-status";
import { setSystemName } from "@/branding";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { onlineManager, useMutation, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { PROVIDER_TIMING_DEFAULTS } from "../../../src/shared/provider-defaults";
import {
  ApiError,
  api,
  result,
  type DashboardChartType,
  type RuntimeSettings,
} from "@/api/client";
import { Link } from "@/navigation";
import { cn } from "@/lib/utils";
import { useFormDraft } from "@/drafts";
import { OverlayActions } from "@/components/overlay-actions";
import { useOverlayContext } from "@/lib/overlay-context";
import { useSuccessToast } from "@/components/Feedback";
import { ErrorNotice } from "@/components/request-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
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
class SettingsInputError extends Error {
  readonly fields: Record<string, string>;
  constructor(field: string, message: string) {
    super(message);
    this.fields = { [field]: message };
  }
}
export type ConfigurationSection =
  | "collection-policy"
  | "backup"
  | "advanced"
  | "display";
export const sections = [
  ["accounts", "支付宝账号"],
  ["collection-policy", "查账设置"],
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
      <div className="flex max-w-xs flex-wrap items-center gap-2">
        <Input
          id="setting-interval_seconds"
          className="min-w-0 flex-1"
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
          <SelectTrigger aria-label="备份间隔单位" className="shrink-0">
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
export function SettingsEditor({
  section,
  settings,
  onSaved,
  onFeedback,
}: {
  section: ConfigurationSection;
  settings: RuntimeSettings;
  onSaved: (settings: RuntimeSettings, message?: string) => void;
  onFeedback?: (message: string) => void;
}) {
  // Keep defaults stable for this mounted draft when a sibling form saves.
  // Explicit refreshes remount the editor; saves still use the latest revision.
  const [initialSettings] = useState(settings);
  const overlay = useOverlayContext();
  const formId = useId();
  function revealField(field: HTMLElement) {
    requestAnimationFrame(() => {
      if (field.isConnected && !field.matches(":disabled")) field.focus();
    });
  }
  const submitting = useRef(false);
  const draft = useFormDraft(() => submitting.current);
  const queryClient = useQueryClient();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [chartType, setChartType] = useState<DashboardChartType>(
    initialSettings.display?.dashboard_chart_type ?? "AREA",
  );
  const [savedChartType, setSavedChartType] = useState(chartType);
  useEffect(() => {
    if (section === "display") draft.onChange();
  }, [chartType, section]);
  const mounted = useRef(false);
  const localFeedback = useSuccessToast();
  // A parent that remounts this editor after saving keeps the same toast owner.
  const setSavedMessage = onFeedback ?? localFeedback;
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
      return saveSettings(section, form, settings, savedChartType);
    },
    onSuccess: (data, form) => {
      if (!mounted.current) {
        // A dispatched save can complete after navigation; reread it on return.
        void queryClient.invalidateQueries({ queryKey: ["settings"], exact: true, refetchType: "none" });
        return;
      }
      if (section === "display") {
        if (data.display?.system_name) setSystemName(data.display.system_name);
        const savedType = data.display?.dashboard_chart_type ?? "AREA";
        setChartType(savedType);
        setSavedChartType(savedType);
        form.set("dashboard_chart_type", savedType);
      }
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
  // Submitted saves retain the existing draft-confirmation flow in DraftProvider.
  useEffect(() => {
    // A mutation can publish field errors before its disabled fieldset is released.
    if (save.isPending) return;
    const name = Object.keys(fieldErrors)[0] ?? "";
    const field = name === "dashboard_chart_type"
      ? draft.form.current?.querySelector<HTMLElement>('[data-settings-chart-default] [aria-pressed="true"]')
      : draft.form.current?.elements.namedItem(name);
    if (!(field instanceof HTMLElement)) return;
    revealField(field);
    requestAnimationFrame(() => field.focus());
  }, [fieldErrors, save.isPending, draft.form]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.isPending || submitting.current || !draft.dirty) return;
    submitting.current = true;
    setFieldErrors({});
    setSavedMessage("");
    save.mutate(new FormData(event.currentTarget));
  }

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
          initialSettings.collection_policy?.timeout_milliseconds ??
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
          initialSettings.collection_policy?.scan_interval_seconds ??
          PROVIDER_TIMING_DEFAULTS.scanIntervalSeconds
        }
        min={5}
        max={3600}
        hint="无待付款订单时使用。"
      />
      <NumberField
        name="active_scan_interval_seconds"
        error={fieldErrors.active_scan_interval_seconds}
        label="活跃查账间隔（秒）"
        value={
          initialSettings.collection_policy?.active_scan_interval_seconds ??
          PROVIDER_TIMING_DEFAULTS.activeScanIntervalSeconds
        }
        min={5}
        max={3600}
        hint="有待付款订单时使用，不能大于常规间隔。"
      />
      <NumberField
        name="minimum_scan_interval_seconds"
        error={fieldErrors.minimum_scan_interval_seconds}
        label="查账最小间隔（秒）"
        value={initialSettings.collection_policy?.minimum_scan_interval_seconds ?? PROVIDER_TIMING_DEFAULTS.activeScanIntervalSeconds}
        min={5}
        max={3600}
        hint="也适用于手动核实，不能大于活跃间隔。"
      />
      <NumberField
        name="safety_lag_seconds"
        error={fieldErrors.safety_lag_seconds}
        label="查账延迟（秒）"
        value={
          initialSettings.collection_policy?.safety_lag_seconds ??
          PROVIDER_TIMING_DEFAULTS.safetyLagSeconds
        }
        min={5}
        max={300}
        hint="仅查询 N 秒前的账单，等待支付宝记录稳定。"
      />
      <NumberField
        name="maximum_success_age_seconds"
        error={fieldErrors.maximum_success_age_seconds}
        label="查账有效时限（秒）"
        value={
          initialSettings.collection_policy?.maximum_success_age_seconds ??
          PROVIDER_TIMING_DEFAULTS.maximumSuccessAgeSeconds
        }
        min={10}
        max={86400}
        hint="超过有效时限未成功查账的账号将暂停接收新订单，其未付款收银台暂不可用。网站仍可使用已配置的其他就绪账号。"
      />
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
      <Field orientation="vertical" className={displayRowClassName} data-invalid={!!fieldErrors.dashboard_chart_type}>
        <FieldLabel id={formId + "-chart-label"}>收款趋势默认图形</FieldLabel>
        <FieldContent className="min-w-0">
          <input type="hidden" name="dashboard_chart_type" value={chartType} />
          <ToggleGroup data-settings-chart-default variant="outline" value={[chartType]}
            aria-labelledby={formId + "-chart-label"}
            aria-describedby={formId + "-chart-hint" + (fieldErrors.dashboard_chart_type ? " " + formId + "-chart-error" : "")}
            aria-invalid={!!fieldErrors.dashboard_chart_type}
            className="w-full max-w-full flex-wrap items-stretch max-md:w-fit"
            onValueChange={values => {
              const value = values[0];
              if (value !== "AREA" && value !== "BAR" && value !== "LINE") return;
              setChartType(value);
              setSavedMessage("");
              save.reset();
              setFieldErrors(current => {
                if (!current.dashboard_chart_type) return current;
                const next = { ...current };
                delete next.dashboard_chart_type;
                return next;
              });
            }}>
            {([["AREA", "面积图"], ["BAR", "柱状图"], ["LINE", "折线图"]] as const).map(([value, label]) =>
              <ToggleGroupItem key={value} value={value} type="button" disabled={save.isPending}
                aria-invalid={!!fieldErrors.dashboard_chart_type}
                className="h-auto min-h-8 min-w-0 flex-[1_1_6rem] whitespace-normal py-2 max-md:flex-[0_1_auto] max-md:py-1">{label}</ToggleGroupItem>)}
          </ToggleGroup>
          <FieldDescription id={formId + "-chart-hint"}>用于未设置个人图形偏好的浏览器。</FieldDescription>
          {fieldErrors.dashboard_chart_type && <FieldError id={formId + "-chart-error"}>{fieldErrors.dashboard_chart_type}</FieldError>}
        </FieldContent>
      </Field>
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
          hint="不影响已有订单链接，通常无需修改。"
        />
        <NumberField
          name="checkout_terminal_observation_seconds"
          error={fieldErrors.checkout_terminal_observation_seconds}
          label="结束后可查询时长（秒）"
          value={initialSettings.advanced.checkout_terminal_observation_seconds}
          min={60}
          max={604800}
          hint="仅影响新订单的公开状态查询，不延长付款期限，不影响后台处理迟到账单。"
        />
      </FieldGroup>
    </FieldGroup>
  );

  const title = sections.find(([value]) => value === section)![1];
  const fields = section === "collection-policy" ? providerCollection
    : section === "display" ? displayFields : section === "backup" ? backupFields : advancedFields;

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
        {overlay && <Button type="button" variant="outline" disabled={save.isPending} onClick={() => overlay.requestClose()}>关闭</Button>}
        <Button form={formId} type="submit" className="h-auto min-h-8 max-w-full whitespace-normal" disabled={!draft.dirty || save.isPending} aria-busy={save.isPending}>
          {save.isPending ? (
            <Spinner aria-hidden="true" data-icon="inline-start" />
          ) : (
            <Save data-icon="inline-start" />
          )}
          保存
        </Button>
        {draft.dirty && (
          <span className="text-sm text-muted-foreground" role="status">
            未保存
          </span>
        )}
      </Field>
    </FieldGroup>
  );

  return (
    <form
      id={formId}
      className="w-full min-w-0"
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
          <Card>
            {!overlay && (
              <CardHeader className={section === "display" ? "sr-only" : undefined}>
                <CardTitle role="heading" aria-level={2}>{title}</CardTitle>
              </CardHeader>
            )}
            <CardContent>
              <FieldSet className={cn("min-w-0", section === "display" && !overlay && "max-w-2xl")}>
                <FieldLegend className="sr-only">{title}</FieldLegend>
                {section === "backup" && <FieldDescription>恢复需要数据库备份和主密钥。</FieldDescription>}
                {fields}
              </FieldSet>
            </CardContent>
            {overlay ? <OverlayActions className="w-full">{actions}</OverlayActions> : <CardFooter>{actions}</CardFooter>}
          </Card>
        </FieldGroup>
      </FieldSet>
    </form>
  );
}

async function saveSettings(
  section: ConfigurationSection,
  form: FormData,
  settings: RuntimeSettings,
  savedChartType: DashboardChartType,
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
  if (section === "display") {
    const selectedType = text("dashboard_chart_type");
    if (selectedType !== "AREA" && selectedType !== "BAR" && selectedType !== "LINE")
      throw new SettingsInputError("dashboard_chart_type", "请选择有效的默认图形。");
    return (
      await result(
        api.updateDisplaySettings({
          body: {
            revision,
            system_name: text("system_name"),
            dashboard_chart_type: selectedType === savedChartType
              ? settings.display?.dashboard_chart_type ?? "AREA"
              : selectedType,
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
