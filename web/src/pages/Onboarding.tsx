import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react";
import { Navigate, useParams } from "react-router";

import { api, queryClient, refreshOperationalData, result, type RuntimeSettings, type SystemStatus } from "../api/client";
import { ApplicationKey, SettingsEditor } from "../components/SettingsForms";
import { Button, CopyValue, ErrorNotice, Notice, PageHeading, Panel, QueryView } from "../components/ui";
import { useDraftGuard } from "../drafts";
import { nextRequiredStep, onboardingPath, onboardingSteps, resolveOnboardingStep, type OnboardingStep } from "../lib/onboarding";
import { useVisibleCheck } from "../lib/use-visible-check";
import { Link, useNavigate } from "../navigation";
import { RotateKeyDialog, SecretDialog } from "./SecuritySettings";

export default function Onboarding() {
  const [editorVersion, setEditorVersion] = useState(0);
  const { requestDiscard } = useDraftGuard();
  const settings = useQuery({ queryKey: ["settings"], queryFn: ({ signal }) => result(api.getRuntimeSettings({ signal })), staleTime: Infinity, refetchOnMount: "always", refetchOnWindowFocus: false, refetchOnReconnect: false });
  const instance = useQuery({ queryKey: ["onboarding", "instance"], queryFn: ({ signal }) => result(api.getAdministratorSystemStatus({ signal })), staleTime: Infinity, refetchOnWindowFocus: false });
  function reload() {
    requestDiscard(() => { void settings.refetch().then((response) => { if (!response.isError) setEditorVersion((value) => value + 1); }); });
  }
  return <>
    <PageHeading title="首次收款配置" actions={<><a className="text-link" href="https://github.com/Mashiro0619/PerPay/blob/main/docs/alipay-setup.md" target="_blank" rel="noreferrer">图文教程</a><Button variant="quiet" pending={settings.isFetching} onClick={reload}>重新读取</Button></>} />
    <ErrorNotice error={instance.error} retry={() => { void instance.refetch(); }} />
    <QueryView query={settings}>{({ data }) => <OnboardingFlow key={editorVersion} settings={data} instanceId={instance.data?.data.instance_id ?? null} onReload={reload} />}</QueryView>
  </>;
}

function OnboardingFlow({ settings, instanceId, onReload }: { settings: RuntimeSettings; instanceId: string | null; onReload: () => void }) {
  const { step: requested } = useParams();
  const step = resolveOnboardingStep(settings, requested);
  const index = onboardingSteps.findIndex((item) => item.id === step);
  const firstMissing = onboardingSteps.findIndex((item) => item.id === nextRequiredStep(settings));
  const navigate = useNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setExpanded(false); heading.current?.focus({ preventScroll: true }); }, [step]);
  const deferredState = { deferOnboardingFor: instanceId };
  function saved(data: RuntimeSettings, next?: OnboardingStep) {
    queryClient.setQueryData(["settings"], { data });
    void refreshOperationalData();
    if (next) void navigate(onboardingPath(next));
  }
  if (requested !== step) return <Navigate to={onboardingPath(step)} replace />;
  const completed = [settings.completion.application_key, settings.completion.provider, settings.completion.collection, settings.completion.api];
  return <div className="onboarding-layout">
    <nav className={"onboarding-steps" + (expanded ? " is-expanded" : "")} aria-label="配置步骤">
      <p className="onboarding-progress">第 {index + 1} 步，共 6 步</p>
      <button type="button" className="onboarding-step-toggle" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(!expanded)}>查看全部步骤<ChevronDown size={16} aria-hidden="true" /></button>
      <ol id={listId}>{onboardingSteps.map((item, position) => <li key={item.id}>
        {position <= firstMissing ? <Link to={onboardingPath(item.id)} className={step === item.id ? "is-current" : ""} aria-current={step === item.id ? "step" : undefined}>
          <span className="onboarding-step-number" aria-hidden="true">{completed[position] ? <Check size={15} /> : position + 1}</span><span>{item.title}{position === 4 && <small>可跳过</small>}{completed[position] && <span className="sr-only">，已配置</span>}</span>
        </Link> : <span className="onboarding-step-locked" aria-disabled="true"><span className="onboarding-step-number" aria-hidden="true">{position + 1}</span><span>{item.title}{position === 4 && <small>可跳过</small>}</span></span>}
      </li>)}</ol>
    </nav>
    <div className="onboarding-content">
      <header className="onboarding-heading"><h2 tabIndex={-1} ref={heading}>{onboardingSteps[index]!.title}</h2></header>
      {step === "application" && <>
        <p className="field-hint">公钥交给支付宝，私钥由 PerPay 保管。</p>
        <ApplicationKey settings={settings} guided onSaved={(data) => saved(data)} />
        <details className="form-disclosure"><summary>接入前准备</summary><ul className="onboarding-instructions">
          <li>支付宝应用需有账务明细查询权限，申请资格以支付宝为准。</li>
          <li>支付宝搜索“经营码”申请，使用同一账户收款。</li>
        </ul></details>
        <div className="form-actions"><Button variant="primary" disabled={!settings.completion.application_key} onClick={() => { void navigate(onboardingPath("provider")); }}>下一步</Button><Link className="text-link" to="/settings/provider" state={deferredState}>导入已有密钥</Link></div>
      </>}
      {step === "provider" && <>
        <ol className="onboarding-instructions">
          <li>在<a href="https://open.alipay.com/develop/manage" target="_blank" rel="noreferrer">支付宝应用管理</a>上传应用公钥，选择密钥加签。</li>
          <li>将平台返回的 App ID 和<strong>支付宝公钥</strong>填到下方。</li>
        </ol>
        {settings.application_public_key && <details className="form-disclosure"><summary>查看应用公钥</summary><CopyValue value={settings.application_public_key} label="复制应用公钥" /></details>}
        <SettingsEditor key="provider" section="provider" settings={settings} guided submitLabel="保存并继续" onSaved={(data) => saved(data, "collection")} />
      </>}
      {step === "collection" && <>
        <p className="field-hint">上传接入账户的经营码，核对识别结果后保存。</p>
        <SettingsEditor key="collection" section="collection" settings={settings} guided submitLabel="保存并继续" onSaved={(data) => saved(data, "api")} />
      </>}
      {step === "api" && <ApiKeyStep settings={settings} onSaved={(data) => saved(data)} onContinue={() => { void navigate(onboardingPath("optional")); }} />}
      {step === "optional" && <OptionalSettings settings={settings} onSaved={(data) => saved(data)} />}
      {step === "check" && <ReadinessCheck settings={settings} instanceId={instanceId} onReload={onReload} />}
      <footer className="onboarding-footer">
        {index > 0 && <Link className="button" to={onboardingPath(onboardingSteps[index - 1]!.id)}>上一步</Link>}
        {instanceId && <><Link to="/" state={deferredState} className="text-link">稍后配置</Link><Link to="/settings" state={deferredState} className="text-link">切换到常规设置</Link></>}
      </footer>
    </div>
  </div>;
}

function ApiKeyStep({ settings, onSaved, onContinue }: { settings: RuntimeSettings; onSaved: (settings: RuntimeSettings) => void; onContinue: () => void }) {
  const [generate, setGenerate] = useState(false);
  const [reveal, setReveal] = useState(false);
  return <>
    <p className="field-hint">供业务网站后端调用 PerPay，与支付宝应用密钥不同。</p>
    <Panel className="content-panel onboarding-key">
      {settings.completion.api ? <><p>API 密钥已配置</p><Button onClick={() => setReveal(true)}>查看密钥</Button></> : <Button variant="primary" onClick={() => setGenerate(true)}>生成 API 密钥</Button>}
      <details className="form-disclosure"><summary>客户端 ID</summary><CopyValue value="default" label="复制 API 客户端 ID" /></details>
    </Panel>
    <div className="form-actions"><Button variant="primary" disabled={!settings.completion.api} onClick={onContinue}>已保存，下一步</Button></div>
    {generate && <RotateKeyDialog settings={settings} onSaved={onSaved} onClose={() => setGenerate(false)} onStored={onContinue} />}
    {reveal && <SecretDialog name="api_secret" title="网站 API 密钥" onClose={() => setReveal(false)} />}
  </>;
}

function OptionalSettings({ settings, onSaved }: { settings: RuntimeSettings; onSaved: (settings: RuntimeSettings) => void }) {
  const [reveal, setReveal] = useState(false);
  return <>
    <SettingsEditor key="notifications" section="notifications" settings={settings} guided submitLabel="保存通知" onSaved={onSaved}
      secondaryAction={settings.notifications.enabled && <Button onClick={() => setReveal(true)}>查看签名密钥</Button>} />
    <SettingsEditor key="backup" section="backup" settings={settings} guided submitLabel="保存备份" onSaved={onSaved} />
    <div className="form-actions"><Link className="button button--primary" to={onboardingPath("check")}>继续</Link></div>
    {reveal && <SecretDialog name="webhook_secret" title="通知签名密钥" onClose={() => setReveal(false)} />}
  </>;
}

export function ReadinessCheck({ settings, instanceId, onReload }: { settings: RuntimeSettings; instanceId: string | null; onReload: () => void }) {
  const view = useVisibleCheck();
  const query = useQuery({
    queryKey: ["onboarding", "readiness", instanceId, settings.revision, settings.payment_revision, view.epoch],
    queryFn: ({ signal }) => result(api.getAdministratorSystemStatus({ signal })),
    enabled: view.active && instanceId !== null, staleTime: 0, gcTime: 0, retry: false,
    refetchOnMount: "always", refetchOnWindowFocus: false, refetchOnReconnect: false,
    refetchInterval: view.active ? 5000 : false, refetchIntervalInBackground: false,
  });
  const status = query.data?.data;
  const fresh = view.active && query.isFetchedAfterMount && !query.isFetching && !query.isError && !query.isPaused && status?.instance_id === instanceId;
  const matches = status?.settings_revision === settings.revision && status?.payment_revision === settings.payment_revision;
  const ready = Boolean(fresh && matches && settings.completion.complete && status?.configured && status.database.ok && status.ledger.collection_ready && status.reconciliation.confirmation_ready && status.status !== "not_ready");
  function health(value: boolean | undefined, pending: string) { return fresh && matches ? value ? "已通过" : pending : "待检查"; }
  return <>
    {!view.active && <p role="status">检查已暂停，返回页面并恢复网络后继续。</p>}
    <ErrorNotice error={query.error} retry={() => { void query.refetch(); }} />
    {fresh && !matches && <Notice tone="warning">配置已变化，请重新读取。<Button onClick={onReload}>重新读取配置</Button></Notice>}
    {ready ? <p role="status">{status?.status === "degraded" ? "可以收款，仍有事项待处理。" : "收款已就绪。"}</p> : view.active && !query.isError && (!fresh || matches) && <p className="field-hint" role="status">等待下方检查通过，自动刷新。</p>}
    <Panel className="content-panel">
      <ul className="onboarding-checks">
        <CheckRow title="核心配置" status={health(settings.completion.complete && status?.configured, "尚未完成配置")} action={fresh && matches && (!settings.completion.complete || !status?.configured) && <Link to={onboardingPath(nextRequiredStep(settings) === "check" ? "provider" : nextRequiredStep(settings))}>查看配置</Link>} />
        <CheckRow title="数据库" status={health(status?.database.ok, "数据库暂不可用")} />
        <CheckRow title="账本采集" status={health(status?.ledger.collection_ready, "等待成功采集")} error={fresh && matches ? status?.ledger.last_error_code : null} action={fresh && matches && !status?.ledger.collection_ready && <Link to={onboardingPath("provider")}>检查支付宝接入</Link>} />
        <CheckRow title="自动确认" status={health(status?.reconciliation.confirmation_ready, "等待自动确认就绪")} error={fresh && matches ? status?.reconciliation.last_error_code : null} />
      </ul>
    </Panel>
    <div className="form-actions">
      {ready && <><Link className="button button--primary" to="/">进入控制台</Link><Link className="button" to="/test-payment">小额真实测试</Link></>}
      <Button pending={query.isFetching} disabled={!view.active} onClick={() => { void query.refetch(); }}>重新检查</Button>
      {(!ready || status?.status === "degraded") && <Link className="text-link" to="/system">运行状态</Link>}
    </div>
    {!settings.notifications.enabled && <p className="field-hint">业务通知未启用，请由网站主动查单。</p>}
  </>;
}

function CheckRow({ title, status, error, action }: { title: string; status: string; error?: SystemStatus["ledger"]["last_error_code"] | undefined; action?: ReactNode }) {
  return <li><div><strong>{title}</strong><span className="field-hint" role="status">{status}</span>{error && <span className="field-error">最近错误：{error}</span>}</div>{action}</li>;
}
