import { useQuery } from "@tanstack/react-query";
import { Link2, RefreshCw } from "lucide-react";
import { useSearchParams } from "react-router";
import { api, result, type AdminLedgerSummary } from "@/api/client";
import { Link, useLedgerListPosition, useNavigate } from "@/navigation";
import { resourceIdPattern } from "@/lib/format";
import { useCursor } from "@/lib/cursor";
import { label } from "@/lib/labels";
import { useListQuery } from "@/lib/list-query";
import { DEFAULT_LEDGER_DIRECTION, LEDGER_ASSOCIATED_DATE_FIELDS, LEDGER_DATE_FIELDS, LEDGER_SORT_FIELDS, LEDGER_STATES, readLedgerFilters, ledgerAmountInput } from "@/lib/ledger-filters";
import { retainListData } from "@/lib/list-placeholder";
import { useOptionalSystemStatus } from "@/features/system-status";
import { BusinessTable, type BusinessColumn } from "@/components/business-table";
import { ListActionsMenu } from "@/components/list-actions-menu";
import { ListColumnsProvider } from "@/components/list-columns";
import { ListLayout, ListToolbarPart } from "@/components/list-layout";
import { ListQueryToolbar, type ListFilter } from "@/components/list-query-toolbar";
import { ListDateTime, ListIdentity, ListMeta, ListSummary, ListSummaryField } from "@/components/list-primitives";
import { CreatedDateFilter } from "@/components/created-date-filter";
import { LedgerAmountFilter } from "@/components/ledger-amount-filter";
import { LedgerFreshness } from "@/components/ledger-freshness";
import { LedgerActiveOrder, LedgerAssociationStatus, LedgerDirection, LedgerMoney, LedgerStates, ledgerFact } from "@/components/ledger-record";
import { CursorPagination } from "@/components/cursor-pagination";
import { QueryView, ErrorNotice } from "@/components/request-state";
import { RefreshButton } from "@/components/refresh-button";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/admin-empty";

const directionOptions = [{ value: "ALL", label: "全部收支" }, { value: "CREDIT", label: "收入" }, { value: "DEBIT", label: "支出" }];
const stateOptions = [{ value: "", label: "全部处理状态" }, ...LEDGER_STATES.map(value => ({ value, label: label(value) }))];
const associationOptions = [{ value: "", label: "全部关联" }, { value: "UNMATCHED", label: "未关联" }, { value: "MATCHED", label: "已关联" }, { value: "MULTIPLE", label: "多笔关联" }];
const reversalOptions = [{ value: "", label: "全部撤销记录" }, { value: "true", label: "有撤销记录" }, { value: "false", label: "无撤销记录" }];
const sortOptions = [
  { value: "occurred_at", label: "交易时间" },
  { value: "associated_at", label: "最近关联时间" },
  { value: "handled_at", label: "最近处理时间" },
  { value: "amount_cents", label: "交易金额" },
  { value: "event_sequence", label: "关联事件顺序" },
];

/** Kept as a composition for callers that render the list outside the reconciliation tabs. */
export default function Ledger() {
  return <ListLayout><LedgerList /></ListLayout>;
}

export function LedgerList({ onManual }: { onManual?: (trigger: HTMLButtonElement | null) => void }) {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const direction = search.get("direction") || DEFAULT_LEDGER_DIRECTION;
  const control = useListQuery(LEDGER_SORT_FIELDS, "occurred_at", "desc", LEDGER_DATE_FIELDS);
  const associatedDates = useListQuery(LEDGER_SORT_FIELDS, "occurred_at", "desc", LEDGER_ASSOCIATED_DATE_FIELDS);
  const pagination = useCursor();
  const system = useOptionalSystemStatus();
  let filters: ReturnType<typeof readLedgerFilters> | undefined;
  let filterError: Error | undefined;
  try { filters = readLedgerFilters(search); }
  catch (error) { filterError = error instanceof Error ? error : new Error("流水筛选条件无效。"); }
  const query = useQuery({
    ...retainListData(["administrator-ledger", filters?.direction, filters?.state, filters?.association_status, filters?.has_reversals, filters?.associated_from, filters?.associated_to, filters?.min_amount_cents, filters?.max_amount_cents], control.query),
    queryKey: ["administrator-ledger", filters, pagination.cursor, filterError?.message],
    enabled: !filterError,
    queryFn: ({ signal }) => result(api.listAdministratorLedgerEntries({ signal, query: { ...filters, limit: 20, ...(pagination.cursor ? { cursor: pagination.cursor } : {}) } })),
  });
  useLedgerListPosition(!!query.data && !query.isPlaceholderData && !query.isFetching);
  const listFilters: ListFilter[] = [
    { key: "association_status", label: "关联状态", value: search.get("association_status") ?? "", options: associationOptions },
    { key: "direction", label: "收支方向", value: direction, defaultValue: DEFAULT_LEDGER_DIRECTION, options: directionOptions },
    { key: "state", label: "PerPay 处理状态", value: search.get("state") ?? "", options: stateOptions },
    { key: "has_reversals", label: "撤销记录", value: search.get("has_reversals") ?? "", options: reversalOptions },
  ];
  const columns: BusinessColumn<AdminLedgerSummary>[] = [
    { id: "identity", label: "支付宝流水号", hideable: false, layout: "identity", summaryDefault: true,
      cell: (entry, context) => <ListIdentity
        meta={context.showInSummary("order") && <LedgerActiveOrder entry={entry} />}
        description={<ListMeta>
          {context.showInSummary("occurred_at") && (entry.occurred_at ? <ListDateTime value={entry.occurred_at} inline /> : <span>{entry.content_consistent ? "—" : "有争议"}</span>)}
          {context.showInSummary("other_account") && entry.other_account && <span>{entry.other_account}</span>}
          {context.showInSummary("memo") && entry.memo && <span>{entry.memo}</span>}
        </ListMeta>}>
        <Link global data-row-link className="list-primary-link list-code" title={entry.external_event_id} to={"/reconciliation/transactions/" + entry.ledger_entry_id}>{entry.external_event_id}</Link>
      </ListIdentity> },
    { id: "occurred_at", label: "交易时间", sortBy: "occurred_at", layout: "datetime", align: "center", summaryDefault: true, responsive: { minWidthRem: 46, basis: "container" }, cell: entry => entry.occurred_at ? <ListDateTime value={entry.occurred_at} /> : entry.content_consistent ? "—" : "有争议" },
    { id: "direction", label: "收支", layout: "status", align: "center", summaryDefault: true, cell: entry => <LedgerDirection value={entry.direction} disputed={!entry.content_consistent} /> },
    { id: "amount_cents", label: "交易金额", sortBy: "amount_cents", layout: "amount", align: "center", summaryDefault: true, cell: entry => <LedgerMoney entry={entry} /> },
    { id: "association", label: "关联状态", layout: "status", align: "center", summaryDefault: true, cell: entry => <LedgerAssociationStatus entry={entry} /> },
    { id: "order", label: "当前关联订单", layout: "text", summaryDefault: true, responsive: { minWidthRem: 64, basis: "container" }, cell: entry => <LedgerActiveOrder entry={entry} /> },
    { id: "other_account", label: "对方", layout: "text", summaryDefault: true, summaryPriority: "details", responsive: { minWidthRem: 58, basis: "container" }, cell: entry => <span className="wrap-anywhere">{ledgerFact(entry.other_account)}</span> },
    { id: "memo", label: "备注", layout: "text", summaryDefault: false, responsive: { minWidthRem: 78, basis: "container" }, cell: entry => <span className="wrap-anywhere">{ledgerFact(entry.memo)}</span> },
    { id: "state", label: "PerPay 处理状态", layout: "status", align: "center", summaryDefault: true, responsive: { minWidthRem: 78, basis: "container" }, cell: entry => <LedgerStates entry={entry} /> },
    { id: "associated_at", label: "最近关联时间", sortBy: "associated_at", layout: "datetime", align: "center", summaryDefault: false, responsive: { minWidthRem: 90, basis: "container" }, cell: entry => entry.last_associated_at ? <ListDateTime value={entry.last_associated_at} /> : "—" },
    { id: "handled_at", label: "最近处理时间", sortBy: "handled_at", layout: "datetime", align: "center", summaryDefault: false, responsive: { minWidthRem: 100, basis: "container" }, cell: entry => entry.last_handled_at ? <ListDateTime value={entry.last_handled_at} /> : "—" },
  ];
  const hasAmounts = search.has("min_amount_cents") || search.has("max_amount_cents");
  const clearFilterValues = { q: null, direction: null, state: null, association_status: null, has_reversals: null, occurred_from: null, occurred_to: null, associated_from: null, associated_to: null, min_amount_cents: null, max_amount_cents: null, sort_by: null, sort_order: null };
  const extraFilterSummaries = [
    ...(control.query.createdFrom || control.query.createdTo ? ["交易日期：" + (control.query.createdFrom ?? "不限") + " 至 " + (control.query.createdTo ?? "不限")] : []),
    ...(associatedDates.query.createdFrom || associatedDates.query.createdTo ? ["关联日期：" + (associatedDates.query.createdFrom ?? "不限") + " 至 " + (associatedDates.query.createdTo ?? "不限")] : []),
    ...(hasAmounts ? ["金额：" + (ledgerAmountInput(search.get("min_amount_cents")) || "不限") + " 至 " + (ledgerAmountInput(search.get("max_amount_cents")) || "不限") + " 元"] : []),
  ];
  const activeFilters = !!(control.query.q || control.query.createdFrom || control.query.createdTo || associatedDates.query.createdFrom || associatedDates.query.createdTo || direction !== DEFAULT_LEDGER_DIRECTION || search.get("state") || search.get("association_status") || search.has("has_reversals") || hasAmounts);
  function refresh() { if (!filterError) void query.refetch(); if (system) void system.status.refetch(); }
  const refreshButton = <RefreshButton busy={query.isFetching} onClick={refresh} />;
  return <ListColumnsProvider><div className="flex min-w-0 flex-col gap-3" data-business-list="ledger">
    <ListToolbarPart>
      <ListQueryToolbar control={control} label="支付宝流水关键词搜索" sorts={sortOptions} filters={listFilters}
        mobileFilterContent={draft => <>
          <CreatedDateFilter control={draft.withDates(LEDGER_DATE_FIELDS)} label="交易日期" fields={LEDGER_DATE_FIELDS} />
          <CreatedDateFilter control={draft.withDates(LEDGER_ASSOCIATED_DATE_FIELDS)} label="关联日期" fields={LEDGER_ASSOCIATED_DATE_FIELDS} />
          <LedgerAmountFilter control={draft} searchParams={draft.searchParams} />
        </>}
        mobileFilterSummary={extraFilterSummaries}
        mobileFilterReset={{ occurred_from: null, occurred_to: null, associated_from: null, associated_to: null, min_amount_cents: null, max_amount_cents: null }}
        desktopFilterContent={<>
          <CreatedDateFilter control={control} label="交易日期" fields={LEDGER_DATE_FIELDS} />
          <CreatedDateFilter control={associatedDates} label="关联日期" fields={LEDGER_ASSOCIATED_DATE_FIELDS} />
          <LedgerAmountFilter control={control} />
          {hasAmounts && <span className="text-xs text-muted-foreground">{ledgerAmountInput(search.get("min_amount_cents")) || "不限"} 至 {ledgerAmountInput(search.get("max_amount_cents")) || "不限"} 元</span>}
          {activeFilters && <Button variant="ghost" size="sm" onClick={() => control.update(clearFilterValues)}>清除筛选</Button>}
        </>}
        lookup={{
          modes: [{ value: "ledger", label: "内部流水编号（PerPay）", placeholder: "输入完整的 PerPay 内部流水编号", pattern: resourceIdPattern.source }],
          inputLabel: "内部流水编号（PerPay）", inputName: "ledger-lookup",
          onSubmit: (_mode, value) => { if (resourceIdPattern.test(value)) navigate("/reconciliation/transactions/" + value); },
        }}
        desktopFilters={listFilters.map(filter => <Select key={filter.key} items={filter.options} value={filter.value} onValueChange={value => { if (value !== null) control.update({ [filter.key]: value }); }}>
          <SelectTrigger aria-label={filter.label + "筛选"}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{filter.options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>)} desktopActions={refreshButton} mobileActions={<ListActionsMenu label="更多对账操作">{trigger => <>
          {onManual && <DropdownMenuItem onClick={() => onManual(trigger.current)}><Link2 />人工关联收款</DropdownMenuItem>}
          <DropdownMenuItem disabled={query.isFetching || !!filterError} onClick={refresh}><RefreshCw />刷新</DropdownMenuItem>
        </>}</ListActionsMenu>}>
        <div className="basis-full"><LedgerFreshness value={system && !system.checking && !system.unavailable ? system.status.data?.data.ledger.last_success_at : undefined} /></div>
      </ListQueryToolbar>
    </ListToolbarPart>
    {filterError ? <ErrorNotice error={filterError} /> : <QueryView query={query}>{page => <>
      <div className="min-w-0" aria-busy={query.isFetching || query.isPlaceholderData}>
        {page.data.length ? <BusinessTable id="administrator-ledger" aria-label="支付宝流水" tableClassName="ledger-table" items={page.data} columns={columns} rowId={entry => entry.ledger_entry_id} control={control}
          renderSummary={(entry, context) => <ListSummary
            identity={columns[0]!.cell(entry, context)}
            aside={context.isSummaryPrimary("amount_cents") && <LedgerMoney entry={entry} />}
            details={columns.filter(column => context.isColumnVisible(column.id) && !context.isSummaryPrimary(column.id)).map(column => <ListSummaryField key={column.id} label={column.label}>{column.cell(entry, context)}</ListSummaryField>)}
          >
            {columns.filter(column => !["identity", "amount_cents"].includes(column.id) && context.isSummaryPrimary(column.id)).map(column => <ListSummaryField key={column.id} label={column.label}>{column.cell(entry, context)}</ListSummaryField>)}
          </ListSummary>} /> : <Empty kind={activeFilters ? "filtered" : "page"}><EmptyHeader><EmptyTitle role="heading" aria-level={2}>{activeFilters ? "暂无符合条件的流水" : "暂无支付宝流水"}</EmptyTitle><EmptyDescription>{activeFilters ? "调整筛选条件后重试。" : "已采集的支付宝流水会显示在这里。"}</EmptyDescription></EmptyHeader></Empty>}
      </div>
      <CursorPagination page={pagination.page} count={page.data.length} hasNext={!!page.page.next_cursor} pending={query.isFetching || query.isPlaceholderData} previousLabel={pagination.previousLabel} onPrevious={pagination.previous} onNext={() => pagination.next(page.page.next_cursor)} />
    </>}</QueryView>}
  </div></ListColumnsProvider>;
}
