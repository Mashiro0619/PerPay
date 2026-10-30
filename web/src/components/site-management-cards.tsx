import { useId } from "react";
import { ArrowRight, Bell, BellOff, CircleCheck, CirclePause, Info, Settings2 } from "lucide-react";
import { useSearchParams } from "react-router";
import type { ListSiteOverviewResponse } from "@/api/client";
import { useSiteOverview } from "@/hooks/use-site-overview";
import { count, money } from "@/lib/format";
import { siteChoiceLabel } from "@/lib/site-choice-label";
import { Link } from "@/navigation";
import { SiteAmountBar } from "@/components/site-amount-bar";
import { ErrorNotice } from "@/components/request-state";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type SiteOverview = ListSiteOverviewResponse["data"][number];

function SiteManagementCard({ site, label, range, maximum }: {
  site: SiteOverview;
  label: string;
  range: 7 | 30 | 90;
  maximum: number;
}) {
  const headingId = useId();
  const suffix = label === site.name ? undefined : label.slice(site.name.length + 3);
  const amount = money(site.confirmed_amount_cents);
  const sitePath = "/sites/" + encodeURIComponent(site.client_id);
  const overviewPath = sitePath + "?range=" + range;
  const OrdersIcon = site.accepting_orders ? CircleCheck : CirclePause;
  const NotificationsIcon = site.notifications_enabled ? Bell : BellOff;
  return (
    <article aria-labelledby={headingId} className="site-management-card">
      <Card size="sm" className="site-management-card-surface">
        <CardHeader>
          <CardTitle id={headingId} role="heading" aria-level={2} className="site-management-card-title">
            <Link to={overviewPath} title={label} aria-label={label}>{site.name}</Link>
          </CardTitle>
          {suffix && <CardDescription className="max-w-full break-all">{suffix}</CardDescription>}
          <div className="flex flex-wrap gap-2">
            <Badge variant={site.accepting_orders ? "success" : "warning"}>
              <OrdersIcon data-icon="inline-start" aria-hidden="true" />
              {site.accepting_orders ? "接单中" : "暂停接单"}
            </Badge>
            <Badge variant={site.notifications_enabled ? "success" : "secondary"}>
              <NotificationsIcon data-icon="inline-start" aria-hidden="true" />
              {site.notifications_enabled ? "通知开启" : "通知关闭"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <CardDescription>近 {range} 天实收</CardDescription>
            <div className="site-overview-card-amount" data-wide={amount.length > 14 || undefined}>{amount}</div>
          </div>
          <SiteAmountBar amount={site.confirmed_amount_cents} maximum={maximum} />
          <dl className="site-management-metrics">
            <div><dt>收款确认笔数</dt><dd>{count(site.confirmed_count)}</dd></div>
            <div><dt>当前待付款</dt><dd>{count(site.pending_orders)}</dd></div>
            <div>
              <dt>待处理</dt>
              <dd>{site.work_items > 0 ? <Badge variant="warning">{count(site.work_items)}</Badge> : "0"}</dd>
            </div>
          </dl>
        </CardContent>
        <CardFooter className="mt-auto flex-wrap justify-between gap-2">
          <Link to={sitePath + "/settings/basic"} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            <Settings2 data-icon="inline-start" />网站设置
          </Link>
          <Link to={overviewPath} className={buttonVariants({ variant: "outline", size: "sm" })}>
            进入后台<ArrowRight data-icon="inline-end" />
          </Link>
        </CardFooter>
      </Card>
    </article>
  );
}

function SiteManagementSkeletons() {
  return (
    <div role="status" aria-label="正在读取网站经营概况…">
      <ul className="site-management-grid" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <li key={index}>
            <Card size="sm" className="site-management-card-surface">
              <CardHeader><Skeleton className="h-5 w-2/3" /><Skeleton className="h-5 w-1/2" /></CardHeader>
              <CardContent className="flex min-w-0 flex-col gap-3">
                <Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-3/4" />
                <Skeleton className="h-1 w-full" /><Skeleton className="h-10 w-full" />
              </CardContent>
              <CardFooter className="mt-auto flex-wrap justify-between gap-2"><Skeleton className="h-8 w-24" /><Skeleton className="h-8 w-24" /></CardFooter>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SiteManagementCards() {
  const [search, setSearch] = useSearchParams();
  const selected = Number(search.get("range"));
  const range = selected === 7 || selected === 90 ? selected : 30;
  const { query, sites, latest, pending, refresh, loadMore } = useSiteOverview(range, 30);
  const choices = sites.map((site) => ({ client_id: site.client_id, configuration: { name: site.name } }));
  return (
    <section className="site-management-section" aria-label="网站经营概况" aria-busy={pending}>
      <div className="site-management-toolbar">
        <div className="flex min-w-0 max-w-full items-center gap-2">
          <ToggleGroup
            value={[String(range)]}
            onValueChange={(values) => {
              const value = values[0];
              if (!value || !["7", "30", "90"].includes(value)) return;
              const next = new URLSearchParams(search);
              next.set("range", value);
              setSearch(next, { replace: true });
            }}
            variant="outline" size="sm" spacing={0} aria-label="经营统计周期"
            className="site-management-periods min-w-0 max-w-full items-stretch"
          >
            {[7, 30, 90].map((days) => <ToggleGroupItem key={days} value={String(days)} className="site-management-period h-auto min-h-7">近 {days} 天</ToggleGroupItem>)}
          </ToggleGroup>
          <Popover>
            <PopoverTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="网站经营指标说明" />}><Info /></PopoverTrigger>
            <PopoverContent align="start" className="flex flex-col gap-2">
              <p>实收与确认笔数按北京时间的 PerPay 确认时间统计，未扣退款和费用；今天尚未结束。</p>
              {latest && <p>统计区间：<time dateTime={latest.period.from}>{latest.period.from}</time> 至 <time dateTime={latest.period.to}>{latest.period.to}</time>。</p>}
              <p>横条以全站本期最高实收为基准，含暂停接单网站，不受分页影响。待付款与待处理为当前数量。</p>
            </PopoverContent>
          </Popover>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/sites/defaults" className={buttonVariants({ variant: "outline" })}>默认模板</Link>
          <Link to="/sites/new" className={buttonVariants()}>创建业务网站</Link>
        </div>
      </div>
      {pending ? <SiteManagementSkeletons /> : query.data === undefined ? (
        <ErrorNotice error={query.error} retry={refresh} />
      ) : (
        <>
          {!query.isFetchNextPageError && <ErrorNotice error={query.error} retry={refresh} />}
          {sites.length ? (
            <ul className="site-management-grid" aria-label="网站列表">
              {sites.map((site) => (
                <li key={site.client_id}>
                  <SiteManagementCard
                    site={site} range={range} maximum={latest!.max_confirmed_amount_cents}
                    label={siteChoiceLabel({ client_id: site.client_id, configuration: { name: site.name } }, choices)}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <Empty>
              <EmptyHeader><EmptyTitle>暂无网站</EmptyTitle></EmptyHeader>
            </Empty>
          )}
          {query.isFetchNextPageError ? <ErrorNotice error={query.error} retry={loadMore} /> : query.hasNextPage && (
            <Button className="self-start" variant="outline" disabled={query.isFetching} onClick={loadMore}>
              {query.isFetchingNextPage && <Spinner data-icon="inline-start" aria-hidden="true" />}
              {query.isFetchingNextPage ? "正在加载更多网站…" : "加载更多网站"}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
