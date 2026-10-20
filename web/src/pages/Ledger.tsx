import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { api, result, type AdminLedgerSummary } from "@/api/client";
import { Link, useLedgerListPosition } from "@/navigation";
import { useCursor } from "@/lib/cursor";
import { label } from "@/lib/labels";
import { useListQuery } from "@/lib/list-query";
import { LEDGER_DATE_FIELDS, LEDGER_SORT_FIELDS, LEDGER_STATES, readLedgerFilters, ledgerAmountInput } from "@/lib/ledger-filters";
import { retainListData } from "@/lib/list-placeholder";
import { useOptionalSystemStatus } from "@/features/system-status";
import { BusinessTable, type BusinessColumn } from "@/components/business-table";
import { ListColumnsProvider } from "@/components/list-columns";
import { ListLayout, ListToolbarPart } from "@/components/list-layout";
import { ListQueryToolbar, type ListFilter } from "@/components/list-query-toolbar";
import { ListDateTime, ListIdentity, ListMeta, ListSummary, ListSummaryField } from "@/components/list-primitives";
import { CreatedDateFilter } from "@/components/created-date-filter";
import { LedgerAmountFilter } from "@/components/ledger-amount-filter";
import { LedgerFreshness } from "@/components/ledger-freshness";
import { LedgerActiveOrder, LedgerDirection, LedgerMoney, LedgerStates, ledgerFact } from "@/components/ledger-record";
import { CursorPagination } from "@/components/cursor-pagination";
import { QueryView, ErrorNotice } from "@/components/request-state";
import { RefreshButton } from "@/components/refresh-button";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/admin-empty";

const directionOptions = [{ value: "", label: "全部收支" }, { value: "CREDIT", label: "收入" }, { value: "DEBIT", label: "支出" }];
const stateOptions = [{ value: "", label: "全部处理状态" }, ...LEDGER_STATES.map(value => ({ value, label: label(value) }))];

export default function Ledger() {
  const [search] = useSearchParams();
  const control = useListQuery(LEDGER_SORT_FIELDS, "occurred_at", "desc", LEDGER_DATE_FIELDS);
  const pagination = useCursor();
  const system = useOptionalSystemStatus();
  let filters: ReturnType<typeof readLedgerFilters> | undefined;
  let filterError: Error | undefined;
  try { filters = readLedgerFilters(search); }
  catch (error) { filterError = error instanceof Error ? error : new Error("流水筛选条件无效。"); }
  const query = useQuery({
    ...retainListData(["administrator-ledger", filters?.direction, filters?.state, filters?.min_amount_cents, filters?.max_amount_cents], control.query),
    queryKey: ["administrator-ledger", filters, pagination.cursor, filterError?.message],
    enabled: !filterError,
    queryFn: ({ signal }) => result(api.listAdministratorLedgerEntries({ signal, query: { ...filters, limit: 20, ...(pagination.cursor ? { cursor: pagination.cursor } : {}) } })),
  });
  useLedgerListPosition(!!query.data && !query.isPlaceholderData && !query.isFetching);
  const listFilters: ListFilter[] = [
    { key: "direction", label: "收支方向", value: search.get("direction") ?? "", options: directionOptions },
    { key: "state", label: "处理状态", value: search.get("state") ?? "", options: stateOptions },
  ];
  const columns: BusinessColumn<AdminLedgerSummary>[] = [
    { id: "identity", label: "支付宝流水号", hideable: false, layout: "identity", summaryDefault: true,
      cell: (entry, context) => <ListIdentity
        meta={!context.isColumnVisible("order") && <LedgerActiveOrder entry={entry} />}
        description={<ListMeta>
          {context.showInSummary("occurred_at") && (entry.occurred_at ? <ListDateTime value={entry.occurred_at} inline /> : <span>{entry.content_consistent ? "—" : "有争议"}</span>)}
          {context.showInSummary("other_account") && entry.other_account && <span>{entry.other_account}</span>}
          {context.showInSummary("memo") && entry.memo && <span>{entry.memo}</span>}
          {entry.source_record_count > 1 && <span>{entry.source_record_count} 条采集来源</span>}
        </ListMeta>}>
        <Link global data-row-link className="list-primary-link list-code" title={entry.external_event_id} to={"/ledger/" + entry.ledger_entry_id}>{entry.external_event_id}</Link>
      </ListIdentity> },
    { id: "occurred_at", label: "交易时间", sortBy: "occurred_at", layout: "datetime", align: "center", summaryDefault: true, responsive: { minWidthRem: 46, basis: "container" }, cell: entry => entry.occurred_at ? <ListDateTime value={entry.occurred_at} /> : entry.content_consistent ? "—" : "有争议" },
    { id: "direction", label: "收支", layout: "status", align: "center", summaryDefault: true, cell: entry => <LedgerDirection value={entry.direction} disputed={!entry.content_consistent} /> },
    { id: "amount_cents", label: "交易金额", layout: "amount", align: "center", summaryDefault: true, cell: entry => <LedgerMoney entry={entry} /> },
    { id: "other_account", label: "对方", layout: "text", summaryDefault: true, responsive: { minWidthRem: 58, basis: "container" }, cell: entry => <span className="wrap-anywhere">{ledgerFact(entry.other_account)}</span> },
    { id: "memo", label: "备注", layout: "text", summaryDefault: true, responsive: { minWidthRem: 78, basis: "container" }, cell: entry => <span className="wrap-anywhere">{ledgerFact(entry.memo)}</span> },
    { id: "state", label: "处理状态", layout: "status", align: "center", summaryDefault: true, cell: entry => <LedgerStates entry={entry} /> },
    { id: "order", label: "实际关联订单", layout: "text", summaryDefault: true, responsive: { minWidthRem: 64, basis: "container" }, cell: entry => <LedgerActiveOrder entry={entry} /> },
  ];
  const hasAmounts = search.has("min_amount_cents") || search.has("max_amount_cents");
  const activeFilters = !!(control.query.q || control.query.createdFrom || control.query.createdTo || search.get("direction") || search.get("state") || hasAmounts);
  const refresh = <RefreshButton busy={query.isFetching} onClick={() => { if (!filterError) void query.refetch(); if (system) void system.status.refetch(); }} />;
  return <ListColumnsProvider><ListLayout data-business-list="ledger">
    <ListToolbarPart>
      <ListQueryToolbar control={control} label="支付宝流水关键词搜索" sorts={[{ value: "occurred_at", label: "交易时间" }]} filters={listFilters}
        desktopFilters={listFilters.map(filter => <Select key={filter.key} items={filter.options} value={filter.value} onValueChange={value => { if (value !== null) control.update({ [filter.key]: value }); }}>
          <SelectTrigger aria-label={filter.label + "筛选"}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{filter.options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>)} desktopActions={refresh} mobileActions={refresh}>
        <CreatedDateFilter control={control} label="交易日期" fields={LEDGER_DATE_FIELDS} />
        <LedgerAmountFilter control={control} />
        {hasAmounts && <span className="text-xs text-muted-foreground">{ledgerAmountInput(search.get("min_amount_cents")) || "不限"} 至 {ledgerAmountInput(search.get("max_amount_cents")) || "不限"} 元</span>}
        {activeFilters && <Button variant="ghost" size="sm" onClick={() => control.update({ q: null, direction: null, state: null, occurred_from: null, occurred_to: null, min_amount_cents: null, max_amount_cents: null, sort_by: null, sort_order: null })}>清除筛选</Button>}
        <div className="basis-full"><LedgerFreshness value={system && !system.checking && !system.unavailable ? system.status.data?.data.ledger.last_success_at : undefined} /><p className="text-xs text-muted-foreground">查询已采集的本地流水 · 交易时间为北京时间 · 刷新读取本地记录 · <Link global to="/reconciliation?tab=conflicts">账本冲突</Link></p></div>
      </ListQueryToolbar>
    </ListToolbarPart>
    {filterError ? <ErrorNotice error={filterError} /> : <QueryView query={query}>{page => <>
      <div className="min-w-0" aria-busy={query.isFetching || query.isPlaceholderData}>
        {page.data.length ? <BusinessTable id="administrator-ledger" aria-label="支付宝流水" tableClassName="ledger-table" items={page.data} columns={columns} rowId={entry => entry.ledger_entry_id} control={control}
          renderSummary={(entry, context) => <ListSummary identity={columns[0]!.cell(entry, context)} aside={context.isColumnVisible("amount_cents") && <LedgerMoney entry={entry} />}>
            {columns.filter(column => !["identity", "amount_cents"].includes(column.id) && context.isColumnVisible(column.id)).map(column => <ListSummaryField key={column.id} label={column.label}>{column.cell(entry, context)}</ListSummaryField>)}
          </ListSummary>} /> : <Empty kind={activeFilters ? "filtered" : "page"}><EmptyHeader><EmptyTitle role="heading" aria-level={2}>{activeFilters ? "暂无符合条件的流水" : "暂无支付宝流水"}</EmptyTitle><EmptyDescription>{activeFilters ? "调整筛选条件后重试。" : "完成支付宝接入后，已采集的流水会显示在这里。"}</EmptyDescription></EmptyHeader></Empty>}
      </div>
      <CursorPagination page={pagination.page} count={page.data.length} hasNext={!!page.page.next_cursor} pending={query.isFetching || query.isPlaceholderData} previousLabel={pagination.previousLabel} onPrevious={pagination.previous} onNext={() => pagination.next(page.page.next_cursor)} />
    </>}</QueryView>}
  </ListLayout></ListColumnsProvider>;
}
