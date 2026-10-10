import { useId } from "react";
import { Info } from "lucide-react";
import type { ListSiteOverviewResponse } from "@/api/client";
import { Link } from "@/navigation";
import { useSiteOverview } from "@/hooks/use-site-overview";
import { count, money } from "@/lib/format";
import { siteChoiceLabel } from "@/lib/site-choice-label";
import { ErrorNotice } from "@/components/request-state";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";
import { SiteAmountBar } from "@/components/site-amount-bar";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

type SiteOverview = ListSiteOverviewResponse["data"][number];

function SiteOverviewCard({ site, label, range, maximum }: {
  site: SiteOverview;
  label: string;
  range: 7 | 30 | 90;
  maximum: number;
}) {
  const summaryId = useId();
  const amount = money(site.confirmed_amount_cents);
  const nameSuffix = label === site.name ? undefined : label.slice(site.name.length + 3);
  return (
    <Link
      className="site-overview-card"
      data-slot="site-overview-card"
      to={"/sites/" + encodeURIComponent(site.client_id) + "?range=" + range}
      aria-label={label + "，进入后台"}
      aria-describedby={summaryId}
    >
      <Card className="site-overview-card-surface">
        <CardHeader className="site-overview-card-heading">
          <div className="flex min-w-0 flex-col items-start gap-1">
            <CardTitle
              className="site-overview-card-title"
              role="heading"
              aria-level={3}
              title={label}
            >
              {site.name}
            </CardTitle>
            {nameSuffix && <CardDescription className="max-w-full break-all">{nameSuffix}</CardDescription>}
          </div>
          {!site.accepting_orders && <CardAction><Badge variant="secondary">暂停接单</Badge></CardAction>}
        </CardHeader>
        <CardContent>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <div
              className="site-overview-card-amount"
              data-wide={amount.length > 14 || undefined}
            >
              {amount}
            </div>
            {site.work_items > 0 && <Badge variant="warning">当前待办 {count(site.work_items)}</Badge>}
          </div>
          <SiteAmountBar amount={site.confirmed_amount_cents} maximum={maximum} />
        </CardContent>
        <span id={summaryId} className="sr-only">
          {site.accepting_orders ? "" : "暂停接单。"}
          近 {range} 天实收 {amount}。
          {site.work_items > 0 ? "当前待办 " + count(site.work_items) + " 项。" : ""}
        </span>
      </Card>
    </Link>
  );
}

function SiteOverviewSkeletons() {
  return (
    <div role="status" aria-label="正在读取网站概览…">
      <ul className="site-overview-grid" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <li key={index} className="min-w-0">
            <Card className="site-overview-card-surface">
              <CardHeader className="site-overview-card-heading">
                <Skeleton className="h-5 w-2/3" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-3/4" />
                <Skeleton className="h-1 w-full" />
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SiteOverviewList({ range }: { range: 7 | 30 | 90 }) {
  const headingId = useId();
  const { query, sites, latest, pending, refresh, loadMore } = useSiteOverview(range);

  if (!pending && query.isSuccess && query.hasNextPage === false && sites.length === 1) return null;

  const choices = sites.map((site) => ({
    client_id: site.client_id,
    configuration: { name: site.name },
  }));
  return (
    <section
      className="site-overview-section flex min-w-0 flex-col gap-4"
      aria-labelledby={headingId}
      aria-busy={pending}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex items-center gap-3">
          <h2 id={headingId} className="text-base font-medium">各网站概览</h2>
          <p className="text-sm text-muted-foreground">近 {range} 天实收</p>
        </div>
        <Popover>
          <PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label="网站指标说明" />}>
            <Info aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent align="start" className="flex flex-col gap-2">
            <p>实收按北京时间内的付款确认时间统计，不扣除退款或费用。区间包含今天，今天尚未结束。</p>
            {latest && <p>统计区间：<time dateTime={latest.period.from}>{latest.period.from}</time> 至 <time dateTime={latest.period.to}>{latest.period.to}</time>。</p>}
            <p>横条以全部网站中本期实收最高者为满格，包含暂停接单的网站，不受这里分页影响。</p>
            <p>待办仅在非零时提示，表示当前需要处理的事项。</p>
          </PopoverContent>
        </Popover>
      </div>
      {pending ? <SiteOverviewSkeletons /> : query.data === undefined ? (
        <ErrorNotice error={query.error} retry={refresh} />
      ) : (
        <>
          {!query.isFetchNextPageError && <ErrorNotice error={query.error} retry={refresh} />}
          {sites.length ? (
            <ul className="site-overview-grid" aria-label="各网站概览">
              {sites.map((site) => (
                <li key={site.client_id} className="min-w-0">
                  <SiteOverviewCard
                    site={site}
                    range={range}
                    maximum={latest!.max_confirmed_amount_cents}
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
          {query.isFetchNextPageError ? (
            <ErrorNotice error={query.error} retry={loadMore} />
          ) : query.hasNextPage && (
            <Button className="self-start" variant="outline" disabled={query.isFetching} onClick={loadMore}>
              {query.isFetchingNextPage && <Spinner data-icon="inline-start" aria-hidden="true" />}
              {query.isFetchingNextPage ? "正在加载更多网站…" : "加载更多网站汇总"}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
