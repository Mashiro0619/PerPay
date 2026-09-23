import { useListQuery, WORK_ITEM_SORT_FIELDS } from "@/lib/list-query";
import { ListQueryToolbar } from "@/components/list-query-toolbar";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useLocation, useSearchParams } from "react-router";
import {
  api,
  refreshOperationalData,
  result,
  type AdminWorkItem,
  type AdminWorkItemTypeFilter,
} from "@/api/client";
import {
  useReminderRestores,
  needsReminderRefresh,
  type ReminderRestoreState,
} from "@/lib/reminder-restore-requests";
import { restoreMessages, type RestoreOutcome } from "@/lib/reminder-restore";
import { useCursor } from "@/lib/cursor";
import { WorkItemsTable } from "@/components/work-items-table";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { CursorPagination } from "@/components/cursor-pagination";
import { SuccessMessage, useFeedback } from "@/components/Feedback";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
} from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
const filters = [
  ["ALL", "全部事项"],
  ["FINANCIAL_EXCEPTION", "账务异常"],
  ["LEDGER_CONFLICT", "账本冲突"],
  ["NOTIFICATION_FAILURE", "通知失败"],
] as const;
type Visibility = "ACTIVE" | "IGNORED";
export default function WorkItems() {
  const mounted = useMounted();
  const [search, setSearch] = useSearchParams();
  const type =
    filters.find(([value]) => value === search.get("type"))?.[0] ?? "ALL";
  const visibility: Visibility =
    search.get("visibility") === "IGNORED" ? "IGNORED" : "ACTIVE";
  const [batch, setBatch] = useState<{
    type: AdminWorkItemTypeFilter;
    name: string;
    q: string;
    operation_id: string;
  } | null>(null);
  const finalFocus = useRef<HTMLElement | null>(null);
  const [message, setMessage] = useFeedback();
  const ignore = useMutation({
    mutationFn: (input: NonNullable<typeof batch>) =>
      result(
        api.ignoreAllAdministratorWorkItems({
          body: {
            operation_id: input.operation_id,
            type: input.type,
            ...(input.q ? { q: input.q } : {}),
          },
        }),
      ),
    onSuccess: ({ data }, input) => {
      void refreshOperationalData();
      if (!mounted.current) return;
      setBatch(null);
      setMessage(
        "已忽略“" +
          input.name +
          "”" +
          (input.q ? "关键词“" + input.q + "”" : "") +
          "中的 " +
          data.ignored_count +
          " 条提醒。",
      );
      setSearch(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete("cursor");
          next.delete("page");
          return next;
        },
        { replace: true },
      );
    },
  });
  function select(
    nextType: AdminWorkItemTypeFilter,
    nextVisibility: Visibility,
  ) {
    setSearch(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("type", nextType);
        if (nextVisibility === "IGNORED")
          next.set("visibility", nextVisibility);
        else next.delete("visibility");
        if (
          nextVisibility !== "IGNORED" &&
          next.get("sort_by") === "ignored_at"
        ) {
          next.delete("sort_by");
          next.delete("sort_order");
        }
        next.delete("cursor");
        next.delete("page");
        return next;
      },
      { replace: true },
    );
    setMessage("");
  }
  return (
    <>
      <Tabs
        value={type}
        onValueChange={(value) =>
          select(value as AdminWorkItemTypeFilter, visibility)
        }
        className="gap-4"
      >
        <div className="overflow-x-auto">
          <TabsList aria-label="待处理类型">
            {filters.map(([value, name]) => (
              <TabsTrigger
                key={value}
                value={value}
                disabled={ignore.isPending}
              >
                {name}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value={type}>
          <WorkItemPage
            key={type + ":" + visibility}
            type={type}
            visibility={visibility}
            busy={ignore.isPending}
            message={message}
            onVisibility={(next) => select(type, next)}
            onIgnore={() => {
              finalFocus.current =
                document.activeElement instanceof HTMLElement
                  ? document.activeElement
                  : null;
              ignore.reset();
              setBatch({
                type,
                q: (search.get("q") ?? "").trim(),
                name: filters.find(([value]) => value === type)![1],
                operation_id: crypto.randomUUID(),
              });
            }}
          />
        </TabsContent>
      </Tabs>
      <AlertDialog
        open={!!batch}
        onOpenChange={(open, event) => {
          if (!open) {
            if (ignore.isPending) event.cancel();
            else setBatch(null);
          }
        }}
      >
        <AlertDialogContent
          finalFocus={() => finalFocus.current}
          className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              忽略当前筛选结果 · {batch?.name}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {batch?.q ? (
                <>
                  关键词“{batch.q}
                  ”在此分类中的全部匹配项（跨分页），不影响其他提醒。
                </>
              ) : (
                <>此分类的全部匹配项（跨分页）。</>
              )}
              仅关闭提醒，不删除记录、不解决冲突，也不停止通知重试。重试不会追加忽略新增事项。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ErrorNotice error={ignore.error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={ignore.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={ignore.isPending}
              onClick={() => {
                if (batch && !ignore.isPending) ignore.mutate(batch);
              }}
            >
              {ignore.isPending && (
                <Spinner aria-hidden="true" data-icon="inline-start" />
              )}
              确认忽略当前筛选结果
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
function WorkItemPage({
  type,
  visibility,
  busy,
  message,
  onVisibility,
  onIgnore,
}: {
  type: AdminWorkItemTypeFilter;
  visibility: Visibility;
  busy: boolean;
  message: string;
  onVisibility: (value: Visibility) => void;
  onIgnore: () => void;
}) {
  const mounted = useMounted();
  const pagination = useCursor();
  const sortFields =
    visibility === "IGNORED"
      ? WORK_ITEM_SORT_FIELDS
      : WORK_ITEM_SORT_FIELDS.filter((field) => field !== "ignored_at");
  const listQuery = useListQuery(
    sortFields,
    visibility === "IGNORED" ? "ignored_at" : "actionable_at",
    "desc",
  );
  const list = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const locationKey = useRef(location.key);
  locationKey.current = location.key;
  const restores = useReminderRestores();
  type Position = {
    sequence: number;
    cursor: string | undefined;
    waitingFrom?: string;
    locationKey: string;
    id: string;
    neighbors: string[];
    index: number;
    trigger: HTMLElement;
    focus: boolean;
    completed: boolean;
  };
  const latestAction = useRef<Position | null>(null);
  const focusing = useRef(false);
  const [position, setPosition] = useState<Position | null>(null);
  useEffect(() => {
    const moved = (event: Event) => {
      const action = latestAction.current;
      if (action && !focusing.current && event.target !== action.trigger)
        action.focus = false;
    };
    document.addEventListener("focusin", moved);
    document.addEventListener("pointerdown", moved);
    return () => {
      document.removeEventListener("focusin", moved);
      document.removeEventListener("pointerdown", moved);
    };
  }, []);
  const work = useQuery({
    queryKey: [
      "work-items",
      type,
      visibility,
      pagination.cursor,
      listQuery.scope,
    ],
    queryFn: ({ signal }) =>
      result(
        api.listAdministratorWorkItems({
          signal,
          query: {
            type,
            visibility,
            limit: 20,
            ...listQuery.apiQuery,
            ...(pagination.cursor ? { cursor: pagination.cursor } : {}),
          },
        }),
      ),
  });
  const [restoredMessage, setRestoredMessage] = useFeedback();
  function restore(item: AdminWorkItem, trigger: HTMLElement) {
    if (item.ended || restores.get(item)?.status === "pending") return;
    const id = item.type + ":" + item.resource_id;
    const ids =
      work.data?.data.map(
        (candidate) => candidate.type + ":" + candidate.resource_id,
      ) ?? [];
    const index = Math.max(0, ids.indexOf(id));
    const action: Position = {
      sequence: (latestAction.current?.sequence ?? 0) + 1,
      completed: false,
      cursor: pagination.cursor,
      locationKey: location.key,
      id,
      index,
      neighbors: [...ids.slice(index + 1), ...ids.slice(0, index).reverse()],
      trigger,
      focus:
        document.activeElement === trigger ||
        document.activeElement === document.body,
    };
    const completed = async (outcome: RestoreOutcome | "refresh") => {
      action.completed = true;
      await refreshOperationalData();
      if (!mounted.current) return;
      const latest = latestAction.current;
      if (!latest?.completed || locationKey.current !== latest.locationKey)
        return;
      if (latest === action && outcome !== "refresh")
        setRestoredMessage(restoreMessages[outcome]);
      setPosition({ ...latest });
    };
    const readAgain = needsReminderRefresh(restores.get(item));
    if (
      !readAgain &&
      !restores.submit(item, (outcome) => {
        void completed(outcome);
      })
    )
      return;
    latestAction.current = action;
    setPosition(null);
    setRestoredMessage("");
    if (readAgain) void completed("refresh");
  }
  useEffect(() => {
    if (!position || work.isFetching) return;
    if (latestAction.current?.sequence !== position.sequence) {
      setPosition(null);
      return;
    }
    if (
      position.cursor !== pagination.cursor &&
      position.waitingFrom !== undefined &&
      position.waitingFrom === pagination.cursor
    )
      return;
    if (position.cursor !== pagination.cursor || work.isError || !work.data) {
      setPosition(null);
      return;
    }
    if (work.data.data.length === 0 && pagination.page > 1) {
      const cursor = pagination.replacePrevious();
      setPosition({
        ...position,
        cursor,
        waitingFrom: pagination.cursor,
        index: Number.MAX_SAFE_INTEGER,
        neighbors: [],
      });
      return;
    }
    // Returning from an action should not undo the user's subsequent navigation or focus.
    const active = document.activeElement;
    if (
      latestAction.current?.focus &&
      (active === position.trigger ||
        active === document.body ||
        !active?.isConnected)
    ) {
      const rows = [
        ...(list.current?.querySelectorAll<HTMLTableRowElement>("tbody tr") ??
          []),
      ];
      const same = rows.find(
        (row) =>
          row
            .querySelector("[data-reminder-id]")
            ?.getAttribute("data-reminder-id") === position.id,
      );
      const neighbor = position.neighbors
        .map((id) =>
          rows.find(
            (row) =>
              row
                .querySelector("[data-reminder-id]")
                ?.getAttribute("data-reminder-id") === id,
          ),
        )
        .find(
          (row) =>
            row &&
            !row.querySelector(
              "button[data-reminder-restore]:disabled:not([data-reminder-ended])",
            ),
        );
      const row =
        same ??
        neighbor ??
        (position.neighbors.length === 0
          ? rows[Math.min(position.index, rows.length - 1)]
          : undefined);
      const target =
        row?.querySelector<HTMLElement>(
          "button[data-reminder-restore]:not(:disabled)",
        ) ??
        row?.querySelector<HTMLElement>("[data-row-link]") ??
        list.current;
      if (target) {
        focusing.current = true;
        latestAction.current!.trigger = target;
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "nearest" });
        focusing.current = false;
      }
    }
    setPosition(null);
  }, [position, work.data, work.isFetching, work.isError, pagination]);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          variant="outline"
          value={[visibility]}
          disabled={busy}
          onValueChange={(value) => {
            if (value[0]) onVisibility(value[0] as Visibility);
          }}
          aria-label="提醒可见性"
        >
          <ToggleGroupItem value="ACTIVE">未忽略</ToggleGroupItem>
          <ToggleGroupItem value="IGNORED">已忽略</ToggleGroupItem>
        </ToggleGroup>
        <div className="flex items-center gap-2">
          {visibility === "ACTIVE" && (
            <Button
              variant="outline"
              disabled={
                busy ||
                work.isPending ||
                work.isError ||
                (!work.data?.data.length && pagination.page === 1)
              }
              onClick={onIgnore}
            >
              忽略当前筛选结果
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新"
            disabled={busy || work.isFetching}
            onClick={() => {
              void work.refetch();
            }}
          >
            {work.isFetching ? <Spinner aria-hidden="true" /> : <RefreshCw />}
          </Button>
        </div>
      </div>
      <ListQueryToolbar
        control={listQuery}
        label="提醒关键词搜索"
        disabled={busy}
        sorts={sortFields.map((value) => ({
          value,
          label: {
            actionable_at: "提醒时间",
            created_at: "创建时间",
            ignored_at: "忽略时间",
          }[value],
        }))}
      />
      <SuccessMessage message={message || restoredMessage} />
      {restores.pendingCount > 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {restores.pendingCount} 条提醒正在恢复…
        </p>
      )}
      <QueryView query={work}>
        {(page) => (
          <>
            <div
              ref={list}
              tabIndex={-1}
              role="region"
              aria-label={
                visibility === "IGNORED" ? "已忽略提醒列表" : "待处理提醒列表"
              }
              className="min-w-0 outline-none"
            >
              <WorkItemsTable
                items={page.data}
                control={listQuery}
                emptyTitle={
                  listQuery.query.q
                    ? "没有符合条件的提醒"
                    : visibility === "IGNORED"
                      ? "暂无已忽略提醒"
                      : undefined
                }
                actions={
                  visibility === "IGNORED"
                    ? (item) => (
                        <RestoreReminder
                          key={item.ignored_at}
                          item={item}
                          state={restores.get(item)}
                          onRestore={(trigger) => restore(item, trigger)}
                        />
                      )
                    : undefined
                }
              />
            </div>
            <CursorPagination
              previousLabel={pagination.previousLabel}
              page={pagination.page}
              count={page.data.length}
              hasNext={!!page.page.next_cursor}
              pending={work.isFetching || busy}
              onPrevious={pagination.previous}
              onNext={() => pagination.next(page.page.next_cursor)}
            />
          </>
        )}
      </QueryView>
    </div>
  );
}
function RestoreReminder({
  item,
  state,
  onRestore,
}: {
  item: AdminWorkItem;
  state: ReminderRestoreState | undefined;
  onRestore: (trigger: HTMLElement) => void;
}) {
  const readAgain = needsReminderRefresh(state);
  const pending = state?.status === "pending";
  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        data-reminder-restore
        data-reminder-ended={item.ended || undefined}
        size="sm"
        variant="outline"
        disabled={item.ended || pending}
        onClick={(event) => onRestore(event.currentTarget)}
      >
        {pending && <Spinner aria-hidden="true" data-icon="inline-start" />}
        {item.ended
          ? "已结束"
          : readAgain
            ? "刷新列表"
            : state?.error
              ? "重试恢复"
              : "恢复提醒"}
      </Button>
      {!!state?.error && (
        <>
          <span role="status" className="sr-only">
            恢复结果暂未确认，请重试或查看响应详情。
          </span>
          <Popover>
            <PopoverTrigger render={<Button variant="ghost" size="sm" />}>
              响应详情
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] overflow-y-auto"
            >
              <PopoverHeader>
                <PopoverTitle>恢复提醒的响应</PopoverTitle>
                <PopoverDescription>
                  只调整提醒，不改变事项处理状态。
                </PopoverDescription>
              </PopoverHeader>
              <ErrorNotice error={state.error} />
            </PopoverContent>
          </Popover>
        </>
      )}
    </div>
  );
}
function useMounted() {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
