import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, Check, RefreshCw } from "lucide-react";
import { Navigate, useLocation, useSearchParams } from "react-router";

import { Link } from "../navigation";

import { api, refreshOperationalData, result, type RuntimeSettings, type SystemStatus } from "../api/client";
import { TestPaymentLink } from "../App";
import { OrderTable } from "../components/OrderTable";
import { DailyChart } from "../components/DailyChart";
import { SelectionIndicator } from "../components/SelectionIndicator";
import { WorkItemList } from "../components/WorkItemList";
import { Button, ErrorNotice, Notice, PageHeading, Panel, QueryView } from "../components/ui";
import { useVisibleCheck } from "../lib/use-visible-check";
import { count, money } from "../lib/format";
import { deferredInstance, isOnboardingDeferred, onboardingPath } from "../lib/onboarding";

export default function Dashboard() {
  const location = useLocation();
  const view = useVisibleCheck();
  const [search, setSearch] = useSearchParams();
  const selectedRange = Number(search.get("range"));
  const range = selectedRange === 7 || selectedRange === 90 ? selectedRange : 30;
  const analytics = useQuery({ queryKey: ["analytics", range], queryFn: ({ signal }) => result(api.getAdministratorSystemAnalytics({ query: { range }, signal })), placeholderData: keepPreviousData, refetchInterval: 60_000 });
  const settings = useQuery({ queryKey: ["settings"], queryFn: ({ signal }) => result(api.getRuntimeSettings({ signal })), refetchOnWindowFocus: false });
  const instance = useQuery({ queryKey: ["dashboard", "status", view.epoch], queryFn: ({ signal }) => result(api.getAdministratorSystemStatus({ signal })), enabled: view.active, staleTime: 0, gcTime: 0, retry: false, refetchOnMount: "always", refetchOnWindowFocus: false, refetchOnReconnect: false, refetchInterval: view.active ? 30_000 : false, refetchIntervalInBackground: false });
  const orders = useQuery({ queryKey: ["orders", "recent"], queryFn: ({ signal }) => result(api.listAdministratorOrders({ query: { limit: 5 }, signal })) });
  const work = useQuery({ queryKey: ["work-items", "recent"], queryFn: ({ signal }) => result(api.listAdministratorWorkItems({ query: { limit: 4 }, signal })) });

  const instanceId = instance.data?.data.instance_id;
  if (settings.data && !settings.isError && !settings.data.data.completion.complete && instanceId && deferredInstance(location.state) !== instanceId && !isOnboardingDeferred(instanceId)) return <Navigate to={onboardingPath()} replace />;
  return <>
    <PageHeading title="收款概览" actions={<><Button pending={analytics.isFetching} onClick={() => { void refreshOperationalData(); }}><RefreshCw size={16} />刷新</Button><TestPaymentLink /></>} />
    {settings.data && !settings.data.data.completion.complete && <SetupProgress settings={settings.data.data} />}
    {settings.error && <ErrorNotice error={settings.error} />}
    <PaymentHealth status={instance.data?.data} checking={instance.isFetching || instance.isPending} unavailable={!view.active || instance.isError || instance.isPaused} fresh={instance.isFetchedAfterMount} retry={() => { void instance.refetch(); }} />
    <QueryView query={analytics}>{({ data }) => <>
      <div className="section-toolbar"><div><h2>收款数据</h2><span className="muted" aria-live="polite" aria-atomic="true">{analytics.isPlaceholderData ? `正在读取近 ${range} 天，当前显示近 ${data.range_days} 天数据` : `${data.daily[0]?.date} 至 ${data.daily.at(-1)?.date} · 北京时间自然日`}</span></div>
        <div className="segmented" role="group" aria-label="统计周期"><SelectionIndicator active={range} />{([7, 30, 90] as const).map((days) => <button key={days} type="button" aria-pressed={range === days} onClick={() => setSearch({ range: String(days) }, { replace: true })}>近 {days} 天</button>)}</div>
      </div>
      <div className="metrics-row" aria-busy={analytics.isPlaceholderData}>
        <div className="metric"><span>付款确认金额</span><strong className="metric-money">{money(data.confirmations.amount_cents)}</strong><small>非净结算收入</small></div>
        <div className="metric"><span>新建订单</span><strong>{count(data.orders.created)}<small>笔</small></strong></div>
        <div className="metric"><span>付款确认</span><strong>{count(data.confirmations.count)}<small>次</small></strong></div>
        <div className="metric"><span>待付款订单</span><strong>{count(data.pending.orders)}<small>笔</small></strong><small>当前收银台开放且未付款</small></div>
      </div>
      <div className="dashboard-grid" aria-busy={analytics.isPlaceholderData}>
        <Panel title="每日收款与订单" className="chart-panel"><DailyChart analytics={data} /></Panel>
        <Panel title="需要你关注" action={<Link className="text-link" to="/work-items">查看全部<ArrowUpRight size={15} /></Link>}><QueryView query={work}>{(page) => <WorkItemList items={page.data} headingLevel={3} />}</QueryView></Panel>
      </div>
    </>}</QueryView>
    <Panel title="最近订单" action={<Link className="text-link" to="/orders">全部订单<ArrowRight size={15} /></Link>}>
      <QueryView query={orders}>{(page) => <OrderTable orders={page.data} compact />}</QueryView>
    </Panel>
  </>;
}

function PaymentHealth({ status, checking, unavailable, fresh, retry }: { status: SystemStatus | undefined; checking: boolean; unavailable: boolean; fresh: boolean; retry: () => void }) {
  if (unavailable) return <Notice tone="warning" title="暂时无法确认收款状态"><p>状态读取失败或网络已断开，请重新检查。</p><Button pending={checking} onClick={retry}>重新检查</Button> <Link to="/system">查看运行状态</Link></Notice>;
  if (checking || !fresh || !status) return <Notice>正在检查收款状态…</Notice>;
  const blocked = status.status === "not_ready" || !status.configured || !status.database.ok || !status.ledger.collection_ready || !status.reconciliation.confirmation_ready;
  if (blocked) {
    const reason = !status.configured ? "收款配置尚未完成。" : !status.database.ok ? "数据库暂不可用。" : !status.ledger.collection_ready ? "账本采集尚未就绪或已中断，请检查支付宝接入。" : !status.reconciliation.confirmation_ready ? "自动确认尚未就绪，请检查对账运行状态。" : "服务尚未就绪。";
    return <Notice tone="danger" title="当前暂停新收款"><p>{reason}</p><Link to="/system">查看运行状态</Link></Notice>;
  }
  return status.status === "degraded" ? <Notice tone="warning" title="可以收款，但有运行告警"><Link to="/system">查看告警与处理建议</Link></Notice> : null;
}

function SetupProgress({ settings }: { settings: RuntimeSettings }) {
  const steps = [
    [settings.completion.application_key, "生成应用密钥", "/settings/provider"],
    [settings.completion.provider, "配置支付宝", "/settings/provider"],
    [settings.completion.collection, "设置经营码", "/settings/collection"],
    [settings.completion.api, "生成 API 密钥", "/settings/security"],
  ] as const;
  return <section className="setup-progress"><div><h2>完成配置，开始收款</h2><p>跟随向导完成收款配置，再检查首次采集与自动确认是否就绪。</p><Link className="button button--primary" to={onboardingPath()}>继续配置<ArrowRight size={16} /></Link></div>
    <ol>{steps.map(([complete, title, to], index) => <li key={title} data-complete={complete}><Link to={to}><span>{complete ? <Check size={13} /> : index + 1}</span>{title}</Link></li>)}</ol>
  </section>;
}
