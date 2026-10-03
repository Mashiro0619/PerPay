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
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useCompactList } from "@/hooks/use-compact-list";
import { BusinessTable } from "@/components/business-table";
import { useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Link2, EyeOff } from "lucide-react";
import { useSearchParams } from "react-router";
import { Link, useNavigate } from "@/navigation";
import { api, result } from "@/api/client";
import { useCursor } from "@/lib/cursor";
import { dateTime, money, resourceIdPattern } from "@/lib/format";
import { label } from "@/lib/labels";
import { StatusBadge } from "@/components/business-status";
import { QueryView } from "@/components/request-state";
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
          title: item.order ? item.order.product_name + " · " + item.order.merchant_order_no : item.evidence_type === "MANUAL" ? "人工关联" : "金额推断关联",
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

  return (
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
            <div className="min-w-0">
              {page.items.length ? (
                <BusinessTable
                  id={"reconciliation-" + section}
                  items={page.items}
                  rowId={(item) => item.id}
                  control={listQuery}
                  columns={[
                    {
                      id: "identity",
                      label: "记录",
                      hideable: false,
                      className: "min-w-0 max-w-md whitespace-normal py-2",
                      cell: (item, context) => (
                        <div className="flex flex-col gap-1">
                          <Link
                            data-row-link
                            className="font-medium hover:underline"
                            to={"/reconciliation/" + section + "/" + item.id}
                          >
                            {item.title}
                          </Link>
                          <span className="break-all text-xs text-muted-foreground">
                            {item.externalEventId ?? "查看记录详情"}
                          </span>
                          {context.showInSummary("created_at") && (
                            <time
                              className="text-xs text-muted-foreground"
                              dateTime={item.createdAt}
                            >
                              {dateTime(item.createdAt)}
                            </time>
                          )}
                          {item.amountCents !== null &&
                            context.showInSummary("amount_cents") && (
                              <span className="text-xs tabular-nums text-muted-foreground">
                                流水 {money(item.amountCents)}
                              </span>
                            )}
                        </div>
                      ),
                    },
                    {
                      id: "order",
                      label: "关联订单",
                      className: "max-w-sm whitespace-normal",
                      responsive: {
                        minWidthRem: 48,
                        basis: "container" as const,
                      },
                      cell: (item) =>
                        item.orderId ? (
                          <Link
                            className="break-all underline underline-offset-4"
                            to={"/orders/" + item.orderId}
                          >
                            查看订单
                          </Link>
                        ) : (
                          "—"
                        ),
                    },
                    {
                      id: "status",
                      label: "状态",
                      cell: (item) => (
                        <div className="flex flex-col gap-1">
                          <StatusBadge
                            value={item.status}
                            label={
                              item.status === "OPEN" ? "未处理" : undefined
                            }
                          />
                          {item.reminderIgnored && (
                            <span className="text-xs text-muted-foreground">
                              提醒已忽略
                            </span>
                          )}
                        </div>
                      ),
                    },
                    ...(section === "matches"
                      ? [
                          {
                            id: "amount_cents",
                            sortBy: "amount_cents",
                            label: "流水金额",
                            align: "right" as const,
                            responsive: {
                              minWidthRem: 40,
                              basis: "container" as const,
                            },
                            cell: (item: (typeof page.items)[number]) =>
                              money(item.amountCents),
                          },
                        ]
                      : []),
                    ...(section === "conflicts"
                      ? [
                          {
                            id: "external_event_id",
                            sortBy: "external_event_id",
                            label: "外部流水号",
                            className: "max-w-56 whitespace-normal break-all",
                            responsive: {
                              minWidthRem: 48,
                              basis: "container" as const,
                            },
                            cell: (item: (typeof page.items)[number]) =>
                              item.externalEventId ?? "—",
                          },
                        ]
                      : []),
                    {
                      id: "created_at",
                      sortBy: "created_at",
                      label: section === "matches" ? "关联时间" : "发现时间",
                      responsive: {
                        minWidthRem: 40,
                        basis: "container" as const,
                      },
                      cell: (item) => dateTime(item.createdAt),
                    },
                  ]}
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
              pending={query.isFetching}
              onPrevious={pagination.previous}
              onNext={() => pagination.next(page.page.next_cursor)}
            />
          </>
        )}
      </QueryView>
    </div>
  );
}
