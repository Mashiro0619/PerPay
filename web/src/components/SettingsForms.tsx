import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { KeyRound, Save } from "lucide-react";

import { collectionCodeError } from "../../../src/shared/collection-code";
import { ApiError, api, result, type RuntimeSettings } from "../api/client";
import { Link } from "../navigation";
import { useDraftGuard, useFormDraft } from "../drafts";
import { CollectionCodeField } from "./CollectionCodeField";
import { Button, CopyValue, ErrorNotice, Field, Notice, Panel } from "./ui";

class SettingsInputError extends Error {
  readonly fields: Record<string, string>;
  constructor(field: string, message: string) { super(message); this.fields = { [field]: message }; }
}

export type ConfigurationSection = "provider" | "collection" | "notifications" | "backup" | "advanced";
export const sections = [["provider", "支付宝接入"], ["collection", "经营码与订单"], ["notifications", "业务通知"], ["security", "密钥与安全"], ["backup", "自动备份"], ["advanced", "高级设置"]] as const;

function AdvancedFields({ collapsed, children, label = "高级设置" }: { collapsed: boolean; children: ReactNode; label?: string }) {
  return collapsed ? <details className="form-disclosure"><summary>{label}</summary>{children}</details> : children;
}

function NumberField({ name, label, value, min, max, hint, error }: { name: string; label: string; value: number; min: number; max: number; hint?: string; error?: string }) {
  return <Field label={label} hint={hint} error={error}><input name={name} type="number" inputMode="numeric" min={min} max={max} step={1} required defaultValue={value} /></Field>;
}

function revealField(field: HTMLElement) {
  for (let parent = field.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
}

function backupInterval(seconds: number) {
  if (seconds % 86400 === 0) return seconds === 86400 ? "每天" : "每 " + seconds / 86400 + " 天";
  return seconds % 3600 === 0 ? "每 " + seconds / 3600 + " 小时" : "每 " + seconds + " 秒";
}

export function SettingsEditor({ section, settings, onSaved, guided = false, submitLabel = "保存配置", secondaryAction }: {
  section: ConfigurationSection; settings: RuntimeSettings; onSaved: (settings: RuntimeSettings, message?: string) => void;
  guided?: boolean; submitLabel?: string; secondaryAction?: ReactNode;
}) {
  const draft = useFormDraft();
  const [decoding, setDecoding] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    const field = draft.form.current?.elements.namedItem(Object.keys(fieldErrors)[0] ?? "");
    if (!(field instanceof HTMLElement)) return;
    revealField(field);
    field.focus();
  }, [fieldErrors, draft.form]);
  const [notificationEnabled, setNotificationEnabled] = useState(settings.notifications.enabled);
  useEffect(() => {
    // Disabled optional fields enter/leave FormData after the checkbox's change event.
    if (guided && section === "notifications") draft.onChange();
  }, [notificationEnabled, guided, section]);
  const mounted = useRef(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const save = useMutation({ mutationFn: (form: FormData) => saveSettings(section, form, settings), onSuccess: (data, form) => {
    if (!mounted.current) return;
    draft.markSaved(form);
    setSavedMessage("已保存");
    onSaved(data);
  }, onError: (error) => {
    if (mounted.current && (error instanceof ApiError || error instanceof SettingsInputError)) setFieldErrors({ ...error.fields });
  } });
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!decoding && !save.isPending) { setFieldErrors({}); save.mutate(new FormData(event.currentTarget)); } }
  const environment = <Field label="支付宝环境" error={fieldErrors.environment}><select name="environment" defaultValue={settings.provider?.environment ?? "PRODUCTION"}><option value="PRODUCTION">生产环境</option><option value="SANDBOX">沙箱环境</option></select></Field>;
  const editor = <form ref={draft.form} className="form-stack" onSubmit={submit} onInvalidCapture={(event) => { if (event.target instanceof HTMLElement) revealField(event.target); }} onChange={(event) => {
    draft.onChange(); setSavedMessage(null);
    const control = event.target;
    const name = control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement ? control.name : "";
    if (name && fieldErrors[name]) setFieldErrors((current) => { const next = { ...current }; delete next[name]; return next; });
  }} autoComplete="off"><fieldset disabled={save.isPending}>
    {section === "provider" && <>
      {!guided && <Notice>先生成应用密钥，并将应用公钥上传至支付宝开放平台；再填写平台返回的支付宝公钥。两种公钥不能混用。</Notice>}
      <div className={guided ? "form-stack" : "form-grid"}>{!guided && environment}<Field label="应用 ID（App ID）" error={fieldErrors.app_id}><input name="app_id" required maxLength={64} pattern="[A-Za-z0-9._-]+" defaultValue={settings.provider?.app_id ?? ""} autoComplete="off" placeholder="支付宝开放平台的应用 ID" /></Field></div>
      <Field label="支付宝公钥" error={fieldErrors.platform_public_key} hint={settings.secrets.provider_public_key.configured ? "已配置，留空不变。" : "从支付宝平台复制，不是应用公钥。"}><textarea name="platform_public_key" rows={4} required={!settings.secrets.provider_public_key.configured} maxLength={16384} autoComplete="off" spellCheck={false} placeholder="粘贴支付宝公钥（Base64 或 PEM）" /></Field>
      {!guided && <details className="form-disclosure"><summary>导入已有应用私钥（可选）</summary><Field label="应用私钥" error={fieldErrors.private_key} hint="留空使用已生成的私钥。替换密钥前，请确认支付宝平台中的应用公钥已同步。"><textarea name="private_key" rows={4} maxLength={16384} autoComplete="off" spellCheck={false} /></Field></details>}
      <AdvancedFields collapsed={guided} label={settings.provider?.environment === "SANDBOX" ? "高级设置 · 沙箱环境" : "高级设置"}><div className="form-grid">{guided && environment}<NumberField name="timeout_milliseconds" error={fieldErrors.timeout_milliseconds} label="请求超时（毫秒）" value={settings.provider?.timeout_milliseconds ?? 8000} min={1000} max={120000} /><NumberField name="scan_interval_seconds" error={fieldErrors.scan_interval_seconds} label="常规采集间隔（秒）" value={settings.provider?.scan_interval_seconds ?? 30} min={5} max={3600} hint="没有待支付订单且收尾结束时使用。采集有效时限须至少为此间隔的两倍。" />
        <NumberField name="active_scan_interval_seconds" error={fieldErrors.active_scan_interval_seconds} label="活跃采集间隔（秒）" value={settings.provider?.active_scan_interval_seconds ?? settings.provider?.scan_interval_seconds ?? 5} min={5} max={3600} hint="待支付订单及自动收尾期使用，不得大于常规间隔。关闭或过期后收尾至少 60 秒；限流退避仍然生效。" />
        <NumberField name="safety_lag_seconds" error={fieldErrors.safety_lag_seconds} label="安全延迟（秒）" value={settings.provider?.safety_lag_seconds ?? 10} min={5} max={300} hint="避开支付宝尚未稳定返回的最新账单。" /><NumberField name="maximum_success_age_seconds" error={fieldErrors.maximum_success_age_seconds} label="采集有效时限（秒）" value={settings.provider?.maximum_success_age_seconds ?? 60} min={10} max={86400} hint="超过此时限未成功采集，会暂停新订单收款入口。" /></div></AdvancedFields>
    </>}
    {section === "collection" && <>
      <CollectionCodeField defaultValue={settings.collection?.code_payload ?? ""} onDecoded={() => { draft.onChange(); setFieldErrors({}); setSavedMessage(null); }} error={fieldErrors.code_payload} onPendingChange={setDecoding} disabled={save.isPending} />
      <AdvancedFields collapsed={guided}><div className="form-grid"><NumberField name="order_ttl_seconds" error={fieldErrors.order_ttl_seconds} label="收银台有效期（秒）" value={settings.collection?.order_ttl_seconds ?? 300} min={60} max={1800} /><NumberField name="amount_offset_maximum_cents" error={fieldErrors.amount_offset_maximum_cents} label="最大金额尾差（分）" value={settings.collection?.amount_offset_maximum_cents ?? 99} min={1} max={99} hint="为订单分配唯一应付金额；付款人必须支付收银台显示的准确金额。" /></div></AdvancedFields>
      {!guided && <Notice>经营码或支付宝账户变更会影响后续收款。已有订单仍保留其创建时的配置与账务证据。</Notice>}
    </>}
    {section === "notifications" && <>
      {guided && <p className="field-hint">付款后通知网站；关闭时需由网站主动查单。</p>}
      <label className="checkbox-field"><input name="enabled" type="checkbox" checked={notificationEnabled} onChange={(event) => setNotificationEnabled(event.target.checked)} /><span>启用业务通知</span></label>
      <fieldset className="notification-fields" hidden={guided && !notificationEnabled} disabled={guided && !notificationEnabled}>
        <Field label="允许的通知网站 Origin" error={fieldErrors.allowed_origin} hint={guided ? "HTTPS 域名，不含端口或路径。" : "只填写 HTTPS 协议和域名（不含端口），例如 https://shop.example.com，不含路径。具体通知 URL 由每笔订单指定。"}><input name="allowed_origin" type="url" required={notificationEnabled} defaultValue={settings.notifications.allowed_origin ?? ""} placeholder="https://shop.example.com" /></Field>
        <AdvancedFields collapsed={guided}><div className="form-grid"><NumberField name="timeout_milliseconds" error={fieldErrors.timeout_milliseconds} label="通知超时（毫秒）" value={settings.notifications.timeout_milliseconds} min={1000} max={30000} /><NumberField name="maximum_attempts" error={fieldErrors.maximum_attempts} label="最大尝试次数" value={settings.notifications.maximum_attempts} min={1} max={100} /><NumberField name="retry_base_seconds" error={fieldErrors.retry_base_seconds} label="首次重试间隔（秒）" value={settings.notifications.retry_base_seconds} min={1} max={3600} /><NumberField name="retry_maximum_seconds" error={fieldErrors.retry_maximum_seconds} label="最大重试间隔（秒）" value={settings.notifications.retry_maximum_seconds} min={1} max={86400} /></div></AdvancedFields>
      </fieldset>
      {!guided && <Notice>签名密钥由服务端生成，可在“密钥与安全”中查看。业务方需要验证签名并按通知协议确认接收。</Notice>}
    </>}
    {section === "backup" && <>
      {!guided && <Notice>自动备份保存到服务器的备份挂载目录。请同时保管主密钥卷；只有数据库备份，无法解密实例中的密钥。</Notice>}
      <div className="form-grid"><NumberField name="interval_seconds" error={fieldErrors.interval_seconds} label="备份间隔（秒）" value={settings.backup.interval_seconds} min={3600} max={604800} hint="86400 秒为一天；最少一小时，最多七天。" /><NumberField name="keep_count" error={fieldErrors.keep_count} label="保留备份数量" value={settings.backup.keep_count} min={1} max={365} /></div>
      {!guided && <Link className="text-link" to="/system">查看备份状态</Link>}
    </>}
    {section === "advanced" && <>
      <Notice>这些参数控制新订单的收银台生命周期。已有订单保留原有期限。</Notice>
      <div className="form-grid"><NumberField name="checkout_key_rotation_days" error={fieldErrors.checkout_key_rotation_days} label="收银台密钥轮换（天）" value={settings.advanced.checkout_key_rotation_days} min={1} max={3650} /><NumberField name="checkout_terminal_observation_seconds" error={fieldErrors.checkout_terminal_observation_seconds} label="终态观察期（秒）" value={settings.advanced.checkout_terminal_observation_seconds} min={60} max={604800} hint="收银台结束后继续观察迟到付款的时间窗口。" /></div>
    </>}
    <ErrorNotice error={save.error instanceof SettingsInputError || (save.error instanceof ApiError && Object.keys(save.error.fields).length) ? null : save.error} />
    <div className="form-actions"><Button type="submit" variant="primary" pending={save.isPending} disabled={decoding}>{!guided && <Save size={16} />}{submitLabel}</Button>{secondaryAction}
      <span className={draft.dirty || (guided && savedMessage) ? "field-hint" : "sr-only"} role="status">{draft.dirty ? "有未保存的修改" : guided ? savedMessage : ""}</span>
    </div>
  </fieldset></form>;
  const title = guided && (section === "provider" || section === "collection") ? undefined : sections.find(([value]) => value === section)?.[1] ?? "设置";
  return <>
    {section === "provider" && !guided && <ApplicationKey settings={settings} onSaved={onSaved} />}
    <Panel {...(title ? { title } : {})} className="content-panel">
      {guided && section === "backup" ? <>
        <p>{backupInterval(settings.backup.interval_seconds)}备份，保留 {settings.backup.keep_count} 份。</p>
        <details className="form-disclosure onboarding-backup"><summary>调整备份策略</summary>{editor}</details>
        <p className="field-hint">恢复需同时保留数据库备份和主密钥。</p>
      </> : editor}
    </Panel>
  </>;
}

export function ApplicationKey({ settings, onSaved, guided = false }: { settings: RuntimeSettings; onSaved: (settings: RuntimeSettings, message?: string) => void; guided?: boolean }) {
  const { requestDiscard } = useDraftGuard();
  const generate = useMutation({ mutationFn: () => result(api.generateProviderApplicationKey({ body: { revision: settings.revision } })), onSuccess: ({ data }) => onSaved(data.settings, "应用密钥已准备好。请复制应用公钥并上传到支付宝开放平台。") });
  return <Panel {...(guided ? {} : { title: "应用公钥" })} className="content-panel">
    {settings.application_public_key ? <>{guided && <p className="field-hint">应用公钥</p>}<CopyValue value={settings.application_public_key} label="复制应用公钥" /></> : <Button variant="primary" pending={generate.isPending} onClick={() => requestDiscard(() => generate.mutate())}>{!guided && <KeyRound size={16} />}生成应用密钥</Button>}
    <ErrorNotice error={generate.error} />
  </Panel>;
}

async function saveSettings(section: ConfigurationSection, form: FormData, settings: RuntimeSettings): Promise<RuntimeSettings> {
  const revision = settings.revision;
  const text = (key: string) => String(form.get(key) ?? "").trim();
  const integer = (key: string) => { const value = Number(text(key)); if (!Number.isSafeInteger(value)) throw new Error("数值设置必须是有效整数。"); return value; };
  if (section === "collection") {
    const code = text("code_payload");
    const error = collectionCodeError(code);
    if (error) throw new SettingsInputError("code_payload", error);
    return (await result(api.updateCollectionSettings({ body: { revision, code_payload: code, order_ttl_seconds: integer("order_ttl_seconds"), amount_offset_maximum_cents: integer("amount_offset_maximum_cents") } }))).data;
  }
  if (section === "provider") {
    const normalInterval = integer("scan_interval_seconds");
    const activeInterval = integer("active_scan_interval_seconds");
    const maximumSuccessAge = integer("maximum_success_age_seconds");
    if (activeInterval > normalInterval) throw new SettingsInputError("active_scan_interval_seconds", "活跃采集间隔不能大于常规采集间隔。");
    if (maximumSuccessAge < normalInterval * 2) throw new SettingsInputError("maximum_success_age_seconds", "采集有效时限须至少为常规采集间隔的两倍。");
    return (await result(api.updateProviderSettings({ body: {
      revision, environment: text("environment") === "SANDBOX" ? "SANDBOX" : "PRODUCTION",
      app_id: text("app_id"), timeout_milliseconds: integer("timeout_milliseconds"),
      scan_interval_seconds: normalInterval, active_scan_interval_seconds: activeInterval,
      safety_lag_seconds: integer("safety_lag_seconds"), maximum_success_age_seconds: maximumSuccessAge,
      ...(text("private_key") ? { private_key: text("private_key") } : {}),
      ...(text("platform_public_key") ? { platform_public_key: text("platform_public_key") } : {}),
    } }))).data;
  }
  if (section === "notifications") {
    const enabled = form.has("enabled");
    const notificationNumber = (key: "timeout_milliseconds" | "maximum_attempts" | "retry_base_seconds" | "retry_maximum_seconds") => form.has(key) ? integer(key) : settings.notifications[key];
    return (await result(api.updateNotificationSettings({ body: { revision, enabled, ...(enabled ? { allowed_origin: text("allowed_origin") } : {}), timeout_milliseconds: notificationNumber("timeout_milliseconds"), maximum_attempts: notificationNumber("maximum_attempts"), retry_base_seconds: notificationNumber("retry_base_seconds"), retry_maximum_seconds: notificationNumber("retry_maximum_seconds") } }))).data;
  }
  if (section === "backup") return (await result(api.updateBackupSettings({ body: { revision, interval_seconds: integer("interval_seconds"), keep_count: integer("keep_count") } }))).data;
  return (await result(api.updateAdvancedSettings({ body: { revision, checkout_key_rotation_days: integer("checkout_key_rotation_days"), checkout_terminal_observation_seconds: integer("checkout_terminal_observation_seconds") } }))).data;
}
