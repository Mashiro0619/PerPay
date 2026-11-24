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
import { RotateCcw, Save } from "lucide-react";
import { PROVIDER_TIMING_DEFAULTS } from "../../../src/shared/provider-defaults";
import {
  CHECKOUT_TEXT_MAX_LENGTH,
  DEFAULT_CHECKOUT_COPY,
} from "../../../src/shared/checkout-display";
import {
  ApiError,
  api,
  result,
  type DashboardChartType,
  type RuntimeSettings,
} from "@/api/client";
import { Link } from "@/navigation";
import { useFormDraft } from "@/drafts";
import { OverlayActions } from "@/components/overlay-actions";
import { useOverlayContext } from "@/lib/overlay-context";
import { useSuccessToast } from "@/components/Feedback";
import { ErrorNotice } from "@/components/request-state";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  DASHBOARD_SECTION_KEYS,
  DASHBOARD_SECTION_META,
  hasVisibleDashboardSection,
  normalizeDashboardSections,
  normalizeDashboardWorkItemsLayout,
  serializeDashboardSections,
  writeCachedDashboardSections,
  writeCachedDashboardWorkItemsLayout,
  type DashboardSectionKey,
  type DashboardSections,
  type DashboardWorkItemsLayout,
} from "@/lib/dashboard-sections";
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
  FieldTitle,
} from "@/components/ui/field";
import {
  Card,
  CardAction,
  CardHeader,
  CardTitle,
  CardDescription,
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
  ["security", "账户与安全"],
  ["backup", "备份与恢复"],
  ["display", "界面显示"],
  ["advanced", "高级设置"],
] as const;
function NumberField({
  idPrefix = "setting",
  name,
  label,
  value,
  min,
  max,
  hint,
  error,
  scale = 1,
}: {
  idPrefix?: string;
  name: string;
  label: string;
  value: number;
  min: number;
  max: number;
  hint?: string;
  error?: string;
  scale?: number;
}) {
  const id = `${idPrefix}-${name}`;
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
  const idPrefix = "setting";
  const systemNameId = `${idPrefix}-system-name`;
  const systemNameErrorId = `${idPrefix}-system-name-error`;
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
  const [dashboardSections, setDashboardSections] = useState<DashboardSections>(() =>
    normalizeDashboardSections(initialSettings.display?.dashboard_sections),
  );
  const [savedDashboardSections, setSavedDashboardSections] = useState<DashboardSections>(dashboardSections);
  const serializedDashboardSections = serializeDashboardSections(dashboardSections);
  const [workItemsLayout, setWorkItemsLayout] = useState<DashboardWorkItemsLayout>(() =>
    normalizeDashboardWorkItemsLayout(initialSettings.display?.dashboard_work_items_layout),
  );
  const [savedWorkItemsLayout, setSavedWorkItemsLayout] = useState<DashboardWorkItemsLayout>(workItemsLayout);
  const [notFoundDetail, setNotFoundDetail] = useState<string>(
    initialSettings.display?.checkout_not_found_detail ?? "",
  );
  const [savedNotFoundDetail, setSavedNotFoundDetail] = useState<string | null>(
    initialSettings.display?.checkout_not_found_detail ?? null,
  );
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
      return saveSettings(
        section,
        form,
        settings,
        savedChartType,
        savedDashboardSections,
        savedWorkItemsLayout,
        savedNotFoundDetail,
      );
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
        const savedSections = normalizeDashboardSections(data.display?.dashboard_sections);
        setDashboardSections(savedSections);
        setSavedDashboardSections(savedSections);
        writeCachedDashboardSections(savedSections);
        form.set("dashboard_sections", serializeDashboardSections(savedSections));
        const savedLayout = normalizeDashboardWorkItemsLayout(data.display?.dashboard_work_items_layout);
        setWorkItemsLayout(savedLayout);
        setSavedWorkItemsLayout(savedLayout);
        writeCachedDashboardWorkItemsLayout(savedLayout);
        form.set("dashboard_work_items_layout", savedLayout);
        const savedNotFound = data.display?.checkout_not_found_detail ?? null;
        setNotFoundDetail(savedNotFound ?? "");
        setSavedNotFoundDetail(savedNotFound);
        form.set("checkout_not_found_detail", savedNotFound ?? "");
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
  useEffect(() => {
    // Wait until the disabled fieldset is released; FormData omits inputs inside a disabled fieldset.
    if (section === "display" && !save.isPending) draft.onChange();
  }, [chartType, serializedDashboardSections, workItemsLayout, notFoundDetail, section]);
  // Submitted saves retain the existing draft-confirmation flow in DraftProvider.
  useEffect(() => {
    // A mutation can publish field errors before its disabled fieldset is released.
    if (save.isPending) return;
    const name = Object.keys(fieldErrors)[0] ?? "";
    const field = name === "dashboard_chart_type"
      ? draft.form.current?.querySelector<HTMLElement>('[data-settings-chart-default] [aria-pressed="true"]')
      : name === "dashboard_work_items_layout"
        ? draft.form.current?.querySelector<HTMLElement>('[data-settings-work-items-layout] [aria-pressed="true"]')
        : name === "dashboard_sections"
          ? draft.form.current?.querySelector<HTMLElement>('[data-settings-dashboard-sections] [data-slot="switch"]:not([aria-disabled="true"])')
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

  function resetDraft() {
    draft.form.current?.reset();
    if (section === "display") {
      setChartType(savedChartType);
      setDashboardSections(savedDashboardSections);
      setWorkItemsLayout(savedWorkItemsLayout);
      setNotFoundDetail(savedNotFoundDetail ?? "");
    }
    setFieldErrors({});
    setSavedMessage("");
    save.reset();
    requestAnimationFrame(() => draft.onChange());
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
    <div className="flex min-w-0 flex-col gap-6">
      {overlay && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={recommendedProvider}
        >
          <RotateCcw data-icon="inline-start" />
          采用推荐值
        </Button>
      )}
      <div className="settings-section-group">
        <div className="flex flex-col gap-0.5">
          <h3 className="settings-section-group-title">轮询频率</h3>
          <p className="settings-section-group-desc">按当前是否存在待付款订单自动切换轮询节奏。</p>
        </div>
        <FieldGroup className="settings-fields-3">
          <NumberField
            idPrefix={idPrefix}
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
            idPrefix={idPrefix}
            name="active_scan_interval_seconds"
            error={fieldErrors.active_scan_interval_seconds}
            label="活跃查账间隔（秒）"
            value={
              initialSettings.collection_policy?.active_scan_interval_seconds ??
              PROVIDER_TIMING_DEFAULTS.activeScanIntervalSeconds
            }
            min={5}
            max={3600}
            hint="有待付款订单时使用，不能大于常规查账间隔。"
          />
          <NumberField
            idPrefix={idPrefix}
            name="minimum_scan_interval_seconds"
            error={fieldErrors.minimum_scan_interval_seconds}
            label="最小查账间隔（秒）"
            value={initialSettings.collection_policy?.minimum_scan_interval_seconds ?? PROVIDER_TIMING_DEFAULTS.activeScanIntervalSeconds}
            min={5}
            max={3600}
            hint="限制自动与收银台触发查账的最小间隔，且不能大于活跃查账间隔。"
          />
        </FieldGroup>
      </div>
      <Separator />
      <div className="settings-section-group">
        <div className="flex flex-col gap-0.5">
          <h3 className="settings-section-group-title">超时与稳健保护</h3>
          <p className="settings-section-group-desc">防止接口异常或账单延迟导致误判或漏单。</p>
        </div>
        <FieldGroup className="settings-fields-3">
          <NumberField
            idPrefix={idPrefix}
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
            hint="单次支付宝账单查询请求的最长等待时间。"
          />
          <NumberField
            idPrefix={idPrefix}
            name="safety_lag_seconds"
            error={fieldErrors.safety_lag_seconds}
            label="查账延迟（秒）"
            value={
              initialSettings.collection_policy?.safety_lag_seconds ??
              PROVIDER_TIMING_DEFAULTS.safetyLagSeconds
            }
            min={5}
            max={300}
            hint="只查询早于当前时间指定秒数的账单，等待支付宝记录稳定。"
          />
          <NumberField
            idPrefix={idPrefix}
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
      </div>
    </div>
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
          label="保留备份数量（份）"
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
  const enabledDashboardSectionCount = DASHBOARD_SECTION_KEYS.filter(
    (key) => dashboardSections[key],
  ).length;
  const displayRowClassName =
    "gap-2";
  const displayFields = (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="settings-section-group">
        <div className="flex flex-col gap-0.5">
          <h3 className="settings-section-group-title">总览页面偏好</h3>
          <p className="settings-section-group-desc">控制管理员总览页的默认图表、待处理排列与模块显隐。</p>
        </div>
        <FieldGroup className="gap-5">
          <FieldGroup className="settings-fields">
            <Field orientation="vertical" className={displayRowClassName} data-invalid={!!fieldErrors.dashboard_chart_type}>
              <FieldTitle id={formId + "-chart-label"}>收款趋势默认图形</FieldTitle>
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
                  {([["AREA", "面积图"], ["BAR", "柱状图"], ["LINE", "累计图"]] as const).map(([value, label]) =>
                    <ToggleGroupItem key={value} value={value} type="button" disabled={save.isPending}
                      aria-invalid={!!fieldErrors.dashboard_chart_type}
                      className="h-auto min-h-8 min-w-0 flex-[1_1_5rem] whitespace-normal py-2 max-md:flex-[0_1_auto] max-md:py-1">{label}</ToggleGroupItem>)}
                </ToggleGroup>
                <FieldDescription id={formId + "-chart-hint"}>用于未设置个人图形偏好的浏览器。</FieldDescription>
                {fieldErrors.dashboard_chart_type && <FieldError id={formId + "-chart-error"}>{fieldErrors.dashboard_chart_type}</FieldError>}
              </FieldContent>
            </Field>
            <Field
              orientation="vertical"
              className={displayRowClassName}
              data-invalid={!!fieldErrors.dashboard_work_items_layout}
            >
              <FieldTitle id={formId + "-work-layout-label"}>待处理排列方式</FieldTitle>
              <FieldContent className="min-w-0">
                <input
                  type="hidden"
                  name="dashboard_work_items_layout"
                  value={workItemsLayout}
                />
                <ToggleGroup
                  data-settings-work-items-layout
                  variant="outline"
                  value={[workItemsLayout]}
                  aria-labelledby={formId + "-work-layout-label"}
                  aria-describedby={
                    formId + "-work-layout-hint" +
                    (fieldErrors.dashboard_work_items_layout ? " " + formId + "-work-layout-error" : "")
                  }
                  aria-invalid={!!fieldErrors.dashboard_work_items_layout}
                  className="w-full max-w-full flex-wrap items-stretch max-md:w-fit"
                  onValueChange={(values) => {
                    const value = values[0];
                    if (value !== "STACKED" && value !== "SIDE_BY_SIDE") return;
                    setWorkItemsLayout(value);
                    setSavedMessage("");
                    save.reset();
                    setFieldErrors((current) => {
                      if (!current.dashboard_work_items_layout) return current;
                      const next = { ...current };
                      delete next.dashboard_work_items_layout;
                      return next;
                    });
                  }}
                >
                  {([["STACKED", "独立成行"], ["SIDE_BY_SIDE", "与订单并排"]] as const).map(([value, label]) => (
                    <ToggleGroupItem
                      key={value}
                      value={value}
                      type="button"
                      disabled={save.isPending}
                      aria-invalid={!!fieldErrors.dashboard_work_items_layout}
                      className="h-auto min-h-8 min-w-0 flex-[1_1_6rem] whitespace-normal py-2 max-md:flex-[0_1_auto] max-md:py-1"
                    >
                      {label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <FieldDescription id={formId + "-work-layout-hint"}>
                  {dashboardSections.work_items && dashboardSections.recent_orders
                    ? "宽屏下可选独立成行（双列卡片）或与订单并排；小屏或无待处理时自动上下排列。"
                    : "同时开启「待处理」与「最近订单」时生效；小屏或无待处理时自动上下排列。"}
                </FieldDescription>
                {fieldErrors.dashboard_work_items_layout && (
                  <FieldError id={formId + "-work-layout-error"}>
                    {fieldErrors.dashboard_work_items_layout}
                  </FieldError>
                )}
              </FieldContent>
            </Field>
          </FieldGroup>
          <Field
            orientation="vertical"
            className={displayRowClassName}
            data-invalid={!!fieldErrors.dashboard_sections}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <FieldTitle id={formId + "-sections-label"}>总览显示模块</FieldTitle>
              <Badge variant="secondary" className="tabular-nums">
                已开启 {enabledDashboardSectionCount} / {DASHBOARD_SECTION_KEYS.length}
              </Badge>
            </div>
            <FieldContent className="min-w-0">
              <input
                type="hidden"
                name="dashboard_sections"
                value={serializedDashboardSections}
              />
              <div
                role="group"
                data-settings-dashboard-sections
                aria-labelledby={formId + "-sections-label"}
                aria-describedby={
                  formId + "-sections-hint" +
                  (fieldErrors.dashboard_sections ? " " + formId + "-sections-error" : "")
                }
                className="settings-display-sections"
              >
                {DASHBOARD_SECTION_META.map((item) => {
                  const checked = dashboardSections[item.key];
                  const lockedLast = checked && enabledDashboardSectionCount <= 1;
                  const switchId = `${formId}-section-${item.key}`;
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
                        checked={checked}
                        disabled={save.isPending || lockedLast}
                        aria-describedby={hintId}
                        aria-invalid={!!fieldErrors.dashboard_sections}
                        onCheckedChange={(nextChecked) => {
                          if (!nextChecked && enabledDashboardSectionCount <= 1) return;
                          setDashboardSections((current) => ({
                            ...current,
                            [item.key]: nextChecked,
                          }));
                          setSavedMessage("");
                          save.reset();
                          setFieldErrors((current) => {
                            if (!current.dashboard_sections) return current;
                            const next = { ...current };
                            delete next.dashboard_sections;
                            return next;
                          });
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              <FieldDescription id={formId + "-sections-hint"}>
                控制总览页展示的卡片模块，至少保留一项开启。
              </FieldDescription>
              {fieldErrors.dashboard_sections && (
                <FieldError id={formId + "-sections-error"}>
                  {fieldErrors.dashboard_sections}
                </FieldError>
              )}
            </FieldContent>
          </Field>
        </FieldGroup>
      </div>
      <Separator />
      <div className="settings-section-group">
        <div className="flex flex-col gap-0.5">
          <h3 className="settings-section-group-title">品牌与失效收银台</h3>
          <p className="settings-section-group-desc">设置后台实例名称以及全局 404 收银台提示文案。</p>
        </div>
        <FieldGroup className="gap-5">
          <Field
            orientation="vertical"
            className={displayRowClassName}
            data-invalid={!!fieldErrors.system_name}
          >
            <FieldLabel htmlFor={systemNameId}>系统名称</FieldLabel>
            <FieldContent className="min-w-0">
              <Input
                id={systemNameId}
                name="system_name"
                required
                maxLength={40}
                defaultValue={initialSettings.display?.system_name ?? "PerPay"}
                aria-invalid={!!fieldErrors.system_name}
                aria-describedby={
                  fieldErrors.system_name ? systemNameErrorId : undefined
                }
              />
              {fieldErrors.system_name && (
                <FieldError id={systemNameErrorId}>
                  {fieldErrors.system_name}
                </FieldError>
              )}
            </FieldContent>
          </Field>
          <Field
            orientation="vertical"
            className={displayRowClassName}
            data-invalid={!!fieldErrors.checkout_not_found_detail}
          >
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor={formId + "-not-found-detail"}>订单不存在（404）说明</FieldLabel>
              {notFoundDetail.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label="恢复默认：订单不存在（404）说明"
                  className="h-auto px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                  disabled={save.isPending}
                  onClick={() => {
                    setNotFoundDetail("");
                    setSavedMessage("");
                    save.reset();
                    setFieldErrors((current) => {
                      if (!current.checkout_not_found_detail) return current;
                      const next = { ...current };
                      delete next.checkout_not_found_detail;
                      return next;
                    });
                  }}
                >
                  恢复默认
                </Button>
              )}
            </div>
            <FieldContent className="min-w-0">
              <Textarea
                id={formId + "-not-found-detail"}
                name="checkout_not_found_detail"
                rows={2}
                maxLength={CHECKOUT_TEXT_MAX_LENGTH}
                placeholder={DEFAULT_CHECKOUT_COPY.notFoundDetail}
                value={notFoundDetail}
                aria-invalid={!!fieldErrors.checkout_not_found_detail}
                aria-describedby={
                  formId +
                  "-not-found-hint" +
                  (fieldErrors.checkout_not_found_detail ? " " + formId + "-not-found-error" : "")
                }
                onChange={(event) => {
                  setNotFoundDetail(event.target.value);
                  setSavedMessage("");
                  save.reset();
                  setFieldErrors((current) => {
                    if (!current.checkout_not_found_detail) return current;
                    const next = { ...current };
                    delete next.checkout_not_found_detail;
                    return next;
                  });
                }}
              />
              <FieldDescription id={formId + "-not-found-hint"}>
                访问失效或不存在的收银台链接（404）时展示；留空即使用系统默认文案。各网站订单收银台文案请在网站“收银台展示”中配置。
              </FieldDescription>
              {fieldErrors.checkout_not_found_detail && (
                <FieldError id={formId + "-not-found-error"}>
                  {fieldErrors.checkout_not_found_detail}
                </FieldError>
              )}
            </FieldContent>
          </Field>
        </FieldGroup>
      </div>
    </div>
  );
  const advancedFields = (
    <FieldGroup>
      <FieldGroup className="settings-fields">
        <NumberField
          idPrefix={idPrefix}
          name="checkout_key_rotation_days"
          error={fieldErrors.checkout_key_rotation_days}
          label="收银台链接密钥更换周期（天）"
          value={initialSettings.advanced.checkout_key_rotation_days}
          min={1}
          max={3650}
          hint="不影响已有订单链接，通常无需修改。"
        />
        <NumberField
          idPrefix={idPrefix}
          name="checkout_terminal_observation_seconds"
          error={fieldErrors.checkout_terminal_observation_seconds}
          label="订单结束后收银台可查时长（秒）"
          value={initialSettings.advanced.checkout_terminal_observation_seconds}
          min={60}
          max={604800}
          hint="仅影响新订单的公开状态查询，不延长付款期限，不影响后台处理迟到账单。"
        />
      </FieldGroup>
    </FieldGroup>
  );

  const title = sections.find(([value]) => value === section)![1];
  const sectionDescriptions: Readonly<Record<ConfigurationSection, string>> = {
    "collection-policy": "控制支付宝账单轮询频率、请求超时与有效时限，所有收款账号共用此策略。",
    display: "自定义总览页面默认展示、系统名称与失效收银台说明文案。",
    advanced: "配置收银台链接密钥轮换周期与订单结束后公开状态可查时长，通常保持默认即可。",
    backup: "设置自动备份的执行频率与保留份数；恢复数据需同时保管主密钥。",
  };
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
      <Field orientation="horizontal" data-settings-actions className="w-full flex-wrap items-center justify-end gap-2">
        {draft.dirty && (
          <span className="settings-dirty-pill mr-auto" role="status">
            未保存
          </span>
        )}
        {!overlay && draft.dirty && (
          <Button type="button" variant="outline" size="sm" disabled={save.isPending} onClick={resetDraft}>
            重置
          </Button>
        )}
        {overlay && <Button type="button" variant="outline" disabled={save.isPending} onClick={() => overlay.requestClose()}>关闭</Button>}
        <Button form={formId} type="submit" className="h-auto min-h-8 max-w-full whitespace-normal" disabled={!draft.dirty || save.isPending} aria-busy={save.isPending}>
          {save.isPending ? (
            <Spinner aria-hidden="true" data-icon="inline-start" />
          ) : (
            <Save data-icon="inline-start" />
          )}
          保存
        </Button>
      </Field>
    </FieldGroup>
  );

  return (
    <form
      id={formId}
      className="settings-form-surface w-full min-w-0"
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
      <FieldGroup>
        <Card size="sm" data-settings-editor-card={section}>
          {!overlay && (
            <CardHeader>
              <CardTitle role="heading" aria-level={2}>{title}</CardTitle>
              <CardDescription>{sectionDescriptions[section]}</CardDescription>
              {section === "collection-policy" && (
                <CardAction>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={save.isPending}
                    onClick={recommendedProvider}
                  >
                    <RotateCcw data-icon="inline-start" />
                    采用推荐值
                  </Button>
                </CardAction>
              )}
            </CardHeader>
          )}
          <CardContent>
            <FieldSet disabled={save.isPending} className="min-w-0">
              <FieldLegend className="sr-only">{title}</FieldLegend>
              {section === "backup" && <FieldDescription>恢复需要数据库备份和主密钥。</FieldDescription>}
              {fields}
            </FieldSet>
          </CardContent>
          {overlay ? <OverlayActions className="w-full">{actions}</OverlayActions> : <CardFooter className="settings-save-footer">{actions}</CardFooter>}
        </Card>
      </FieldGroup>
    </form>
  );
}

async function saveSettings(
  section: ConfigurationSection,
  form: FormData,
  settings: RuntimeSettings,
  savedChartType: DashboardChartType,
  savedDashboardSections: DashboardSections,
  savedWorkItemsLayout: DashboardWorkItemsLayout,
  savedNotFoundDetail: string | null,
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
    let parsedSections: DashboardSections;
    try {
      const raw = JSON.parse(text("dashboard_sections")) as Partial<Record<DashboardSectionKey, unknown>>;
      parsedSections = normalizeDashboardSections(raw);
    } catch {
      throw new SettingsInputError("dashboard_sections", "总览显示模块配置无效。");
    }
    if (!hasVisibleDashboardSection(parsedSections)) {
      throw new SettingsInputError("dashboard_sections", "请至少保留一项总览显示模块。");
    }
    const sectionsChanged =
      serializeDashboardSections(parsedSections) !== serializeDashboardSections(savedDashboardSections);
    const serverSections = settings.display?.dashboard_sections;
    const selectedWorkItemsLayout = text("dashboard_work_items_layout");
    if (selectedWorkItemsLayout !== "STACKED" && selectedWorkItemsLayout !== "SIDE_BY_SIDE") {
      throw new SettingsInputError("dashboard_work_items_layout", "请选择有效的待处理排列方式。");
    }
    const workItemsLayoutChanged = selectedWorkItemsLayout !== savedWorkItemsLayout;
    const rawNotFound = text("checkout_not_found_detail");
    const nextNotFound = rawNotFound === "" ? null : rawNotFound;
    const notFoundChanged = nextNotFound !== savedNotFoundDetail;
    return (
      await result(
        api.updateDisplaySettings({
          body: {
            revision,
            system_name: text("system_name"),
            dashboard_chart_type: selectedType === savedChartType
              ? settings.display?.dashboard_chart_type ?? "AREA"
              : selectedType,
            ...(sectionsChanged
              ? { dashboard_sections: parsedSections }
              : serverSections
                ? { dashboard_sections: normalizeDashboardSections(serverSections) }
                : {}),
            ...(workItemsLayoutChanged
              ? { dashboard_work_items_layout: selectedWorkItemsLayout }
              : {}),
            ...(notFoundChanged
              ? { checkout_not_found_detail: nextNotFound }
              : {}),
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
