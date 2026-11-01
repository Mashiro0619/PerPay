import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useState } from "react";
import { useSearchParams } from "react-router";
import type { AuditEventItem } from "../../../src/shared/audit";
import { auditEventsQuery, auditListKey, auditMetadataQuery, AUDIT_FILTER_KEYS, readAuditFilters } from "@/api/audit";
import { AUDIT_VIEWS, auditActionLabel, auditCaptureLabel, auditClientLabel, auditContextUnavailable, auditEventHref, auditViewValues, selectedAuditView } from "@/lib/audit";
import { useListQuery, type ListQueryControl } from "@/lib/list-query";
import { useCursor } from "@/lib/cursor";
import { Link } from "@/navigation";
import { PageHeading } from "@/components/page-heading";
import { PageHeaderActionLink, PageHeaderActions } from "@/components/page-header-actions";
import { ListLayout, ListToolbarPart } from "@/components/list-layout";
import { ListQueryToolbar } from "@/components/list-query-toolbar";
import { ListColumnsProvider } from "@/components/list-columns";
import { BusinessTable, type BusinessColumn } from "@/components/business-table";
import { CursorPagination } from "@/components/cursor-pagination";
import { AuditAddressFilter, AuditDesktopFilters, AuditFilterSelect, auditFilterOptions } from "@/components/audit-filters";
import { AuditActions, AuditExportButton, useAuditExport } from "@/components/audit-export";
import { AuditActor, AuditCaptureNotice, AuditResult, AuditSite, AuditTime } from "@/components/audit-record";
import { CreatedDateFilter } from "@/components/created-date-filter";
import { QueryView, ErrorNotice } from "@/components/request-state";
import { RefreshButton } from "@/components/refresh-button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { buttonVariants } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/admin-empty";

const timeSort = ["occurred_at"] as const;
const noSortChoices: readonly { value: string; label: string }[] = [];
const rowId = (event: AuditEventItem) => `${event.source}:${event.event_id}`;

function EventLink({ event }: { event: AuditEventItem }) {
  return <div className="audit-event-title">
    <Link global data-row-link className="list-primary-link" to={auditEventHref(event)} title={event.action}>{auditActionLabel(event.action)}</Link>
    {event.is_aggregate && <span className="audit-aggregate-count" title="分钟汇总">{event.event_count.toLocaleString("zh-CN")} 次</span>}
  </div>;
}

function AuditSummary({ event, deleted }: { event: AuditEventItem; deleted: boolean }) {
  return <div className="audit-mobile-record">
    <div className="audit-mobile-heading"><EventLink event={event} /><AuditResult {...event} /></div>
    <div className="audit-mobile-meta"><AuditTime value={event.occurred_at} /><AuditActor event={event} /></div>
    <div className="audit-mobile-meta"><AuditSite event={event} deleted={deleted} />{event.source_address && <span className="list-code" title={event.source_address}>{event.source_address}</span>}</div>
  </div>;
}

function revealAuditView(scroller: HTMLDivElement, selected: Element) {
  if (!scroller.clientWidth) return;
  const container = scroller.getBoundingClientRect(), tab = selected.getBoundingClientRect();
  const inset = 4;
  if (tab.left < container.left + inset) scroller.scrollLeft += tab.left - container.left - inset;
  else if (tab.right > container.right - inset) scroller.scrollLeft += tab.right - container.right + inset;
}

export default function Audit() {
  const [search] = useSearchParams();
  const queryClient = useQueryClient();
  const filters = readAuditFilters(search);
  const view = selectedAuditView(filters);
  const [viewScroller, setViewScroller] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const scroller = viewScroller;
    if (!scroller) return;
    const reveal = () => {
      const selected = scroller.querySelector<HTMLElement>('[aria-selected="true"]');
      if (selected) revealAuditView(scroller, selected);
    };
    reveal();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reveal);
    observer?.observe(scroller);
    if (scroller.firstElementChild) observer?.observe(scroller.firstElementChild);
    window.addEventListener("resize", reveal);
    return () => { observer?.disconnect(); window.removeEventListener("resize", reveal); };
  }, [view?.id, viewScroller]);
  const pagination = useCursor();
  const baseControl = useListQuery(timeSort, "occurred_at", "desc", true);
  const update = (values: Record<string, string | null>) => {
    const changes = { ...values };
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (("source" in changes || "category" in changes) && !next.has("source") && !next.has("category")) {
      changes.view = "all";
      next.set("view", "all");
    }
    const nextFilters = readAuditFilters(next);
    if (JSON.stringify(nextFilters) !== JSON.stringify(filters)) {
      // Applying a different filter creates a new snapshot even when that
      // filter was viewed earlier. Browser/detail back keeps its saved page.
      void queryClient.invalidateQueries({ queryKey: auditListKey(nextFilters), refetchType: "none" });
    }
    baseControl.update({ ...changes, sort_by: null, sort_order: null });
  };
  const control: ListQueryControl = {
    ...baseControl,
    query: { ...baseControl.query, sortBy: "occurred_at", sortOrder: "desc" },
    update,
    setKeyword: q => update({ q }),
    setSort: () => undefined,
    clear: () => update({ ...Object.fromEntries(AUDIT_FILTER_KEYS.map(key => [key, null])), ...auditViewValues(view?.id ?? "all") }),
  };
  const metadata = useQuery(auditMetadataQuery());
  const events = useQuery(auditEventsQuery(filters, pagination.cursor));
  const exporting = useAuditExport(filters);
  const filterOptions = auditFilterOptions(filters, metadata.data?.data).map(filter => ({
    ...filter,
    ...((filter.key === "source" || filter.key === "category") && view ? { defaultValue: view[filter.key] ?? "" } : {}),
  }));
  const deletedSites = new Set(metadata.data?.data.sites.filter(site => site.deleted).map(site => site.site_id) ?? []);
  const deleted = (event: AuditEventItem) => !!event.site_id && deletedSites.has(event.site_id);
  const captureLabel = metadata.error ? "采集状态暂不可用" : auditCaptureLabel(metadata.data?.data.capture);
  const statusHref = "/audit/status" + (events.data ? "?snapshot_at=" + encodeURIComponent(events.data.page.snapshot_at) : "");

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: auditListKey(filters), refetchType: "none" });
    if (pagination.cursor) control.update({});
    else void events.refetch();
    void metadata.refetch();
  }
  const refreshing = events.isFetching || metadata.isFetching;
  const columns: BusinessColumn<AuditEventItem>[] = [
    { id: "occurred_at", label: "时间", layout: "datetime", cell: event => <AuditTime value={event.occurred_at} /> },
    { id: "identity", label: "事件", layout: "identity", hideable: false, cell: event => <EventLink event={event} /> },
    { id: "actor", label: "执行者", layout: "text", cell: event => <AuditActor event={event} /> },
    { id: "site", label: "网站", layout: "text", cell: event => <AuditSite event={event} deleted={deleted(event)} /> },
    { id: "source_address", label: "IP", layout: "text", cell: event => <span className="list-code" title={event.source_address ?? undefined}>{event.source_address ?? auditContextUnavailable(event)}</span> },
    { id: "client", label: "客户端", layout: "text", cell: event => <span title={event.user_agent ?? undefined}>{auditClientLabel(event)}</span> },
    { id: "outcome", label: "结果", layout: "status", cell: event => <AuditResult {...event} /> },
    { id: "details", label: "详情", layout: "actions", hideable: false, cell: event => <Link global to={auditEventHref(event)} tabIndex={-1} className="list-secondary-link" aria-label={"查看" + auditActionLabel(event.action) + "详情"}>详情</Link> },
    { id: "http_method", label: "方法", layout: "text", defaultVisible: false, cell: event => event.http_method ?? auditContextUnavailable(event) },
    { id: "route", label: "路由", layout: "text", defaultVisible: false, cell: event => <span className="list-code" title={event.route ?? undefined}>{event.route ?? auditContextUnavailable(event)}</span> },
    { id: "http_status", label: "HTTP 状态", layout: "number", defaultVisible: false, cell: event => event.http_status ?? auditContextUnavailable(event) },
    { id: "event_id", label: "日志编号", layout: "text", defaultVisible: false, cell: event => <span className="list-code" title={event.event_id}>{event.event_id}</span> },
  ];

  return <div className="flex min-w-0 flex-col gap-3" data-audit-page>
    <PageHeading title="审计日志" />
    <PageHeaderActions><PageHeaderActionLink><Link global to={statusHref} className={buttonVariants({ variant: "ghost", size: "sm" })} data-audit-status-trigger aria-label={captureLabel + "，查看采集状态"}>{captureLabel}</Link></PageHeaderActionLink></PageHeaderActions>
    {metadata.data && <AuditCaptureNotice capture={metadata.data.data.capture} compact />}
    <ErrorNotice error={metadata.error} retry={() => { void metadata.refetch(); }} retainedData={!!metadata.data} />
    <ListColumnsProvider>
      <ListLayout className="w-full" data-business-list="audit">
        <ListToolbarPart area="leading">
          <Tabs value={view?.id ?? ""} onValueChange={value => {
            const next = AUDIT_VIEWS.find(item => item.id === value);
            if (next && next.id !== view?.id) update(auditViewValues(next.id));
          }}>
            <div ref={setViewScroller} className="audit-view-scroll" onFocusCapture={event => {
              const focused = (event.target as HTMLElement).closest('[role="tab"]');
              if (focused && event.currentTarget.contains(focused)) revealAuditView(event.currentTarget, focused);
            }}><TabsList variant="line" aria-label="审计视图" className="audit-views">
              {AUDIT_VIEWS.map(item => <TabsTrigger key={item.id} value={item.id}>{item.label}</TabsTrigger>)}
            </TabsList></div>
          </Tabs>
          {!view && <span className="text-xs text-muted-foreground">自定义筛选</span>}
        </ListToolbarPart>
        <ListToolbarPart>
          <ListQueryToolbar
            control={control}
            label="审计日志关键词搜索"
            sorts={noSortChoices}
            filters={filterOptions}
            desktopActions={<><AuditExportButton state={exporting} /><RefreshButton busy={refreshing} disabled={refreshing} onClick={refresh} /></>}
            desktopFilters={<AuditFilterSelect filter={filterOptions.find(filter => filter.key === "outcome")!} control={control} />}
            desktopFilterContent={<>
              <CreatedDateFilter control={control} label="发生日期" />
              <AuditDesktopFilters filters={filterOptions.filter(filter => filter.key !== "outcome")} control={control} address={filters.source_address ?? ""} />
            </>}
            mobileFilterContent={draft => <>
              <CreatedDateFilter control={draft} label="发生日期" />
              <AuditAddressFilter control={draft} value={draft.searchParams.get("source_address") ?? ""} staged />
            </>}
            mobileFilterSummary={[
              ...(filters.created_from || filters.created_to ? [`发生日期：${filters.created_from ?? "不限"} 至 ${filters.created_to ?? "不限"}`] : []),
              ...(filters.source_address ? [`来源 IP：${filters.source_address}`] : []),
            ]}
            mobileFilterReset={{ created_from: null, created_to: null, source_address: null }}
            mobileActions={<AuditActions state={exporting} refresh={refresh} refreshing={refreshing} />}
          >
            {exporting.error && <div className="min-w-0 w-full" data-list-menu-feedback><ErrorNotice error={exporting.error} /></div>}
            {exporting.generated && <p role="status" aria-live="polite" className="w-full text-sm text-muted-foreground" data-list-menu-feedback>文件已生成</p>}
          </ListQueryToolbar>
        </ListToolbarPart>
        <QueryView query={events}>
          {page => <>
            <div className="min-w-0" aria-busy={events.isFetching}>
              {page.data.length > 0 ? <BusinessTable
                id="audit" aria-label="审计日志列表" items={[...page.data]} rowId={rowId} columns={columns}
                renderSummary={event => <AuditSummary event={event} deleted={deleted(event)} />}
              /> : <Empty kind="filtered"><EmptyHeader>
                <EmptyTitle role="heading" aria-level={2}>暂无符合条件的日志</EmptyTitle>
                <EmptyDescription>可调整筛选范围。活动记录仅保留最近 30 天，历史未记录的信息无法补查。</EmptyDescription>
              </EmptyHeader></Empty>}
            </div>
            <CursorPagination previousLabel={pagination.previousLabel} page={pagination.page} count={page.data.length} hasNext={!!page.page.next_cursor} pending={events.isFetching}
              onPrevious={pagination.previous} onNext={() => pagination.next(page.page.next_cursor)} />
          </>}
        </QueryView>
      </ListLayout>
    </ListColumnsProvider>
  </div>;
}
