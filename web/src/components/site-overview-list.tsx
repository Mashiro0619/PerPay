import { useId, useState } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { ArrowRight, ChevronRight, Info } from "lucide-react";
import type { ListSiteOverviewResponse } from "@/api/client";
import { Link } from "@/navigation";
import { useSiteOverview } from "@/hooks/use-site-overview";
import { count, money } from "@/lib/format";
import { siteChoiceLabel } from "@/lib/site-choice-label";
import { ErrorNotice, ReadPausedNotice } from "@/components/request-state";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";
import { SiteAmountBar } from "@/components/site-amount-bar";
import {
  SelectionMotionGroup,
  SelectionMotionIndicator,
} from "@/components/selection-motion";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type SiteOverview = ListSiteOverviewResponse["data"][number];
type SiteRankSort = "amount" | "work_items";

const sortChoices: ReadonlyArray<{ value: SiteRankSort; label: string }> = [
  { value: "amount", label: "按实收" },
  { value: "work_items", label: "按待处理" },
];

function formatShare(amount: number, total: number | undefined): string | null {
  if (total === undefined || total <= 0 || amount <= 0) return null;
  const percentage = (amount / total) * 100;
  if (percentage < 1) return "<1%";
  if (percentage > 99 && amount < total) return ">99%";
  return Math.round(percentage) + "%";
}

function SiteOverviewCard({
  site,
  label,
  range,
  maximum,
  totalAmount,
  rank,
  sortBy,
}: {
  site: SiteOverview;
  label: string;
  range: 7 | 30 | 90;
  maximum: number;
  totalAmount: number | undefined;
  rank: number;
  sortBy: SiteRankSort;
}) {
  const summaryId = useId();
  const amount = money(site.confirmed_amount_cents);
  const nameSuffix = label === site.name ? undefined : label.slice(site.name.length + 3);
  const shareLabel = formatShare(site.confirmed_amount_cents, totalAmount);
  const orderCount = count(site.confirmed_count) + " 笔";
  const statsText = shareLabel ? orderCount + " · " + shareLabel : orderCount;
  const topRank = rank <= 3 && (sortBy === "work_items" ? site.work_items > 0 : site.confirmed_amount_cents > 0);

  return (
    <>
      <Link
        className="site-overview-card relative"
        data-slot="site-overview-card"
        data-accepting-orders={site.accepting_orders}
        data-zero={site.confirmed_amount_cents === 0 || undefined}
        data-top-rank={topRank || undefined}
        to={"/sites/" + encodeURIComponent(site.client_id) + "?range=" + range}
        aria-describedby={summaryId}
      >
        <span className="sr-only">{label + "，查看网站总览"}</span>
        <div className="site-overview-card-surface" aria-hidden="true">
          <span className="site-overview-rank">
            {String(rank).padStart(2, "0")}
          </span>
          <div className="site-overview-card-body">
            <div className="site-overview-row-head">
              <div className="site-overview-row-identity">
                <div className="site-overview-title-line">
                  <span
                    className="site-overview-card-title"
                    title={label}
                  >
                    {site.name}
                  </span>
                  {!site.accepting_orders && (
                    <Badge variant="outline" className="site-overview-paused-badge">
                      暂停接单
                    </Badge>
                  )}
                </div>
                {nameSuffix && (
                  <span className="site-overview-card-suffix break-all text-xs text-muted-foreground">
                    {nameSuffix}
                  </span>
                )}
              </div>
              <div className="site-overview-row-amount">
                <div
                  className="site-overview-card-amount"
                  data-wide={amount.length > 14 || undefined}
                >
                  {amount}
                </div>
                <ChevronRight className="site-overview-row-chevron" aria-hidden="true" />
              </div>
            </div>
            <div className="site-overview-row-meta">
              <span className="site-overview-row-stats">{statsText}</span>
              {site.work_items > 0 && (
                <Badge variant="warning" className="site-overview-work-indicator">
                  <span className="site-overview-work-dot" aria-hidden="true" />
                  待处理 {count(site.work_items)}
                </Badge>
              )}
            </div>
            <SiteAmountBar amount={site.confirmed_amount_cents} maximum={maximum} />
          </div>
        </div>
      </Link>
      <span id={summaryId} className="sr-only">
        {site.accepting_orders ? "" : "暂停接单。"}
        近 {range} 天实收 {amount}
        {site.confirmed_count > 0 ? "，" + orderCount : ""}
        {shareLabel ? "，占比 " + shareLabel : ""}。
        {site.work_items > 0 ? "待处理 " + count(site.work_items) + " 项。" : ""}
      </span>
    </>
  );
}

function SiteOverviewSkeletons() {
  return (
    <div className="site-overview-surface" role="status" aria-label="正在读取网站概览…">
      <ul className="site-overview-grid" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <li key={index} className="min-w-0">
            <div className="site-overview-card-surface">
              <Skeleton className="mt-0.5 h-3.5 w-4 rounded-sm" />
              <div className="site-overview-card-body">
                <div className="flex items-center justify-between gap-3">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-4 w-20" />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <Skeleton className="h-3.5 w-16" />
                  <Skeleton className="h-3.5 w-12" />
                </div>
                <Skeleton className="h-1 w-full rounded-full" />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SiteOverviewList({ range }: { range: 7 | 30 | 90 }) {
  const headingId = useId();
  const mobile = useIsMobile();
  const [expanded, setExpanded] = useState(false);
  const [sortBy, setSortBy] = useState<SiteRankSort>("amount");
  const { query, sites, latest, pending, refresh, loadMore } = useSiteOverview(range, 10, sortBy);

  if (!pending && query.isSuccess && query.hasNextPage === false && sites.length === 1) return null;

  const choices = sites.map((site) => ({
    client_id: site.client_id,
    configuration: { name: site.name },
  }));
  const totalSites = latest?.total_sites ?? (query.hasNextPage === false && sites.length > 0 ? sites.length : undefined);
  const visibleSites = mobile && !expanded ? sites.slice(0, 4) : sites;

  return (
    <section
      className="site-overview-section"
      aria-labelledby={headingId}
      aria-busy={pending}
    >
      <Card className="site-overview-panel">
        <CardHeader className="site-overview-panel-header">
          <div className="site-overview-identity">
            <div className="site-overview-panel-title-group">
              <CardTitle id={headingId} role="heading" aria-level={2}>
                各网站概览
              </CardTitle>
              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="overview-kpi-info-trigger"
                      aria-label="网站指标说明"
                    />
                  }
                >
                  <Info aria-hidden="true" />
                </PopoverTrigger>
                <PopoverContent align="start" className="flex flex-col gap-2">
                  <p>实收按北京时间的确认时间统计，未扣退款和费用；包含尚未结束的今天。</p>
                  {latest && (
                    <p>
                      统计区间：<time dateTime={latest.period.from}>{latest.period.from}</time> 至{" "}
                      <time dateTime={latest.period.to}>{latest.period.to}</time>。
                    </p>
                  )}
                  <p>横条以全站本期最高实收为基准，占比按全站本期实收合计计算，均含暂停接单网站且不受分页影响。</p>
                </PopoverContent>
              </Popover>
            </div>
            <CardDescription className="site-overview-panel-subtitle">
              <span>近 {range} 天实收</span>
              {totalSites != null && (
                <span className="site-overview-panel-count">共 {count(totalSites)} 个</span>
              )}
            </CardDescription>
          </div>
          <SelectionMotionGroup>
            <ToggleGroup
              value={[sortBy]}
              onValueChange={(value) => {
                if (value[0] === "amount" || value[0] === "work_items") {
                  setSortBy(value[0]);
                }
              }}
              spacing={1}
              size="sm"
              aria-label="网站排序方式"
              className="site-overview-sort"
              data-selection-motion="fill"
            >
              {sortChoices.map((choice) => (
                <ToggleGroupItem key={choice.value} value={choice.value}>
                  <SelectionMotionIndicator active={sortBy === choice.value} />
                  {choice.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </SelectionMotionGroup>
        </CardHeader>
        <CardContent className="site-overview-panel-content">
          {pending ? query.isPaused ? <ReadPausedNotice /> : <SiteOverviewSkeletons /> : query.data === undefined ? (
            <ErrorNotice scope="page" error={query.error} retry={refresh} />
          ) : (
            <div className="site-overview-panel-body">
              {query.isPaused ? <ReadPausedNotice retainedData /> : !query.isFetchNextPageError && <ErrorNotice scope="page" error={query.error} retry={refresh} retainedData />}
              {sites.length ? (
                <div className="site-overview-surface">
                  <ul className="site-overview-grid" aria-label="各网站概览">
                    {visibleSites.map((site, index) => (
                      <li key={site.client_id} className="relative min-w-0">
                        <SiteOverviewCard
                          site={site}
                          range={range}
                          maximum={latest!.max_confirmed_amount_cents}
                          totalAmount={latest?.total_confirmed_amount_cents}
                          rank={index + 1}
                          sortBy={sortBy}
                          label={siteChoiceLabel({ client_id: site.client_id, configuration: { name: site.name } }, choices)}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <Empty>
                  <EmptyHeader><EmptyTitle>暂无网站</EmptyTitle></EmptyHeader>
                </Empty>
              )}
              {mobile && (sites.length > 4 || query.hasNextPage) && (
                <div className="site-overview-mobile-toggle">
                  <Button
                    className="w-full"
                    variant="outline"
                    size="sm"
                    onClick={() => setExpanded(!expanded)}
                  >
                    {expanded ? "收起网站概览" : "查看全部网站"}
                  </Button>
                </div>
              )}
              {query.isFetchNextPageError && (
                <ErrorNotice scope="page" error={query.error} retry={loadMore} />
              )}
            </div>
          )}
          <div className="site-overview-footer">
            <div className="site-overview-footer-left">
              {!pending && query.data !== undefined && !query.isFetchNextPageError && query.hasNextPage && (!mobile || expanded) ? (
                <>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={query.isFetching}
                    onClick={loadMore}
                  >
                    {query.isFetchingNextPage && <Spinner data-icon="inline-start" aria-hidden="true" />}
                    {query.isFetchingNextPage ? "正在加载…" : "加载更多网站汇总"}
                  </Button>
                  {totalSites != null && totalSites > sites.length && (
                    <span className="site-overview-footer-count">
                      {count(sites.length)} / {count(totalSites)}
                    </span>
                  )}
                </>
              ) : (
                <span className="site-overview-footer-count">
                  按{sortBy === "work_items" ? "待处理" : "实收"}排序
                </span>
              )}
            </div>
            <Link
              to="/sites"
              className={buttonVariants({
                variant: "ghost",
                size: "xs",
                className: "site-overview-manage-link",
              })}
            >
              网站管理
              <ArrowRight data-icon="inline-end" />
            </Link>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
