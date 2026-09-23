import {
  useListQuery,
  MATCH_SORT_FIELDS,
  CONFLICT_SORT_FIELDS,
  EXCEPTION_SORT_FIELDS,
} from "@/lib/list-query";
import { ListQueryToolbar } from "@/components/list-query-toolbar";
import { BusinessTable } from "@/components/business-table";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Search } from "lucide-react";
import { useSearchParams } from "react-router";
import { Link, useNavigate } from "@/navigation";
import { api, result } from "@/api/client";
import { useCursor } from "@/lib/cursor";
import { dateTime, money, resourceIdPattern, shortId } from "@/lib/format";
import { label } from "@/lib/labels";
import { StatusBadge } from "@/components/business-status";
import { QueryView } from "@/components/request-state";
import { CursorPagination } from "@/components/cursor-pagination";
import { SuccessMessage, useFeedback } from "@/components/Feedback";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
} from "@/components/ui/input-group";
import { FieldGroup } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
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
  const [search, setSearch] = useSearchParams();
  const [operation, setOperation] = useState(false);
  const [completed, setCompleted] = useFeedback();
  const [ledgerId, setLedgerId] = useState("");
  const navigate = useNavigate();
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
    label: statusNames[value],
  }));
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <form
          className="min-w-0 flex-1"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            if (resourceIdPattern.test(ledgerId.trim()))
              navigate("/reconciliation/ledger/" + ledgerId.trim());
          }}
        >
          <FieldGroup className="flex-row flex-wrap items-center gap-2">
            <InputGroup className="min-w-40 flex-1 md:max-w-sm">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="账本流水编号"
                name="ledger-lookup"
                required
                pattern={resourceIdPattern.source}
                value={ledgerId}
                onChange={(event) => setLedgerId(event.target.value)}
                placeholder="输入完整流水编号"
              />
            </InputGroup>
            <Button variant="outline" type="submit" disabled={!ledgerId.trim()}>
              查询流水
            </Button>
          </FieldGroup>
        </form>
        <Button onClick={() => setOperation(true)}>人工关联收款</Button>
      </div>
      <Tabs
        value={section}
        className="gap-4"
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
        <TabsList aria-label="对账记录类型">
          {sections.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={section}>
          <ReconciliationList
            key={section}
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
  section,
  status,
  filters,
  message,
}: {
  section: Section;
  status: string;
  filters: ReactNode;
  message: string;
}) {
  const pagination = useCursor();
  const [search] = useSearchParams();
  const provider = search.get("provider_account_key") || undefined;
  const fields =
    section === "matches"
      ? MATCH_SORT_FIELDS
      : section === "conflicts"
        ? CONFLICT_SORT_FIELDS
        : EXCEPTION_SORT_FIELDS;
  const listQuery = useListQuery<string>(fields, fields[0], "asc");
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
          title: item.evidence_type === "MANUAL" ? "人工关联" : "金额推断关联",
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {filters}
        <div className="ml-auto flex items-center gap-2">
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
            {query.isFetching ? <Spinner aria-hidden="true" /> : <RefreshCw />}
          </Button>
        </div>
      </div>
      <ListQueryToolbar
        control={listQuery}
        label="对账关键词搜索"
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
                      className: "w-full max-w-md whitespace-normal py-3",
                      cell: (item) => (
                        <div className="flex flex-col gap-1">
                          <Link
                            data-row-link
                            className="font-medium hover:underline"
                            to={"/reconciliation/" + section + "/" + item.id}
                          >
                            {item.title}
                          </Link>
                          <span className="text-xs text-muted-foreground">
                            {shortId(item.id)}
                          </span>
                          <time
                            className="text-xs text-muted-foreground sm:hidden"
                            dateTime={item.createdAt}
                          >
                            {dateTime(item.createdAt)}
                          </time>
                          {item.amountCents !== null && (
                            <span className="text-xs tabular-nums text-muted-foreground sm:hidden">
                              流水 {money(item.amountCents)}
                            </span>
                          )}
                        </div>
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
                    {
                      id: "order",
                      label: "关联订单",
                      className: "hidden md:table-cell",
                      cell: (item) =>
                        item.orderId ? (
                          <Link
                            className="underline underline-offset-4"
                            to={"/orders/" + item.orderId}
                          >
                            {shortId(item.orderId)}
                          </Link>
                        ) : (
                          "—"
                        ),
                    },
                    ...(section === "matches"
                      ? [
                          {
                            id: "amount_cents",
                            sortBy: "amount_cents",
                            label: "流水金额",
                            align: "right" as const,
                            className: "hidden sm:table-cell",
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
                            className:
                              "hidden max-w-56 whitespace-normal break-all md:table-cell",
                            cell: (item: (typeof page.items)[number]) =>
                              item.externalEventId ?? "—",
                          },
                        ]
                      : []),
                    {
                      id: "created_at",
                      sortBy: "created_at",
                      label: section === "matches" ? "关联时间" : "发现时间",
                      className: "hidden sm:table-cell",
                      cell: (item) => dateTime(item.createdAt),
                    },
                  ]}
                />
              ) : (
                <Empty>
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
