import { ListLayout, ListToolbarPart } from "@/components/list-layout";
import {
  useListQuery,
  CONFLICT_SORT_FIELDS,
  EXCEPTION_SORT_FIELDS,
} from "@/lib/list-query";
import {
  ListQueryToolbar,
  type ListFilter,
} from "@/components/list-query-toolbar";
import { ListActionsMenu } from "@/components/list-actions-menu";
import { ListColumnsProvider } from "@/components/list-columns";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useCompactList } from "@/hooks/use-compact-list";
import { BusinessTable, type BusinessColumn } from "@/components/business-table";
import {
  ListDateTime,
  ListIdentity,
  ListMeta,
  ListSummary,
  ListSummaryField,
} from "@/components/list-primitives";
import { useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Link2, EyeOff } from "lucide-react";
import { Navigate, useLocation, useSearchParams } from "react-router";
import { Link, useNavigate } from "@/navigation";
import { api, result, type ReconciliationIssueContext } from "@/api/client";
import { useCursor } from "@/lib/cursor";
import { money, resourceIdPattern, shortId } from "@/lib/format";
import { label } from "@/lib/labels";
import { StatusBadge } from "@/components/business-status";
import { QueryView } from "@/components/request-state";
import { retainListData } from "@/lib/list-placeholder";
import { migrateMatchListSearch } from "@/lib/ledger-filters";
import { CursorPagination } from "@/components/cursor-pagination";
import { useSuccessToast } from "@/components/Feedback";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";
import { FinancialDialog } from "./FinancialDialog";
import { LedgerList } from "./Ledger";
type Section = "transactions" | "conflicts" | "exceptions";
type IssueSection = Exclude<Section, "transactions">;
type ReconciliationRow = {
  id: string;
  title: string;
  merchantOrderNo: string | null;
  externalEventId: string | null;
  orderId: string | null;
  rawPageId: string | null;
  reminderIgnored: boolean;
  status: string;
  createdAt: string;
  context: ReconciliationIssueContext | null;
};

function RelatedOrderLink({ item }: { item: ReconciliationRow }) {
  const merchantOrderNo = item.context?.order_summary?.merchant_order_no ?? item.merchantOrderNo;
  const orderId = item.context?.order_summary?.order_id ?? item.orderId;
  if (!orderId) return <span className="list-code">{merchantOrderNo ?? "—"}</span>;
  const text = merchantOrderNo ?? "订单 " + shortId(orderId);
  return (
    <Link
      className="list-code reconciliation-order-link"
      title={merchantOrderNo ?? undefined}
      aria-label={"查看订单：" + (merchantOrderNo ?? shortId(orderId))}
      to={"/orders/" + orderId}
    >
      {text}
    </Link>
  );
}

function readableRawDirection(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === "CREDIT") return "收入";
  if (normalized === "DEBIT") return "支出";
  if (normalized === "UNKNOWN") return "方向未知";
  return value;
}

function readableRawAmount(value: string | null): string | null {
  if (!value) return null;
  return /^\d+(?:\.\d{1,2})?$/.test(value.trim()) ? "¥" + value.trim() : value;
}

/** Identifies both the related order and the individual payment behind an issue. */
function RelatedRecord({ item }: { item: ReconciliationRow }) {
  const order = item.context?.order_summary;
  const ledger = item.context?.ledger_entry_summary;
  if (order) {
    const site = order.site_name || order.api_client_id || null;
    const ledgerDirection = ledger?.direction === "CREDIT" ? "收入流水" : "支出流水";
    return (
      <div className="reconciliation-related-record">
        <Link
          className="reconciliation-related-record reconciliation-related-link"
          title={[order.product_name, order.merchant_order_no, site].filter(Boolean).join(" · ")}
          aria-label={"查看订单：" + order.product_name + "（" + order.merchant_order_no + (site ? "，" + site : "") + "）"}
          to={"/orders/" + order.order_id}
        >
          <span className="reconciliation-related-title" title={order.product_name}>{order.product_name}</span>
          <span className="reconciliation-related-meta">
            <span className="list-code" title={order.merchant_order_no}>{order.merchant_order_no}</span>
            {site && <span className="reconciliation-related-detail" title={site}>{site}</span>}
          </span>
        </Link>
        {ledger && (
          <Link
            className="reconciliation-related-record reconciliation-related-link"
            title={ledgerDirection + " " + money(ledger.amount_cents) + " · " + ledger.external_event_id}
            aria-label={"查看流水：" + ledgerDirection + " " + money(ledger.amount_cents) + "，流水号 " + ledger.external_event_id}
            to={"/reconciliation/transactions/" + ledger.ledger_entry_id + "#source-" + ledger.ledger_entry_id}
          >
            <span className="reconciliation-related-meta flex-wrap">
              <span className="reconciliation-related-amount">{ledgerDirection} {money(ledger.amount_cents)}</span>
              <ListDateTime value={ledger.occurred_at} inline />
            </span>
            <span className="reconciliation-related-meta">
              <span className="wrap-anywhere" title={ledger.external_event_id}>流水号 {ledger.external_event_id}</span>
            </span>
          </Link>
        )}
      </div>
    );
  }

  if (item.orderId) {
    return <div className="reconciliation-related-record"><RelatedOrderLink item={item} /></div>;
  }

  if (ledger) {
    const direction = ledger.direction === "CREDIT" ? "收入流水" : "支出流水";
    const reference = ledger.other_account || ledger.memo || "流水号 " + shortId(ledger.external_event_id);
    return (
      <Link
        className="reconciliation-related-record reconciliation-related-link"
        title={direction + " " + money(ledger.amount_cents) + " · " + ledger.external_event_id}
        aria-label={"查看流水：" + direction + " " + money(ledger.amount_cents) + "，流水号 " + ledger.external_event_id}
        to={"/reconciliation/transactions/" + ledger.ledger_entry_id + "#source-" + ledger.ledger_entry_id}
      >
        <span className="reconciliation-related-title">
          {direction} <span className="reconciliation-related-amount">{money(ledger.amount_cents)}</span>
        </span>
        <span className="reconciliation-related-meta">
          <ListDateTime value={ledger.occurred_at} inline />
          <span className="reconciliation-related-detail" title={reference}>{reference}</span>
        </span>
      </Link>
    );
  }

  const raw = item.context?.raw_event_summary;
  if (raw) {
    const reference = raw.other_account || raw.memo || null;
    const rawReference = raw.external_event_id
      ? "流水号 " + shortId(raw.external_event_id)
      : "原始记录 " + shortId(raw.raw_event_id);
    const summary = ["支付宝流水", readableRawDirection(raw.direction_text), readableRawAmount(raw.amount_text)]
      .filter(Boolean)
      .join(" · ");
    return (
      <div className="reconciliation-related-record">
        <span className="reconciliation-related-title" title={summary}>{summary}</span>
        <span className="reconciliation-related-meta">
          <span title={raw.occurred_at_text ?? undefined}>{raw.occurred_at_text || "时间未知"}</span>
          <span className="reconciliation-related-detail" title={reference ?? rawReference}>{reference ?? rawReference}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="reconciliation-related-record">
      <span className="reconciliation-related-title">
        {(item.rawPageId ? "支付宝流水页 #" : "记录 #") + (item.rawPageId ?? item.id).slice(0, 8)}
      </span>
      <span className="reconciliation-related-meta">暂无可关联的订单或单笔流水</span>
    </div>
  );
}

const sections = [
  { value: "transactions", label: "支付宝流水" },
  { value: "exceptions", label: "账务异常" },
  { value: "conflicts", label: "账本冲突" },
];
const statusNames: Record<string, string> = {
  OPEN: "待处理",
  RESOLVED: "已处理",
  IGNORED: "已隔离",
  ALL: "全部记录",
};
export default function Reconciliation() {
  const [search] = useSearchParams();
  const location = useLocation();
  const migrated = migrateMatchListSearch(search);
  return migrated
    ? <Navigate replace to={{ pathname: location.pathname, search: "?" + migrated.toString() }} state={location.state} />
    : <ReconciliationPage />;
}
function ReconciliationPage() {
  const compact = useCompactList();
  const operationTrigger = useRef<HTMLButtonElement | null>(null);
  function showOperation(trigger: HTMLButtonElement | null) {
    operationTrigger.current = trigger;
    setOperation(true);
  }
  const [search, setSearch] = useSearchParams();
  const [operation, setOperation] = useState(false);
  const setCompleted = useSuccessToast();
  const section: Section =
    search.get("tab") === "conflicts"
      ? "conflicts"
      : search.get("tab") === "exceptions"
        ? "exceptions"
        : "transactions";
  const allowed = ["OPEN", "RESOLVED", "IGNORED", "ALL"];
  const status = allowed.includes(search.get("status") ?? "")
    ? search.get("status")!
    : allowed[0]!;
  const statuses = allowed.map((value) => ({
    value,
    label: statusNames[value] ?? value,
  }));
  return (
    <>
      <ListLayout>
      <Tabs
        value={section}
        className="w-full min-w-0 gap-3"
        data-business-list="reconciliation"
        onValueChange={(value) =>
          setSearch(
            (current) => {
              const next = new URLSearchParams(current);
              next.set("tab", String(value));
              ["status", "cursor", "page", "sort_by", "sort_order", "direction", "state", "association_status", "has_reversals", "occurred_from", "occurred_to", "associated_from", "associated_to", "min_amount_cents", "max_amount_cents"].forEach(
                (key) => next.delete(key),
              );
              return next;
            },
            { replace: true },
          )
        }
      >
        <ListToolbarPart area="leading">
        <div className="flex min-w-0 items-center justify-between gap-4">
          <div className="-m-1 min-w-0 scroll-p-1 overflow-x-auto p-1">
            <TabsList aria-label="对账分类">
              {sections.map((item) => (
                <TabsTrigger key={item.value} value={item.value}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {!compact && (
            <Button onClick={(event) => showOperation(event.currentTarget)}>
              人工关联收款
            </Button>
          )}
        </div>
        </ListToolbarPart>
        <TabsContent value={section}>
          {section === "transactions" ? <LedgerList onManual={showOperation} /> : <ReconciliationList
            key={section}
            onManual={showOperation}
            mobileFilters={
              section === "exceptions"
                ? []
                : [
                    {
                      key: "status",
                      label: "对账状态",
                      value: status,
                      defaultValue: allowed[0]!,
                      options: statuses,
                    },
                  ]
            }
            section={section}
            status={status}
            filters={
              section === "exceptions" ? null : (
                <Select
                  items={statuses}
                  value={status}
                  onValueChange={(value) => {
                    if (value)
                      setSearch(
                        (current) => {
                          const next = new URLSearchParams(current);
                          next.set("tab", section);
                          next.set("status", value);
                          next.delete("cursor");
                          next.delete("page");
                          return next;
                        },
                        { replace: true },
                      );
                  }}
                >
                  <SelectTrigger aria-label="对账状态筛选">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {statuses.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              )
            }
          />}
        </TabsContent>
      </Tabs>
      </ListLayout>
      {operation && (
        <FinancialDialog
          finalFocus={() => operationTrigger.current}
          onClose={() => setOperation(false)}
          onSuccess={() => {
            setOperation(false);
            setCompleted("已关联收款");
          }}
        />
      )}
    </>
  );
}
function ReconciliationList({
  onManual,
  mobileFilters,
  section,
  status,
  filters,
}: {
  onManual: (trigger: HTMLButtonElement | null) => void;
  mobileFilters: readonly ListFilter[];
  section: IssueSection;
  status: string;
  filters: ReactNode;
}) {
  const navigate = useNavigate();
  const pagination = useCursor();
  const [search] = useSearchParams();
  const provider = search.get("provider_account_key") || undefined;
  const fields =
    section === "conflicts"
      ? CONFLICT_SORT_FIELDS
      : EXCEPTION_SORT_FIELDS;
  const listQuery = useListQuery<string>(fields, "created_at", "desc");
  const sortNames: Record<string, string> = {
    created_at: "发现时间",
    external_event_id: "支付宝流水号",
  };
  const query = useQuery({
    ...retainListData(["reconciliation", section, status, provider], listQuery.query),
    queryKey: [
      "reconciliation",
      section,
      status,
      pagination.cursor,
      listQuery.scope,
      provider,
    ],
    queryFn: async ({ signal }) => {
      const pageQuery = {
        limit: 20,
        ...(listQuery.query.q ? { q: listQuery.query.q } : {}),
        sort_order: listQuery.query.sortOrder,
        ...(pagination.cursor ? { cursor: pagination.cursor } : {}),
      };
      if (section === "conflicts") {
        const page = await result(
          api.listLedgerConflicts({
            signal,
            query: {
              ...pageQuery,
              sort_by: listQuery.query
                .sortBy as (typeof CONFLICT_SORT_FIELDS)[number],
              ...(provider ? { provider_account_key: provider } : {}),
              status: status as "OPEN" | "RESOLVED" | "IGNORED" | "ALL",
            },
          }),
        );
        return {
          page: page.page,
          items: page.data.map((item) => ({
            id: item.conflict_id,
            title: label(item.conflict_type),
            merchantOrderNo: null,
            externalEventId: item.external_event_id,
            orderId: null,
            rawPageId: item.raw_page_id,
            reminderIgnored: item.reminder_ignored,
            status: item.status,
            createdAt: item.created_at,
            context: item.context ?? null,
          })),
        };
      }
      if (section === "exceptions") {
        const page = await result(
          api.listOpenFinancialExceptions({
            signal,
            query: {
              ...pageQuery,
              sort_by: "created_at",
              ...(provider ? { provider_account_key: provider } : {}),
            },
          }),
        );
        return {
          page: page.page,
          items: page.data.map((item) => ({
            id: item.exception_id,
            title: label(item.exception_type),
            merchantOrderNo: null,
            externalEventId: null,
            orderId: item.order_id,
            rawPageId: null,
            reminderIgnored: item.reminder_ignored,
            status: item.status,
            createdAt: item.created_at,
            context: item.context ?? null,
          })),
        };
      }
      throw new Error("对账分类无效。");
    },
  });
  const columns: BusinessColumn<ReconciliationRow>[] = [
    {
      id: "identity",
      label: "记录",
      hideable: false,
      layout: "identity",
      summaryDefault: true,
      cell: (item, context) => (
        <ListIdentity
          meta={(context.showInSummary("order") ||
            (section !== "conflicts" && item.externalEventId)) && (
            <ListMeta>
              {context.showInSummary("order") && <RelatedRecord item={item} />}
              {section !== "conflicts" && item.externalEventId && (
                <span className="list-code" title={item.externalEventId}>支付宝流水号 {item.externalEventId}</span>
              )}
            </ListMeta>
          )}
          description={(
            context.showInSummary("created_at") ||
            (section === "conflicts" && context.showInSummary("external_event_id"))
          ) && (
            <ListMeta>
              {context.showInSummary("created_at") && <ListDateTime value={item.createdAt} inline />}
              {section === "conflicts" && context.showInSummary("external_event_id") && (
                <span className="list-code" title={item.externalEventId ?? undefined}>
                  支付宝流水号 {item.externalEventId ?? "—"}
                </span>
              )}
            </ListMeta>
          )}
        >
          <Link
            data-row-link
            className="list-primary-link"
            title={item.title}
            to={"/reconciliation/" + section + "/" + item.id}
          >
            {item.title}
          </Link>
        </ListIdentity>
      ),
    },
    {
      id: "order",
      label: "关联记录",
      layout: "text",
      summaryDefault: true,
      responsive: { minWidthRem: 70, basis: "container" },
      cell: (item) => <RelatedRecord item={item} />,
    },
    {
      id: "status",
      label: "PerPay 处理状态",
      align: "center",
      layout: "status",
      summaryDefault: true,
      cell: (item) => (
        <div className="business-cell-stack flex flex-col items-start gap-1.5">
          <StatusBadge value={item.status} label={item.status === "OPEN" ? "待处理" : undefined} />
          {item.reminderIgnored && <span className="text-xs text-muted-foreground">提醒已忽略</span>}
        </div>
      ),
    },
    ...(section === "conflicts" ? [{
      id: "external_event_id",
      sortBy: "external_event_id",
      label: "支付宝流水号",
      layout: "text" as const,
      summaryDefault: true,
      responsive: { minWidthRem: 50, basis: "container" as const },
      cell: (item: ReconciliationRow) => (
        <span className="list-code" title={item.externalEventId ?? undefined}>{item.externalEventId ?? "—"}</span>
      ),
    }] : []),
    {
      id: "created_at",
      sortBy: "created_at",
      label: "发现时间",
      align: "center",
      layout: "datetime",
      summaryDefault: true,
      responsive: { minWidthRem: 46, basis: "container" },
      cell: (item) => <ListDateTime value={item.createdAt} />,
    },
  ];

  return (
    <ListColumnsProvider>
    <div className="flex flex-col gap-3">
      <ListToolbarPart>
      <ListQueryToolbar
        control={listQuery}
        label="对账关键词搜索"
        desktopFilters={filters}
        desktopActions={
          <>
            <Link
                className={buttonVariants({ variant: "ghost", size: "sm" })}
                to={
                  "/work-items?type=" +
                  (section === "exceptions"
                    ? "FINANCIAL_EXCEPTION"
                    : "LEDGER_CONFLICT") +
                  "&visibility=IGNORED"
                }
              >
                查看已忽略
            </Link>
            <Button
              variant="ghost"
              size="icon"
              aria-label="刷新"
              disabled={query.isFetching}
              onClick={() => {
                void query.refetch();
              }}
            >
              {query.isFetching ? (
                <Spinner aria-hidden="true" />
              ) : (
                <RefreshCw />
              )}
            </Button>
          </>
        }
        filters={mobileFilters}
        lookup={{
          modes: [
            {
              value: "ledger",
              label: "内部流水编号（PerPay）",
              placeholder: "输入完整的 PerPay 内部流水编号",
              pattern: resourceIdPattern.source,
            },
          ],
          inputLabel: "内部流水编号（PerPay）",
          inputName: "ledger-lookup",
          onSubmit: (_mode, value) => {
            if (resourceIdPattern.test(value))
              navigate("/reconciliation/ledger/" + value);
          },
        }}
        mobileActions={
          <ListActionsMenu label="更多对账操作">
            {(trigger) => (
              <>
                <DropdownMenuItem onClick={() => onManual(trigger.current)}>
                  <Link2 />
                  人工关联收款
                </DropdownMenuItem>
                <DropdownMenuItem
                    render={
                      <Link
                        to={
                          "/work-items?type=" +
                          (section === "exceptions"
                            ? "FINANCIAL_EXCEPTION"
                            : "LEDGER_CONFLICT") +
                          "&visibility=IGNORED"
                        }
                      />
                    }
                  >
                    <EyeOff />
                    查看已忽略
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={query.isFetching}
                  onClick={() => {
                    void query.refetch();
                  }}
                >
                  <RefreshCw />
                  刷新
                </DropdownMenuItem>
              </>
            )}
          </ListActionsMenu>
        }
        sorts={fields.map((value) => ({ value, label: sortNames[value]! }))}
      />
      </ListToolbarPart>
      <QueryView query={query}>
        {(page) => (
          <>
            <div className="min-w-0" aria-busy={query.isFetching || query.isPlaceholderData}>
              {page.items.length ? (
                <BusinessTable
                  id={"reconciliation-" + section}
                  aria-label={sections.find((item) => item.value === section)?.label}
                  items={page.items}
                  rowId={(item) => item.id}
                  control={listQuery}
                  columns={columns}
                  renderSummary={(item, context) => (
                    <ListSummary
                      identity={columns[0]!.cell(item, context)}
                      details={columns.filter((column) =>
                        context.isColumnVisible(column.id) && !context.isSummaryPrimary(column.id),
                      ).map((column) => (
                        <ListSummaryField key={column.id} label={column.label}>
                          {column.cell(item, context)}
                        </ListSummaryField>
                      ))}
                    >
                      {columns.filter((column) =>
                        column.id !== "identity" &&
                        context.isSummaryPrimary(column.id),
                      ).map((column) => (
                        <ListSummaryField key={column.id} label={column.label}>
                          {column.cell(item, context)}
                        </ListSummaryField>
                      ))}
                    </ListSummary>
                  )}
                />
              ) : (
                <Empty kind="filtered">
                  <EmptyHeader>
                    <EmptyTitle role="heading" aria-level={2}>
                      暂无符合条件的记录
                    </EmptyTitle>
                  </EmptyHeader>
                </Empty>
              )}
            </div>
            <CursorPagination
              previousLabel={pagination.previousLabel}
              page={pagination.page}
              count={page.items.length}
              hasNext={!!page.page.next_cursor}
              pending={query.isFetching || query.isPlaceholderData}
              onPrevious={pagination.previous}
              onNext={() => pagination.next(page.page.next_cursor)}
            />
          </>
        )}
      </QueryView>
    </div>
    </ListColumnsProvider>
  );
}
