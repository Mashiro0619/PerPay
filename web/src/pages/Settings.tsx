import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, KeyRound, RefreshCw, Save } from "lucide-react";
import { useParams } from "react-router";

import { Link } from "../navigation";
import { SelectionIndicator } from "../components/SelectionIndicator";
import { CollectionCodeField } from "../components/CollectionCodeField";

import { api, queryClient, refreshOperationalData, result, type RuntimeSettings } from "../api/client";
import { Button, CopyValue, ErrorNotice, Field, Notice, PageHeading, Panel, QueryView } from "../components/ui";
import { useDraftGuard, useFormDraft } from "../drafts";
import { SecuritySettings } from "./SecuritySettings";

type ConfigurationSection = "provider" | "collection" | "notifications" | "backup" | "advanced";
const sections = [["provider", "支付宝接入"], ["collection", "经营码与订单"], ["notifications", "业务通知"], ["security", "密钥与安全"], ["backup", "自动备份"], ["advanced", "高级设置"]] as const;

export default function Settings() {
  const { section: requestedSection } = useParams();
  const [success, setSuccess] = useState<string | null>(null);
  const [editorVersion, setEditorVersion] = useState(0);
  const { requestDiscard } = useDraftGuard();
  const settings = useQuery({ queryKey: ["settings"], queryFn: ({ signal }) => result(api.getRuntimeSettings({ signal })), staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false });
  function saved(data: RuntimeSettings, message = "配置已保存。收款链路可能需要短暂时间切换到新配置。") {
    queryClient.setQueryData(["settings"], { data });
    setSuccess(message);
    void refreshOperationalData();
  }
  return <><PageHeading title="实例设置" actions={<Button pending={settings.isFetching} onClick={() => requestDiscard(() => {
    void settings.refetch().then((response) => { if (!response.isError) { setEditorVersion((value) => value + 1); setSuccess(null); } });
  })}><RefreshCw size={16} />重新读取</Button>} />
    {success && <Notice tone="success">{success}</Notice>}
    <QueryView query={settings}>{({ data }) => {
      const section = sections.find(([value]) => value === requestedSection)?.[0] ?? (data.completion.complete ? "collection" : "provider");
      return <div className="settings-layout"><nav className="settings-nav" aria-label="设置分类"><SelectionIndicator active={section} />{sections.map(([value, title]) => <Link key={value} to={`/settings/${value}`} className={section === value ? "is-active" : ""} aria-current={section === value ? "page" : undefined} onClick={() => setSuccess(null)}>{title}{((value === "provider" && data.completion.provider) || (value === "collection" && data.completion.collection)) && <Check size={14} aria-label="已配置" />}</Link>)}</nav>
        <div className="settings-content">{section === "security" ? <SecuritySettings key={`security:${editorVersion}`} settings={data} onSaved={saved} /> : <SettingsEditor key={`${section}:${data.revision}:${editorVersion}`} section={section} settings={data} onSaved={saved} />}</div>
      </div>;
    }}</QueryView>
  </>;
}

function NumberField({ name, label, value, min, max, hint }: { name: string; label: string; value: number; min: number; max: number; hint?: string }) {
  return <Field label={label} hint={hint}><input name={name} type="number" inputMode="numeric" min={min} max={max} step={1} required defaultValue={value} /></Field>;
}

function SettingsEditor({ section, settings, onSaved }: { section: ConfigurationSection; settings: RuntimeSettings; onSaved: (settings: RuntimeSettings, message?: string) => void }) {
  const draft = useFormDraft();
  const [decoding, setDecoding] = useState(false);
  const [notificationEnabled, setNotificationEnabled] = useState(settings.notifications.enabled);
  const save = useMutation({ mutationFn: (form: FormData) => saveSettings(section, form, settings.revision), onSuccess: (data) => onSaved(data) });
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!decoding && !save.isPending) save.mutate(new FormData(event.currentTarget)); }
  return <>
    {section === "provider" && <ApplicationKey settings={settings} onSaved={onSaved} />}
    <Panel title={sections.find(([value]) => value === section)?.[1] ?? "设置"} className="content-panel">
      <form ref={draft.form} className="form-stack" onSubmit={submit} onChange={draft.onChange} autoComplete="off"><fieldset disabled={save.isPending}>
        {section === "provider" && <>
          <Notice>先生成应用密钥，并将应用公钥上传至支付宝开放平台；再填写平台返回的支付宝公钥。两种公钥不能混用。</Notice>
          <div className="form-grid"><Field label="支付宝环境"><select name="environment" defaultValue={settings.provider?.environment ?? "PRODUCTION"}><option value="PRODUCTION">生产环境</option><option value="SANDBOX">沙箱环境</option></select></Field>
            <Field label="应用 ID（App ID）"><input name="app_id" required maxLength={64} pattern="[A-Za-z0-9._-]+" defaultValue={settings.provider?.app_id ?? ""} autoComplete="off" placeholder="支付宝开放平台的应用 ID" /></Field></div>
          <Field label="支付宝公钥" hint={settings.secrets.provider_public_key.configured ? "已配置；留空保留当前公钥，填写内容才会替换。" : "填写支付宝平台公钥，不是上一步生成的应用公钥。"}><textarea name="platform_public_key" rows={4} required={!settings.secrets.provider_public_key.configured} maxLength={16384} autoComplete="off" spellCheck={false} placeholder="粘贴支付宝公钥（Base64 或 PEM）" /></Field>
          <details className="form-disclosure"><summary>导入已有应用私钥（可选）</summary><Field label="应用私钥" hint="留空使用已生成的私钥。替换密钥前，请确认支付宝平台中的应用公钥已同步。"><textarea name="private_key" rows={4} maxLength={16384} autoComplete="off" spellCheck={false} /></Field></details>
          <div className="form-grid"><NumberField name="timeout_milliseconds" label="请求超时（毫秒）" value={settings.provider?.timeout_milliseconds ?? 8000} min={1000} max={120000} /><NumberField name="scan_interval_seconds" label="账本采集间隔（秒）" value={settings.provider?.scan_interval_seconds ?? 10} min={5} max={3600} />
            <NumberField name="safety_lag_seconds" label="安全延迟（秒）" value={settings.provider?.safety_lag_seconds ?? 10} min={5} max={300} hint="避开支付宝尚未稳定返回的最新账单。" /><NumberField name="maximum_success_age_seconds" label="采集有效时限（秒）" value={settings.provider?.maximum_success_age_seconds ?? 60} min={10} max={86400} hint="超过此时限未成功采集，会暂停新订单收款入口。" /></div>
        </>}
        {section === "collection" && <>
          <CollectionCodeField defaultValue={settings.collection?.code_payload ?? ""} onDecoded={draft.onChange} onPendingChange={setDecoding} />
          <div className="form-grid"><NumberField name="order_ttl_seconds" label="收银台有效期（秒）" value={settings.collection?.order_ttl_seconds ?? 300} min={60} max={1800} /><NumberField name="amount_offset_maximum_cents" label="最大金额尾差（分）" value={settings.collection?.amount_offset_maximum_cents ?? 99} min={1} max={99} hint="为订单分配唯一应付金额；付款人必须支付收银台显示的准确金额。" /></div>
          <Notice>经营码或支付宝账户变更会影响后续收款。已有订单仍保留其创建时的配置与账务证据。</Notice>
        </>}
        {section === "notifications" && <>
          <label className="checkbox-field"><input name="enabled" type="checkbox" checked={notificationEnabled} onChange={(event) => setNotificationEnabled(event.target.checked)} /><span>启用业务通知</span></label>
          <Field label="允许的通知网站 Origin" hint="只填写 HTTPS 协议、域名和可选端口，例如 https://shop.example.com，不含路径。具体通知 URL 由每笔订单指定。"><input name="allowed_origin" type="url" required={notificationEnabled} defaultValue={settings.notifications.allowed_origin ?? ""} placeholder="https://shop.example.com" /></Field>
          <div className="form-grid"><NumberField name="timeout_milliseconds" label="通知超时（毫秒）" value={settings.notifications.timeout_milliseconds} min={1000} max={30000} /><NumberField name="maximum_attempts" label="最大尝试次数" value={settings.notifications.maximum_attempts} min={1} max={100} /><NumberField name="retry_base_seconds" label="首次重试间隔（秒）" value={settings.notifications.retry_base_seconds} min={1} max={3600} /><NumberField name="retry_maximum_seconds" label="最大重试间隔（秒）" value={settings.notifications.retry_maximum_seconds} min={1} max={86400} /></div>
          <Notice>签名密钥由服务端生成，可在“密钥与安全”中查看。业务方需要验证签名并按通知协议确认接收。</Notice>
        </>}
        {section === "backup" && <>
          <Notice>自动备份保存到服务器的备份挂载目录。请同时保管主密钥卷；只有数据库备份，无法解密实例中的密钥。</Notice>
          <div className="form-grid"><NumberField name="interval_seconds" label="备份间隔（秒）" value={settings.backup.interval_seconds} min={3600} max={604800} hint="86400 秒为一天；最少一小时，最多七天。" /><NumberField name="keep_count" label="保留备份数量" value={settings.backup.keep_count} min={1} max={365} /></div>
          <Link className="text-link" to="/system">查看备份状态</Link>
        </>}
        {section === "advanced" && <>
          <Notice>这些参数控制新订单的收银台生命周期。已有订单保留原有期限。</Notice>
          <div className="form-grid"><NumberField name="checkout_key_rotation_days" label="收银台密钥轮换（天）" value={settings.advanced.checkout_key_rotation_days} min={1} max={3650} /><NumberField name="checkout_terminal_observation_seconds" label="终态观察期（秒）" value={settings.advanced.checkout_terminal_observation_seconds} min={60} max={604800} hint="收银台结束后继续观察迟到付款的时间窗口。" /></div>
        </>}
        <ErrorNotice error={save.error} />
        <div className="form-actions"><Button type="submit" variant="primary" pending={save.isPending} disabled={decoding}><Save size={16} />保存配置</Button><span className={draft.dirty ? "field-hint" : "sr-only"} role="status">{draft.dirty ? "有未保存的修改" : ""}</span></div>
      </fieldset></form>
    </Panel>
  </>;
}

function ApplicationKey({ settings, onSaved }: { settings: RuntimeSettings; onSaved: (settings: RuntimeSettings, message?: string) => void }) {
  const { requestDiscard } = useDraftGuard();
  const generate = useMutation({ mutationFn: () => result(api.generateProviderApplicationKey({ body: { revision: settings.revision } })), onSuccess: ({ data }) => onSaved(data.settings, "应用密钥已准备好。请复制应用公钥并上传到支付宝开放平台。") });
  return <Panel title="应用公钥" className="content-panel">
    {settings.application_public_key ? <CopyValue value={settings.application_public_key} label="复制应用公钥" /> : <Button variant="primary" pending={generate.isPending} onClick={() => requestDiscard(() => generate.mutate())}><KeyRound size={16} />生成应用密钥</Button>}
    <ErrorNotice error={generate.error} />
  </Panel>;
}

async function saveSettings(section: ConfigurationSection, form: FormData, revision: number): Promise<RuntimeSettings> {
  const text = (key: string) => String(form.get(key) ?? "").trim();
  const integer = (key: string) => { const value = Number(text(key)); if (!Number.isSafeInteger(value)) throw new Error("数值设置必须是有效整数。"); return value; };
  if (section === "collection") {
    const code = text("code_payload");
    if (new TextEncoder().encode(code).length > 2331) throw new Error("经营码内容不能超过 2331 个 UTF-8 字节。");
    return (await result(api.updateCollectionSettings({ body: { revision, code_payload: code, order_ttl_seconds: integer("order_ttl_seconds"), amount_offset_maximum_cents: integer("amount_offset_maximum_cents") } }))).data;
  }
  if (section === "provider") return (await result(api.updateProviderSettings({ body: { revision, environment: text("environment") === "SANDBOX" ? "SANDBOX" : "PRODUCTION", app_id: text("app_id"), timeout_milliseconds: integer("timeout_milliseconds"), scan_interval_seconds: integer("scan_interval_seconds"), safety_lag_seconds: integer("safety_lag_seconds"), maximum_success_age_seconds: integer("maximum_success_age_seconds"), ...(text("private_key") ? { private_key: text("private_key") } : {}), ...(text("platform_public_key") ? { platform_public_key: text("platform_public_key") } : {}) } }))).data;
  if (section === "notifications") {
    const enabled = form.has("enabled");
    return (await result(api.updateNotificationSettings({ body: { revision, enabled, ...(enabled ? { allowed_origin: text("allowed_origin") } : {}), timeout_milliseconds: integer("timeout_milliseconds"), maximum_attempts: integer("maximum_attempts"), retry_base_seconds: integer("retry_base_seconds"), retry_maximum_seconds: integer("retry_maximum_seconds") } }))).data;
  }
  if (section === "backup") return (await result(api.updateBackupSettings({ body: { revision, interval_seconds: integer("interval_seconds"), keep_count: integer("keep_count") } }))).data;
  return (await result(api.updateAdvancedSettings({ body: { revision, checkout_key_rotation_days: integer("checkout_key_rotation_days"), checkout_terminal_observation_seconds: integer("checkout_terminal_observation_seconds") } }))).data;
}
