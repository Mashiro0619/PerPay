import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, Check, RefreshCw } from "lucide-react";
import { Navigate, useLocation, useSearchParams } from "react-router";

import { Link } from "../navigation";

import { api, refreshOperationalData, result, type RuntimeSettings } from "../api/client";
import { TestPaymentLink } from "../App";
import { OrderTable } from "../components/OrderTable";
import { DailyChart } from "../components/DailyChart";
import { SelectionIndicator } from "../components/SelectionIndicator";
import { WorkItemList } from "../components/WorkItemList";
import { Button, ErrorNotice, PageHeading, Panel, QueryView } from "../components/ui";
import { count, money } from "../lib/format";
import { deferredInstance, isOnboardingDeferred, onboardingPath } from "../lib/onboarding";

export default function Dashboard() {
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const selectedRange = Number(search.get("range"));
  const range = selectedRange === 7 || selectedRange === 90 ? selectedRange : 30;
  const analytics = useQuery({ queryKey: ["analytics", range], queryFn: ({ signal }) => result(api.getAdministratorSystemAnalytics({ query: { range }, signal })), placeholderData: keepPreviousData, refetchInterval: 60_000 });
  const settings = useQuery({ queryKey: ["settings"], queryFn: ({ signal }) => result(api.getRuntimeSettings({ signal })), refetchOnWindowFocus: false });
  const instance = useQuery({ queryKey: ["onboarding", "instance"], queryFn: ({ signal }) => result(api.getAdministratorSystemStatus({ signal })), enabled: settings.data?.data.completion.complete === false, staleTime: Infinity, refetchOnWindowFocus: false });
  const orders = useQuery({ queryKey: ["orders", "recent"], queryFn: ({ signal }) => result(api.listAdministratorOrders({ query: { limit: 5 }, signal })) });
  const work = useQuery({ queryKey: ["work-items", "recent"], queryFn: ({ signal }) => result(api.listAdministratorWorkItems({ query: { limit: 4 }, signal })) });

  const instanceId = instance.data?.data.instance_id;
  if (settings.data && !settings.isError && !settings.data.data.completion.complete && instanceId && deferredInstance(location.state) !== instanceId && !isOnboardingDeferred(instanceId)) return <Navigate to={onboardingPath()} replace />;
  return <>
    <PageHeading title="收款概览" actions={<><Button pending={analytics.isFetching} onClick={() => { void refreshOperationalData(); }}><RefreshCw size={16} />刷新</Button><TestPaymentLink /></>} />
    {settings.data && !settings.data.data.completion.complete && <SetupProgress settings={settings.data.data} />}
    {settings.error && <ErrorNotice error={settings.error} />}
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
