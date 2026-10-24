import { ListLayout, ListToolbarPart } from "@/components/list-layout";
import { useWorkspace } from "@/workspace";
import { useQuery } from '@/lib/workspace-query';
import { useWorkspaceApi } from "@/workspace";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { RefreshButton } from "@/components/refresh-button";
import { DialogBody } from "@/components/admin-dialog";
import { useListQuery } from "@/lib/list-query";
import { workItemFilters, workItemSortFields, workItemsQuery, type WorkItemVisibility } from "@/api/workspace-queries";
import { ListQueryToolbar } from "@/components/list-query-toolbar";
import { ListActionsMenu } from "@/components/list-actions-menu";
import { ListColumnsProvider } from "@/components/list-columns";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useEffect, useRef, useState } from "react";
import { onlineManager, useMutation } from '@tanstack/react-query';
import { RefreshCw, EyeOff } from "lucide-react";
import { useLocation, useSearchParams } from "react-router";
import { refreshOperationalData, result, type AdminWorkItem, type AdminWorkItemTypeFilter } from "@/api/client";
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
import { useSuccessToast } from "@/components/Feedback";
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
} from "@/components/admin-dialog";
const filters = [
  ["ALL", "全部提醒"],
  ["FINANCIAL_EXCEPTION", "账务异常"],
  ["LEDGER_CONFLICT", "账本冲突"],
  ["NOTIFICATION_FAILURE", "通知失败"],
] as const;
type Visibility = WorkItemVisibility;
export default function WorkItems() {
  const api = useWorkspaceApi();
  const { clientId: workspaceClientId, site } = useWorkspace();
  const mounted = useMounted();
  const [search, setSearch] = useSearchParams();
  const { type, visibility } = workItemFilters(search, workspaceClientId);
  const [batch, setBatch] = useState<{
    type: AdminWorkItemTypeFilter;
    name: string;
    q: string;
    operation_id: string;
    clientId: string | null;
    siteName: string | null;
  } | null>(null);
  const finalFocus = useRef<HTMLElement | null>(null);
  const cancelIgnore = useRef<HTMLButtonElement | null>(null);
  const setMessage = useSuccessToast();
  const ignore = useMutation({
    networkMode: "always",
    retry: false,
    mutationFn: (input: NonNullable<typeof batch>) => {
      if (!onlineManager.isOnline() || !navigator.onLine)
        throw new Error("网络已断开，忽略操作未提交。恢复连接后请重新提交。");
      return result(
        api.ignoreAllAdministratorWorkItems({
          body: {
            operation_id: input.operation_id,
            type: input.type,
            ...(input.clientId ? { api_client_id: input.clientId } : {}),
            ...(input.q ? { q: input.q } : {}),
          },
        }),
      );
    },
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
      <ListLayout>
      <Tabs
        value={type}
        onValueChange={(value) =>
          select(value as AdminWorkItemTypeFilter, visibility)
        }
        className="w-full min-w-0 gap-3"
        data-business-list="work-items"
      >
        <ListToolbarPart area="leading">
        {/* Keep tab indicators and focus rings inside the horizontal scroller. */}
        <div className="-m-1 min-w-0 scroll-p-1 overflow-x-auto p-1">
          <TabsList aria-label="待处理类型">
            {filters.filter(([value]) => !workspaceClientId || value !== "LEDGER_CONFLICT").map(([value, name]) => (
              <TabsTrigger
                key={value}
                value={value}
                disabled={ignore.isPending}
                onFocus={(event) =>
                  event.currentTarget.scrollIntoView({
                    block: "nearest",
                    inline: "nearest",
                  })
                }
              >
                {name}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        </ListToolbarPart>
        {workspaceClientId !== null && <Alert><AlertTitle>仅显示本站提醒</AlertTitle><AlertDescription>账本冲突及归属未知的异常请到「待处理（全部网站）」处理。</AlertDescription></Alert>}
        <TabsContent value={type}>
          <WorkItemPage
            key={type + ":" + visibility}
            type={type}
            visibility={visibility}
            busy={ignore.isPending}
            onVisibility={(next) => select(type, next)}
            onIgnore={(trigger) => {
              finalFocus.current =
                trigger ??
                (document.activeElement instanceof HTMLElement
                  ? document.activeElement
                  : null);
              ignore.reset();
              setBatch({
                type,
                clientId: workspaceClientId,
                siteName: site?.data?.data.configuration?.name ?? null,
                q: (search.get("q") ?? "").trim(),
                name: filters.find(([value]) => value === type)![1],
                operation_id: crypto.randomUUID(),
              });
            }}
          />
        </TabsContent>
      </Tabs>
      </ListLayout>
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
          initialFocus={cancelIgnore}
          finalFocus={() => finalFocus.current}
          className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto sm:max-w-lg"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              忽略全部筛选结果（跨页） · {batch?.name}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <DialogBody><AlertDialogDescription>
              {batch?.clientId && <>
                {batch.siteName ? <>仅限业务网站“{batch.siteName}”</> : <>仅限当前业务网站</>}。
                客户端 ID（PerPay）：<span className="font-mono wrap-anywhere">{batch.clientId}</span>。
                不含其他网站及未归属提醒。
              </>}
              {batch?.q ? (
                <>
                  关键词“{batch.q}
                  ”在此分类中的全部匹配项（跨页）。
                </>
              ) : (
                <>此分类的全部匹配项（跨页）。</>
              )}
              仅关闭现有提醒，不删除记录、处理冲突或停止通知重试；新增提醒不受影响。
            </AlertDialogDescription></DialogBody>
          <ErrorNotice error={ignore.error} />
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancelIgnore} disabled={ignore.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={ignore.isPending}
              onClick={() => {
                if (batch && !ignore.isPending) ignore.mutate(batch);
              }}
            >
              {ignore.isPending && (
                <Spinner aria-hidden="true" data-icon="inline-start" />
              )}
              确认忽略
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
  onVisibility,
  onIgnore,
}: {
  type: AdminWorkItemTypeFilter;
  visibility: Visibility;
  busy: boolean;
  onVisibility: (value: Visibility) => void;
  onIgnore: (trigger?: HTMLElement | null) => void;
}) {
  const mounted = useMounted();
  const { clientId } = useWorkspace();
  const pagination = useCursor();
  // Priority is an overview preview policy; retain the full list's existing sort choices.
  const sortFields = workItemSortFields(visibility);
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
  const work = useQuery(workItemsQuery(clientId, listQuery, pagination.cursor, type, visibility));
  const setRestoredMessage = useSuccessToast();
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
    if (!position || work.isFetching || work.isPlaceholderData) return;
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
        ...(list.current?.querySelectorAll<HTMLElement>("[data-business-row]") ??
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
  }, [position, work.data, work.isFetching, work.isPlaceholderData, work.isError, pagination]);
  const cannotIgnore =
    busy ||
    work.isPending ||
    work.isError ||
    (!work.data?.data.length && pagination.page === 1);
  const visibilityControl = (
    <ToggleGroup
      variant="outline"
      value={[visibility]}
      disabled={busy}
      onValueChange={(value) => {
        if (value[0]) onVisibility(value[0] as Visibility);
      }}
      aria-label="显示范围"
    >
      <ToggleGroupItem value="ACTIVE">待处理</ToggleGroupItem>
      <ToggleGroupItem value="IGNORED">已忽略</ToggleGroupItem>
    </ToggleGroup>
  );
  return (
    <ListColumnsProvider>
    <div className="flex flex-col gap-3">
      <ListToolbarPart>
      <ListQueryToolbar
        control={listQuery}
        label="提醒关键词搜索"
        desktopFilters={visibilityControl}
        desktopActions={
          <>
            {visibility === "ACTIVE" && (
              <Button
                variant="outline"
                disabled={cannotIgnore}
                onClick={(event) => onIgnore(event.currentTarget)}
              >
                忽略全部筛选结果（跨页）
              </Button>
            )}
            <RefreshButton disabled={busy || work.isFetching} onClick={() => {
                void work.refetch();
              }} busy={busy || work.isFetching} />
          </>
        }
        mobileLeading={visibilityControl}
        mobileActions={
          <ListActionsMenu label="更多提醒操作" disabled={busy}>
            {(trigger) => (
              <>
                {visibility === "ACTIVE" && (
                  <DropdownMenuItem
                    disabled={cannotIgnore}
                    onClick={() => onIgnore(trigger.current)}
                  >
                    <EyeOff />
                    忽略全部筛选结果（跨页）
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  disabled={busy || work.isFetching}
                  onClick={() => {
                    void work.refetch();
                  }}
                >
                  <RefreshCw />
                  刷新
                </DropdownMenuItem>
              </>
            )}
          </ListActionsMenu>
        }
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
      </ListToolbarPart>
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
              aria-busy={work.isFetching || work.isPlaceholderData}
              className="min-w-0 outline-none"
            >
              <WorkItemsTable
                items={page.data}
                control={listQuery}
                emptyTitle={
                  listQuery.query.q
                    ? "暂无符合条件的提醒"
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
              pending={work.isFetching || work.isPlaceholderData || busy}
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
              ? "恢复提醒"
              : "恢复提醒"}
      </Button>
      {!!state?.error && (
        <>
          <span role="status" className="sr-only">
            恢复结果暂未确认，请重试或查看错误说明。
          </span>
          <Popover>
            <PopoverTrigger render={<Button variant="ghost" size="sm" />}>
              错误说明
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] overflow-y-auto"
            >
              <PopoverHeader>
                <PopoverTitle>恢复提醒错误说明</PopoverTitle>
                <PopoverDescription>
                  只调整提醒，不改变异常、冲突或通知的处理状态。
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
