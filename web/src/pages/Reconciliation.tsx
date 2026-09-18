import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Search } from "lucide-react";
import { useSearchParams } from "react-router";
import { Link, useNavigate } from "@/navigation";
import { api, result } from "@/api/client";
import { useCursor } from "@/lib/cursor";
import { dateTime, resourceIdPattern, shortId } from "@/lib/format";
import { label } from "@/lib/labels";
import { LinkedTableRow } from "@/components/LinkedTableRow";
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
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
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
          setSearch({ tab: String(value) }, { replace: true })
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
                        { tab: section, status: value },
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
  const query = useQuery({
    queryKey: ["reconciliation", section, status, pagination.cursor],
    queryFn: async ({ signal }) => {
      const pageQuery = {
        limit: 20,
        ...(pagination.cursor ? { cursor: pagination.cursor } : {}),
      };
      if (section === "conflicts") {
        const page = await result(
          api.listLedgerConflicts({
            signal,
            query: {
              ...pageQuery,
              status: status as "OPEN" | "RESOLVED" | "IGNORED" | "ALL",
            },
          }),
        );
        return {
          page: page.page,
          items: page.data.map((item) => ({
            id: item.conflict_id,
            title: label(item.conflict_type),
            orderId: null,
            reminderIgnored: item.reminder_ignored,
            status: item.status,
            createdAt: item.created_at,
          })),
        };
      }
      if (section === "exceptions") {
        const page = await result(
          api.listOpenFinancialExceptions({ signal, query: pageQuery }),
        );
        return {
          page: page.page,
          items: page.data.map((item) => ({
            id: item.exception_id,
            title: label(item.exception_type),
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
          query: { ...pageQuery, status: status as "SETTLED" | "REVERSED" },
        }),
      );
      return {
        page: page.page,
        items: page.data.map((item) => ({
          id: item.payment_match_id,
          title: item.evidence_type === "MANUAL" ? "人工关联" : "金额推断关联",
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
      <SuccessMessage message={message} />
      <QueryView query={query}>
        {(page) => (
          <>
            <div className="overflow-hidden rounded-lg border">
              {page.items.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>记录</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className="hidden md:table-cell">
                        关联订单
                      </TableHead>
                      <TableHead className="hidden sm:table-cell">
                        创建时间
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {page.items.map((item) => (
                      <LinkedTableRow key={item.id}>
                        <TableCell className="w-full max-w-md whitespace-normal py-3">
                          <div className="flex flex-col gap-1">
                            <Link
                              data-row-link
                              className="font-medium hover:underline"
                              to={"/reconciliation/" + section + "/" + item.id}
                            >
                              {item.title}
                            </Link>
                            <time
                              className="text-xs text-muted-foreground sm:hidden"
                              dateTime={item.createdAt}
                            >
                              {dateTime(item.createdAt)}
                            </time>
                          </div>
                        </TableCell>
                        <TableCell>
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
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          {item.orderId ? (
                            <Link
                              className="underline underline-offset-4"
                              to={"/orders/" + item.orderId}
                            >
                              {shortId(item.orderId)}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground sm:table-cell">
                          {dateTime(item.createdAt)}
                        </TableCell>
                      </LinkedTableRow>
                    ))}
                  </TableBody>
                </Table>
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
