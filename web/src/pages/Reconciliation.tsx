import {
  useListQuery,
  MATCH_SORT_FIELDS,
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
  ListMoney,
  ListSummary,
  ListSummaryField,
} from "@/components/list-primitives";
import { useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Link2, EyeOff } from "lucide-react";
import { useSearchParams } from "react-router";
import { Link, useNavigate } from "@/navigation";
import { api, result } from "@/api/client";
import { useCursor } from "@/lib/cursor";
import { resourceIdPattern } from "@/lib/format";
import { label } from "@/lib/labels";
import { StatusBadge } from "@/components/business-status";
import { QueryView } from "@/components/request-state";
import { retainListData } from "@/lib/list-placeholder";
import { CursorPagination } from "@/components/cursor-pagination";
import { SuccessMessage, useFeedback } from "@/components/Feedback";
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
type Section = "matches" | "conflicts" | "exceptions";
type ReconciliationRow = {
  id: string;
  title: string;
  merchantOrderNo: string | null;
  externalEventId: string | null;
  amountCents: number | null;
  orderId: string | null;
  reminderIgnored: boolean;
  status: string;
  createdAt: string;
};
const sections = [
  { value: "matches", label: "支付关联" },
  { value: "exceptions", label: "账务异常" },
  { value: "conflicts", label: "账本冲突" },
];
const statusNames: Record<string, string> = {
  SETTLED: "已关联",
  REVERSED: "已撤销",
  OPEN: "未忽略",
  RESOLVED: "已处理",
  IGNORED: "已隔离",
  ALL: "全部记录",
};
export default function Reconciliation() {
  const compact = useCompactList();
  const operationTrigger = useRef<HTMLButtonElement | null>(null);
  function showOperation(trigger: HTMLButtonElement | null) {
    operationTrigger.current = trigger;
    setOperation(true);
  }
  const [search, setSearch] = useSearchParams();
  const [operation, setOperation] = useState(false);
  const [completed, setCompleted] = useFeedback();
  const section: Section =
    search.get("tab") === "conflicts"
      ? "conflicts"
      : search.get("tab") === "exceptions"
        ? "exceptions"
        : "matches";
  const allowed =
    section === "matches"
      ? ["SETTLED", "REVERSED"]
      : ["OPEN", "RESOLVED", "IGNORED", "ALL"];
  const status = allowed.includes(search.get("status") ?? "")
    ? search.get("status")!
    : allowed[0]!;
  const statuses = allowed.map((value) => ({
    value,
    label: statusNames[value] ?? value,
  }));
  return (
    <>
      <Tabs
        value={section}
        className="w-full min-w-0 gap-3"
        data-business-list="reconciliation"
        onValueChange={(value) =>
          setSearch(
            (current) => {
              const next = new URLSearchParams(current);
              next.set("tab", String(value));
              ["status", "cursor", "page", "sort_by", "sort_order"].forEach(
                (key) => next.delete(key),
              );
              return next;
            },
            { replace: true },
          )
        }
      >
        <div className="flex min-w-0 items-center justify-between gap-4">
          <div className="-m-1 min-w-0 scroll-p-1 overflow-x-auto p-1">
            <TabsList aria-label="对账记录类型">
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
        <TabsContent value={section}>
          <ReconciliationList
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
            message={completed}
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
          />
        </TabsContent>
      </Tabs>
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
  message,
}: {
  onManual: (trigger: HTMLButtonElement | null) => void;
  mobileFilters: readonly ListFilter[];
  section: Section;
  status: string;
  filters: ReactNode;
  message: string;
}) {
  const navigate = useNavigate();
  const pagination = useCursor();
  const [search] = useSearchParams();
  const provider = search.get("provider_account_key") || undefined;
  const fields =
    section === "matches"
      ? MATCH_SORT_FIELDS
      : section === "conflicts"
        ? CONFLICT_SORT_FIELDS
        : EXCEPTION_SORT_FIELDS;
  const listQuery = useListQuery<string>(fields, "created_at", "desc");
  const sortNames: Record<string, string> = {
    event_sequence: "关联事件顺序",
    created_at: section === "matches" ? "关联时间" : "发现时间",
    amount_cents: "流水金额",
    external_event_id: "外部流水号",
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
            amountCents: null,
            orderId: null,
            reminderIgnored: item.reminder_ignored,
            status: item.status,
            createdAt: item.created_at,
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
            amountCents: null,
            orderId: item.order_id,
            reminderIgnored: item.reminder_ignored,
            status: item.status,
            createdAt: item.created_at,
          })),
        };
      }
      const page = await result(
        api.listPaymentMatches({
          signal,
          query: {
            ...pageQuery,
            sort_by: listQuery.query
              .sortBy as (typeof MATCH_SORT_FIELDS)[number],
            status: status as "SETTLED" | "REVERSED",
          },
        }),
      );
      return {
        page: page.page,
        items: page.data.map((item) => ({
          id: item.payment_match_id,
          title: item.order?.product_name ?? (item.evidence_type === "MANUAL" ? "人工关联" : "金额推断关联"),
          merchantOrderNo: item.order?.merchant_order_no ?? null,
          externalEventId: item.ledger_entry.external_event_id,
          amountCents: item.ledger_entry.amount_cents,
          orderId: item.order_id,
          reminderIgnored: false,
          status: item.status,
          createdAt: item.created_at,
        })),
      };
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
          meta={(item.merchantOrderNo || (section !== "conflicts" && item.externalEventId)) && (
            <ListMeta>
              {item.merchantOrderNo && (
                <span className="list-code" title={item.merchantOrderNo}>{item.merchantOrderNo}</span>
              )}
              {section !== "conflicts" && item.externalEventId && (
                <span className="list-code" title={item.externalEventId}>流水 {item.externalEventId}</span>
              )}
            </ListMeta>
          )}
          description={(
            context.showInSummary("created_at") ||
            (section === "conflicts" && context.showInSummary("external_event_id")) ||
            (item.amountCents !== null && context.showInSummary("amount_cents"))
          ) && (
            <ListMeta>
              {context.showInSummary("created_at") && <ListDateTime value={item.createdAt} inline />}
              {section === "conflicts" && context.showInSummary("external_event_id") && (
                <span className="list-code" title={item.externalEventId ?? undefined}>
                  流水 {item.externalEventId ?? "—"}
                </span>
              )}
              {item.amountCents !== null && context.showInSummary("amount_cents") && (
                <span>流水 <ListMoney value={item.amountCents} secondary /></span>
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
      label: "关联订单",
      layout: "text",
      summaryDefault: false,
      responsive: { minWidthRem: 70, basis: "container" },
      cell: (item) => item.orderId ? (
        <Link className="list-secondary-link" to={"/orders/" + item.orderId}>
          查看订单
        </Link>
      ) : "—",
    },
    {
      id: "status",
      label: "状态",
      align: "center",
      layout: "status",
      summaryDefault: true,
      cell: (item) => (
        <div className="business-cell-stack flex flex-col items-start gap-1.5">
          <StatusBadge value={item.status} label={item.status === "OPEN" ? "未处理" : undefined} />
          {item.reminderIgnored && <span className="text-xs text-muted-foreground">提醒已忽略</span>}
        </div>
      ),
    },
    ...(section === "matches" ? [{
      id: "amount_cents",
      sortBy: "amount_cents",
      label: "流水金额",
      align: "center" as const,
      layout: "amount" as const,
      summaryDefault: true,
      responsive: { minWidthRem: 40, basis: "container" as const },
      cell: (item: ReconciliationRow) => <ListMoney value={item.amountCents} />,
    }] : []),
    ...(section === "conflicts" ? [{
      id: "external_event_id",
      sortBy: "external_event_id",
      label: "外部流水号",
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
      label: section === "matches" ? "关联时间" : "发现时间",
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
      <ListQueryToolbar
        control={listQuery}
        label="对账关键词搜索"
        desktopFilters={filters}
        desktopActions={
          <>
            {section !== "matches" && (
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
            )}
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
              label: "流水编号",
              placeholder: "输入完整流水编号",
              pattern: resourceIdPattern.source,
            },
          ],
          inputLabel: "账本流水编号",
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
                {section !== "matches" && (
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
                )}
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
      <SuccessMessage message={message} />
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
                      aside={context.isColumnVisible("amount_cents") && (
                        <div className="flex flex-col items-end gap-1">
                          <span className="text-xs text-muted-foreground">流水金额</span>
                          <ListMoney value={item.amountCents} />
                        </div>
                      )}
                    >
                      {columns.filter((column) =>
                        column.id !== "identity" &&
                        column.id !== "amount_cents" &&
                        context.isColumnVisible(column.id),
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
