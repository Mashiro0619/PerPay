import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import type { AuditEventItem } from "../../../src/shared/audit";
import { auditEventsQuery, auditListKey, auditMetadataQuery, AUDIT_FILTER_KEYS, readAuditFilters } from "@/api/audit";
import { auditActionLabel, auditEventHref } from "@/lib/audit";
import { useListQuery, type ListQueryControl } from "@/lib/list-query";
import { useCursor } from "@/lib/cursor";
import { Link } from "@/navigation";
import { PageHeading } from "@/components/page-heading";
import { ListLayout, ListToolbarPart } from "@/components/list-layout";
import { ListQueryToolbar } from "@/components/list-query-toolbar";
import { ListColumnsProvider } from "@/components/list-columns";
import { BusinessTable, type BusinessColumn } from "@/components/business-table";
import { ListIdentity, ListMeta, ListSummary, ListSummaryField } from "@/components/list-primitives";
import { CursorPagination } from "@/components/cursor-pagination";
import { AuditAddressFilter, AuditDesktopFilters, auditFilterOptions } from "@/components/audit-filters";
import { AuditActions, AuditExportButton, useAuditExport } from "@/components/audit-export";
import { AuditActor, AuditCaptureNotice, AuditCategory, AuditRecordType, AuditResult, AuditRetention, AuditSite, AuditSourceInfo, AuditTime } from "@/components/audit-record";
import { CreatedDateFilter } from "@/components/created-date-filter";
import { QueryView, ErrorNotice } from "@/components/request-state";
import { RefreshButton } from "@/components/refresh-button";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/admin-empty";

const timeSort = ["occurred_at"] as const;
const noSortChoices: readonly { value: string; label: string }[] = [];
const rowId = (event: AuditEventItem) => `${event.source}:${event.event_id}`;

export default function Audit() {
  const [search] = useSearchParams();
  const queryClient = useQueryClient();
  const filters = readAuditFilters(search);
  const pagination = useCursor();
  const baseControl = useListQuery(timeSort, "occurred_at", "desc", true);
  const update = (values: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const nextFilters = readAuditFilters(next);
    if (JSON.stringify(nextFilters) !== JSON.stringify(filters)) {
      // Applying a different filter creates a new snapshot even when that
      // filter was viewed earlier. Browser/detail back keeps its saved page.
      void queryClient.invalidateQueries({ queryKey: auditListKey(nextFilters), refetchType: "none" });
    }
    baseControl.update({ ...values, sort_by: null, sort_order: null });
  };
  const control: ListQueryControl = {
    ...baseControl,
    query: { ...baseControl.query, sortBy: "occurred_at", sortOrder: "desc" },
    update,
    setKeyword: q => update({ q }),
    setSort: () => undefined,
    clear: () => update(Object.fromEntries(AUDIT_FILTER_KEYS.map(key => [key, null]))),
  };
  const metadata = useQuery(auditMetadataQuery());
  const events = useQuery(auditEventsQuery(filters, pagination.cursor));
  const exporting = useAuditExport(filters);
  const filterOptions = auditFilterOptions(filters, metadata.data?.data);
  const deletedSites = new Set(metadata.data?.data.sites.filter(site => site.deleted).map(site => site.site_id) ?? []);

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: auditListKey(filters), refetchType: "none" });
    if (pagination.cursor) control.update({});
    else void events.refetch();
    void metadata.refetch();
  }
  const refreshing = events.isFetching || metadata.isFetching;
  const columns: BusinessColumn<AuditEventItem>[] = [
    {
      id: "identity", label: "操作 / 对象", layout: "identity", hideable: false, summaryDefault: true,
      cell: (event, context) => <ListIdentity
        meta={<ListMeta><AuditRecordType event={event} /><AuditCategory category={event.category} sourceType={event.source_type} /></ListMeta>}
        description={<>
          {event.subject_id && <ListMeta><span className="list-code wrap-anywhere">对象：{event.subject_id}</span></ListMeta>}
          {event.route && <ListMeta><span className="list-code wrap-anywhere">{event.http_method} {event.route}</span></ListMeta>}
          {context.showInSummary("occurred_at") && <ListMeta><AuditTime value={event.occurred_at} /></ListMeta>}
          {(context.showInSummary("actor") || context.showInSummary("site")) && <ListMeta>
            {context.showInSummary("actor") && <AuditActor event={event} />}
            {context.showInSummary("site") && <AuditSite event={event} deleted={!!event.site_id && deletedSites.has(event.site_id)} />}
          </ListMeta>}
          {context.showInSummary("source") && (event.source_address || event.user_agent) && <ListMeta><AuditSourceInfo event={event} /></ListMeta>}
        </>}
      ><Link global data-row-link className="list-primary-link" to={auditEventHref(event)} title={event.action}>{auditActionLabel(event.action)}</Link></ListIdentity>,
    },
    { id: "outcome", label: "结果", layout: "status", align: "center", summaryDefault: true, cell: event => <AuditResult outcome={event.outcome} source_type={event.source_type} http_status={event.http_status} is_aggregate={event.is_aggregate} action={event.action} /> },
    { id: "occurred_at", label: "发生时间", layout: "datetime", align: "center", summaryDefault: true, responsive: { minWidthRem: 40, basis: "container" }, cell: event => <AuditTime value={event.occurred_at} /> },
    { id: "actor", label: "执行者", layout: "text", summaryDefault: true, summaryPriority: "details", responsive: { minWidthRem: 60, basis: "container" }, cell: event => <AuditActor event={event} /> },
    { id: "site", label: "关联网站", layout: "text", summaryDefault: true, summaryPriority: "details", responsive: { minWidthRem: 68, basis: "container" }, cell: event => <AuditSite event={event} deleted={!!event.site_id && deletedSites.has(event.site_id)} /> },
    { id: "source", label: "来源 / 客户端", layout: "text", summaryDefault: true, summaryPriority: "details", responsive: { minWidthRem: 78, basis: "container" }, cell: event => <AuditSourceInfo event={event} /> },
  ];

  return <div className="flex min-w-0 flex-col gap-4" data-audit-page>
    <PageHeading title="审计日志" />
    <AuditRetention />
    {metadata.data && <AuditCaptureNotice capture={metadata.data.data.capture} />}
    <ErrorNotice error={metadata.error} retry={() => { void metadata.refetch(); }} retainedData={!!metadata.data} />
    <ListColumnsProvider>
      <ListLayout className="w-full" data-business-list="audit">
        <ListToolbarPart>
          <ListQueryToolbar
            control={control}
            label="审计日志关键词搜索"
            sorts={noSortChoices}
            filters={filterOptions}
            desktopActions={<><AuditExportButton state={exporting} /><RefreshButton busy={refreshing} disabled={refreshing} onClick={refresh} /></>}
            desktopFilterContent={<>
              <AuditDesktopFilters filters={filterOptions} control={control} address={filters.source_address ?? ""} />
              {Object.keys(filters).length > 0 && <Button variant="ghost" onClick={control.clear}>清除搜索和筛选</Button>}
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
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground" data-audit-snapshot>
              <span>读取于 <AuditTime value={page.page.snapshot_at} />（北京时间）</span>
              <span>按发生时间从新到旧；刷新后读取最新记录。</span>
            </div>
            <div className="min-w-0" aria-busy={events.isFetching}>
              {page.data.length > 0 ? <BusinessTable
                id="audit" aria-label="审计日志列表" items={[...page.data]} rowId={rowId} columns={columns}
                renderSummary={(event, context) => <ListSummary
                  identity={columns[0]!.cell(event, context)}
                  details={columns.filter(column => context.isColumnVisible(column.id) && !context.isSummaryPrimary(column.id)).map(column => <ListSummaryField key={column.id} label={column.label}>{column.cell(event, context)}</ListSummaryField>)}
                >{columns.filter(column => column.id !== "identity" && context.isSummaryPrimary(column.id)).map(column => <ListSummaryField key={column.id} label={column.label}>{column.cell(event, context)}</ListSummaryField>)}</ListSummary>}
              /> : <Empty kind="filtered"><EmptyHeader>
                <EmptyTitle role="heading" aria-level={2}>暂无符合条件的日志</EmptyTitle>
                <EmptyDescription>可调整筛选范围。活动记录仅保留最近 30 天，历史未记录的信息无法补查。</EmptyDescription>
              </EmptyHeader></Empty>}
            </div>
            <CursorPagination previousLabel={pagination.previousLabel} page={pagination.page} count={page.data.length} hasNext={!!page.page.next_cursor} pending={events.isFetching}
              onPrevious={pagination.previous} onNext={() => pagination.next(page.page.next_cursor)} />
          </>}
        </QueryView>
        <p className="text-xs text-muted-foreground">CSV 导出当前筛选的全部匹配记录，最多 10,000 行；每组分钟汇总占一行。导出前请选择发生日期，跨度最多 366 天。</p>
      </ListLayout>
    </ListColumnsProvider>
  </div>;
}
