import { ArrowRight, Info, Settings2 } from "lucide-react";
import { useSearchParams } from "react-router";
import type { ListSiteOverviewResponse } from "@/api/client";
import { useSiteOverview } from "@/hooks/use-site-overview";
import { count, money } from "@/lib/format";
import { siteChoiceLabel } from "@/lib/site-choice-label";
import { Link } from "@/navigation";
import { BusinessTable, type BusinessColumn } from "@/components/business-table";
import { ListIdentity, ListSummary, ListSummaryField } from "@/components/list-primitives";
import { ErrorNotice } from "@/components/request-state";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type SiteOverview = ListSiteOverviewResponse["data"][number];

export function SiteManagementCards() {
  const [search, setSearch] = useSearchParams();
  const selected = Number(search.get("range"));
  const range = selected === 7 || selected === 90 ? selected : 30;
  const { query, sites, latest, pending, refresh, loadMore } = useSiteOverview(range, 30);
  const choices = sites.map(site => ({ client_id: site.client_id, configuration: { name: site.name } }));
  const columns: BusinessColumn<SiteOverview>[] = [
    { id: "name", label: "名称", hideable: false, layout: "identity", cell: site => {
      const label = siteChoiceLabel({ client_id: site.client_id, configuration: { name: site.name } }, choices);
      return <Link data-row-link to={"/sites/" + encodeURIComponent(site.client_id) + "/summary?range=" + range} title={label} aria-label={label}>{label}</Link>;
    } },
    { id: "status", label: "状态", layout: "status", summaryDefault: true, cell: site => <Badge variant={site.accepting_orders ? "success" : "warning"}>{site.accepting_orders ? "接单中" : "暂停接单"}</Badge> },
    { id: "received", label: "近 " + range + " 天实收", layout: "amount", summaryDefault: true, summaryLabel: true, cell: site => money(site.confirmed_amount_cents) },
    { id: "work", label: "待处理", layout: "number", summaryDefault: true, summaryLabel: true, cell: site => site.work_items ? <Badge variant="warning">{count(site.work_items)}</Badge> : "0" },
    { id: "actions", label: "操作", layout: "actions", hideable: false, cell: site => <div className="flex items-center justify-end gap-1">
      <Link to={"/sites/" + encodeURIComponent(site.client_id) + "/settings/basic"} className={buttonVariants({ variant: "ghost", size: "icon-sm" })} aria-label={"网站设置：" + site.name} title="网站设置"><Settings2 /></Link>
      <Link to={"/sites/" + encodeURIComponent(site.client_id) + "?range=" + range} className={buttonVariants({ variant: "outline", size: "sm", className: "h-auto min-h-8 whitespace-normal" })}>查看网站总览<ArrowRight data-icon="inline-end" /></Link>
    </div> },
  ];
  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label="网站经营概况" aria-busy={pending}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 max-w-full items-center gap-2">
          <ToggleGroup value={[String(range)]} onValueChange={values => {
            const value = values[0];
            if (!value || !["7", "30", "90"].includes(value)) return;
            const next = new URLSearchParams(search); next.set("range", value); setSearch(next, { replace: true });
          }} variant="outline" size="sm" spacing={0} aria-label="经营统计周期" className="min-w-0 max-w-full overflow-x-auto">
            {[7, 30, 90].map(days => <ToggleGroupItem key={days} value={String(days)} className="shrink-0 whitespace-nowrap">近 {days} 天</ToggleGroupItem>)}
          </ToggleGroup>
          <Popover>
            <PopoverTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="网站经营指标说明" />}><Info /></PopoverTrigger>
            <PopoverContent align="start" className="flex flex-col gap-2">
              <p>实收按北京时间的确认时间统计，未扣退款和费用；今天尚未结束。</p>
              {latest && <p>统计区间：<time dateTime={latest.period.from}>{latest.period.from}</time> 至 <time dateTime={latest.period.to}>{latest.period.to}</time>。</p>}
              <p>待处理为当前数量。打开网站概况可查看确认笔数、待付款和通知状态。</p>
            </PopoverContent>
          </Popover>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/sites/defaults" className={buttonVariants({ variant: "outline", size: "sm" })}>默认模板</Link>
          <Link to="/sites/new" className={buttonVariants({ size: "sm" })}>创建业务网站</Link>
        </div>
      </div>
      {pending ? <div role="status" aria-label="正在读取网站经营概况…" className="flex flex-col gap-3">
        {[0, 1, 2].map(row => <Skeleton key={row} className="h-10 w-full" />)}
      </div> : query.data === undefined ? <ErrorNotice scope="page" error={query.error} retry={refresh} /> : <>
        {!query.isFetchNextPageError && <ErrorNotice scope="page" error={query.error} retry={refresh} />}
        {sites.length ? <BusinessTable id="sites" items={sites} columns={columns} rowId={site => site.client_id} density="compact" columnsMenu={false} aria-label="网站列表"
          renderSummary={(site, context) => <div className="w-full min-w-0" data-management-summary="site">
            <ListSummary identity={<ListIdentity>{columns[0]!.cell(site, context)}</ListIdentity>} aside={columns[4]!.cell(site, context)}>
              {columns.slice(1, 4).map(column => <ListSummaryField key={column.id} label={column.label} visibleLabel={column.summaryLabel}>
                {column.cell(site, context)}
              </ListSummaryField>)}
            </ListSummary>
          </div>}
        /> : <Empty><EmptyHeader><EmptyTitle>暂无网站</EmptyTitle></EmptyHeader></Empty>}
        {query.isFetchNextPageError ? <ErrorNotice scope="page" error={query.error} retry={loadMore} /> : query.hasNextPage && <Button className="self-start" variant="outline" disabled={query.isFetching} onClick={loadMore}>
          {query.isFetchingNextPage && <Spinner data-icon="inline-start" aria-hidden="true" />}{query.isFetchingNextPage ? "正在加载更多网站…" : "加载更多网站"}
        </Button>}
      </>}
    </section>
  );
}
