import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, ChevronDown, Eye, KeyRound, RefreshCw } from "lucide-react";
import { Navigate, useParams } from "react-router";

import { api, queryClient, refreshOperationalData, result, type RuntimeSettings, type SystemStatus } from "../api/client";
import { ApplicationKey, SettingsEditor } from "../components/SettingsForms";
import { Button, CopyValue, ErrorNotice, Notice, PageHeading, Panel, QueryView } from "../components/ui";
import { useDraftGuard } from "../drafts";
import { nextRequiredStep, onboardingPath, onboardingSteps, resolveOnboardingStep, type OnboardingStep } from "../lib/onboarding";
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
    <PageHeading title="首次收款配置" description="按顺序完成配置，再检查是否已经可以收款。已保存的内容可以随时继续。" actions={<Button pending={settings.isFetching} onClick={reload}><RefreshCw size={16} />重新读取配置</Button>} />
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
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { setExpanded(false); heading.current?.focus({ preventScroll: true }); }, [step]);
  const deferredState = { deferOnboardingFor: instanceId };
  function saved(data: RuntimeSettings, next?: OnboardingStep) {
    queryClient.setQueryData(["settings"], { data });
    setMessage("配置已保存。");
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
      <header className="onboarding-heading"><h2 tabIndex={-1} ref={heading}>{onboardingSteps[index]!.title}</h2><p>{onboardingSteps[index]!.description}。</p></header>
      {message && <span className="sr-only" role="status">{message}</span>}
      {step === "application" && <>
        <p className="onboarding-instruction"><strong>还没有经营码？</strong>打开支付宝，搜索“经营码”，按页面提示申请并保存二维码。申请资格与开通结果以支付宝页面为准。</p>
        <Notice>准备一个支付宝开放平台应用、可调用“账务明细查询”接口的权限，以及对应收款账户的经营码。并非所有账户或应用都具备这些权限，请先在官方平台确认。</Notice>
        <p className="onboarding-instruction">先在这里生成密钥。下一步把<strong>应用公钥</strong>交给支付宝；应用私钥由 PerPay 保管，不需要手动复制。</p>
        <ApplicationKey settings={settings} onSaved={(data) => saved(data)} />
        <div className="form-actions"><Button variant="primary" disabled={!settings.completion.application_key} onClick={() => { void navigate(onboardingPath("provider")); }}>下一步：配置支付宝<ArrowRight size={16} /></Button><a className="text-link" href="https://open.alipay.com/develop/manage" target="_blank" rel="noreferrer">打开支付宝应用管理</a></div>
        <p className="field-hint">已有应用私钥？<Link to="/settings/provider" state={deferredState}>切换到常规设置导入</Link>，不要为同一应用随意更换密钥。</p>
      </>}
      {step === "provider" && <>
        <ol className="onboarding-instructions">
          <li>打开<a href="https://open.alipay.com/develop/manage" target="_blank" rel="noreferrer">支付宝应用管理</a>，在“网页／移动应用”中创建或选择应用，记下 App ID，并确认有账务明细查询权限。</li>
          <li>进入“开发设置 → 接口加签方式”，点击“设置”，选择<strong>密钥（普通适用）</strong>，不是证书方式。</li>
          <li>在“生成密钥文件”页直接点“下一步”：PerPay 已经生成密钥，无需再用平台工具生成另一套。</li>
          <li>在“上传”页粘贴下面的<strong>应用公钥</strong>，确认上传；完成后复制<strong>支付宝公钥</strong>，与同一应用的 App ID 一起填入下面的表单。</li>
        </ol>
        {settings.application_public_key && <details className="form-disclosure"><summary>查看并复制应用公钥</summary><CopyValue value={settings.application_public_key} label="复制应用公钥" /></details>}
        <Notice>应用公钥是交给支付宝的；支付宝公钥是从平台取回、用于验证返回数据的。保存只完成配置，是否真正接通将在最后一步检查。</Notice>
        <details className="form-disclosure"><summary>需要填写支付宝“应用网关”吗？</summary><p>当前 PerPay 通过查询账务明细确认收款，不使用支付宝应用网关接收异步通知，因此无需填写。它不是 PerPay 部署域名设置，也不是业务网站接收 PerPay 通知的地址。平台菜单可能变化，以实际页面为准。</p></details>
        <SettingsEditor key="provider" section="provider" settings={settings} guided submitLabel="保存并继续" onSaved={(data) => saved(data, "collection")} />
      </>}
      {step === "collection" && <>
        <p className="field-hint">尚未申请经营码？在支付宝搜索“经营码”，按页面提示申请，开通后保存二维码图片。</p>
        <Notice>上传刚才接入的支付宝账户所对应的经营码。识别只提取内容，不验证收款方身份；请核对后保存。</Notice>
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
    <Notice>网站 API 密钥用于让业务网站调用 PerPay，与前两步的支付宝应用密钥不同。只保存在业务网站后端的环境变量或密钥管理器中，不要嵌入网页、移动端或公开仓库。</Notice>
    <Panel title="网站 API 凭证" className="content-panel">
      <p className="field-hint">客户端 ID</p><CopyValue value="default" label="复制 API 客户端 ID" />
      {settings.completion.api ? <><p>API 密钥已生成，不需要再次生成或轮换。</p><Button onClick={() => setReveal(true)}><Eye size={16} />安全查看网站 API 密钥</Button></> : <Button variant="primary" onClick={() => setGenerate(true)}><KeyRound size={16} />生成 API 密钥</Button>}
    </Panel>
    <div className="form-actions"><Button variant="primary" disabled={!settings.completion.api} onClick={onContinue}>密钥已妥善保存，下一步<ArrowRight size={16} /></Button></div>
    {generate && <RotateKeyDialog settings={settings} onSaved={onSaved} onClose={() => setGenerate(false)} onStored={onContinue} />}
    {reveal && <SecretDialog name="api_secret" title="网站 API 密钥" onClose={() => setReveal(false)} />}
  </>;
}

function OptionalSettings({ settings, onSaved }: { settings: RuntimeSettings; onSaved: (settings: RuntimeSettings) => void }) {
  const [reveal, setReveal] = useState(false);
  return <>
    <Notice>这一步可以跳过。业务通知告诉网站哪些订单已付款；未启用时，业务方需要主动查询订单状态。</Notice>
    <Link className="text-link" to={onboardingPath("check")}>跳过，保留当前设置</Link>
    <SettingsEditor key="notifications" section="notifications" settings={settings} guided submitLabel="保存业务通知" onSaved={onSaved} />
    {settings.notifications.enabled && <div><p className="field-hint">业务通知已启用。将通知签名密钥保存在业务网站后端，接收通知时验证签名，并按协议确认接收。</p><Button onClick={() => setReveal(true)}><Eye size={16} />安全查看通知签名密钥</Button></div>}
    <SettingsEditor key="backup" section="backup" settings={settings} guided submitLabel="保存备份策略" onSaved={onSaved} />
    <p className="field-hint">保存备份策略不等于已经验证可恢复。请保管服务器上的主密钥卷，并在上线前验证备份。</p>
    <div className="form-actions"><Link className="button button--primary" to={onboardingPath("check")}>继续：检查收款就绪<ArrowRight size={16} /></Link></div>
    {reveal && <SecretDialog name="webhook_secret" title="通知签名密钥" onClose={() => setReveal(false)} />}
  </>;
}

function useVisibleCheck() {
  const [view, setView] = useState({ active: !document.hidden && navigator.onLine, epoch: 0 });
  useEffect(() => {
    const update = () => setView((previous) => ({ active: !document.hidden && navigator.onLine, epoch: previous.epoch + 1 }));
    document.addEventListener("visibilitychange", update);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { document.removeEventListener("visibilitychange", update); window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  return view;
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
    {!view.active && <Notice tone="warning">页面已隐藏或网络已断开，检查已暂停。回到页面并恢复网络后会重新确认，不沿用旧的就绪结果。</Notice>}
    <ErrorNotice error={query.error} retry={() => { void query.refetch(); }} />
    {fresh && !matches && <Notice tone="warning">配置版本已经变化，请重新读取配置后检查。<Button onClick={onReload}>重新读取配置</Button></Notice>}
    {ready ? <Notice tone={status?.status === "degraded" ? "warning" : "success"}>{status?.status === "degraded" ? "收款入口已就绪，但仍有运行告警需要关注。" : "收款已就绪，可以开始接入业务网站。"}</Notice> : <Notice>配置保存后，还需首次账本采集与自动确认准备完成。这里会每 5 秒检查一次，不会自动创建订单或发起支付。</Notice>}
    <Panel title="收款链路检查" className="content-panel">
      <ul className="onboarding-checks">
        <CheckRow title="核心配置" status={health(settings.completion.complete && status?.configured, "尚未完成配置")} action={<Link to={onboardingPath(nextRequiredStep(settings) === "check" ? "provider" : nextRequiredStep(settings))}>查看配置</Link>} />
        <CheckRow title="数据库" status={health(status?.database.ok, "数据库暂不可用")} action={<Link to="/system">查看运行状态</Link>} />
        <CheckRow title="账本采集" status={health(status?.ledger.collection_ready, "等待成功采集")} error={fresh && matches ? status?.ledger.last_error_code : null} action={<Link to={onboardingPath("provider")}>检查支付宝接入</Link>} />
        <CheckRow title="自动确认" status={health(status?.reconciliation.confirmation_ready, "等待自动确认就绪")} error={fresh && matches ? status?.reconciliation.last_error_code : null} action={<Link to="/system">查看运行状态</Link>} />
      </ul>
    </Panel>
    <div className="form-actions"><Button pending={query.isFetching} disabled={!view.active} onClick={() => { void query.refetch(); }}><RefreshCw size={16} />重新检查</Button>{ready && <><Link className="button button--primary" to="/">进入控制台</Link><Link className="button" to="/test-payment">小额真实测试</Link></>}</div>
    {!settings.notifications.enabled && <p className="field-hint">业务通知未启用，业务网站需要主动查询订单状态。</p>}
    <p className="field-hint">小额测试不是模拟支付：只有你主动创建订单并付款，资金才会进入配置的支付宝账户。就绪检查不验证经营码的收款方身份。</p>
  </>;
}

function CheckRow({ title, status, error, action }: { title: string; status: string; error?: SystemStatus["ledger"]["last_error_code"] | undefined; action: ReactNode }) {
  return <li><div><strong>{title}</strong><span className="field-hint" role="status">{status}</span>{error && <span className="field-error">最近错误：{error}</span>}</div>{action}</li>;
}
