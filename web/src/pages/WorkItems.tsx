import { ListLayout, ListToolbarPart } from "@/components/list-layout";
import { useWorkspace } from "@/workspace";
import { useQuery } from "@/lib/workspace-query";
import { useWorkspaceApi } from "@/workspace";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { RefreshButton } from "@/components/refresh-button";
import { useListQuery } from "@/lib/list-query";
import { workItemFilters, workItemSortFields, workItemsQuery, type WorkItemVisibility } from "@/api/workspace-queries";
import { ListQueryToolbar } from "@/components/list-query-toolbar";
import { ListActionsMenu } from "@/components/list-actions-menu";
import { ListColumnsProvider } from "@/components/list-columns";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useEffect, useMemo, useRef, useState } from "react";
import { onlineManager, useMutation } from "@tanstack/react-query";
import { RefreshCw, EyeOff, RotateCcw } from "lucide-react";
import { useLocation, useSearchParams } from "react-router";
import { ApiError, refreshOperationalData, result, type AdminWorkItem, type AdminWorkItemTypeFilter } from "@/api/client";
import { waitForOperation } from "@/lib/operation-timeout";
import {
  useReminderRestores,
  needsReminderRefresh,
  type ReminderRestoreState,
} from "@/lib/reminder-restore-requests";
import { restoreMessages, type RestoreOutcome } from "@/lib/reminder-restore";
import { useCursor } from "@/lib/cursor";
import { workItemHref, workItemTitle } from "@/lib/labels";
import { WorkItemsTable, workItemKey } from "@/components/work-items-table";
import { useQuickRetryDelivery } from "@/components/detail/NotificationEvidence";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { CursorPagination } from "@/components/cursor-pagination";
import { OverlayRecordList } from "@/components/overlay-record-list";
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

type IgnoreBatchRequest =
  | {
      readonly mode: "all";
      readonly type: AdminWorkItemTypeFilter;
      readonly name: string;
      readonly q: string;
      readonly operation_id: string;
      readonly clientId: string | null;
      readonly siteName: string | null;
    }
  | {
      readonly mode: "selected";
      readonly items: readonly {
        readonly type: AdminWorkItem["type"];
        readonly resource_id: string;
        readonly title: string;
      }[];
      readonly operation_id: string;
      readonly clientId: string | null;
      readonly siteName: string | null;
    };

const safeIgnoreRejectionCodes: Readonly<Record<string, number>> = {
  validation_failed: 422,
  csrf_invalid: 403,
  origin_not_allowed: 403,
  auth_rate_limited: 429,
  work_item_not_found: 404,
  order_not_found: 404,
};

function isSafeIgnoreRejection(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    safeIgnoreRejectionCodes[error.code] === error.status
  );
}

export default function WorkItems() {
  const api = useWorkspaceApi();
  const { clientId: workspaceClientId, site } = useWorkspace();
  const mounted = useMounted();
  const [search, setSearch] = useSearchParams();
  const { type, visibility } = workItemFilters(search, workspaceClientId);
  const restores = useReminderRestores();
  const [batch, setBatch] = useState<IgnoreBatchRequest | null>(null);
  const [lastBatch, setLastBatch] = useState<IgnoreBatchRequest | null>(null);
  const [selectionClearSignal, setSelectionClearSignal] = useState(0);
  const finalFocus = useRef<HTMLElement | null>(null);
  const cancelIgnore = useRef<HTMLButtonElement | null>(null);
  const ignoreController = useRef<AbortController | null>(null);
  const setMessage = useSuccessToast();

  useEffect(() => {
    return () => {
      ignoreController.current?.abort();
    };
  }, []);

  const ignore = useMutation({
    networkMode: "always",
    retry: false,
    mutationFn: async (input: IgnoreBatchRequest) => {
      if (!onlineManager.isOnline() || !navigator.onLine) {
        throw new Error("网络已断开，忽略操作未提交。恢复连接后请重新提交。");
      }
      const controller = new AbortController();
      ignoreController.current = controller;
      try {
        return await waitForOperation(controller, async (signal) => {
          if (input.mode === "selected") {
            const response = await result(
              api.ignoreSelectedAdministratorWorkItems({
                signal,
                body: {
                  operation_id: input.operation_id,
                  ...(input.clientId ? { api_client_id: input.clientId } : {}),
                  items: input.items.map((item) => ({
                    type: item.type,
                    resource_id: item.resource_id,
                  })),
                },
              }),
            );
            const data = response?.data;
            if (
              !data ||
              data.operation_id !== input.operation_id ||
              typeof data.ignored_count !== "number"
            ) {
              throw new Error(
                "操作结果未完整返回，暂时无法确认是否成功。请重试上一次操作或刷新列表核查。",
              );
            }
            return response;
          }
          const response = await result(
            api.ignoreAllAdministratorWorkItems({
              signal,
              body: {
                operation_id: input.operation_id,
                type: input.type,
                ...(input.clientId ? { api_client_id: input.clientId } : {}),
                ...(input.q ? { q: input.q } : {}),
              },
            }),
          );
          const data = response?.data;
          if (
            !data ||
            data.operation_id !== input.operation_id ||
            typeof data.ignored_count !== "number"
          ) {
            throw new Error(
              "操作结果未完整返回，暂时无法确认是否成功。请重试上一次操作或刷新列表核查。",
            );
          }
          return response;
        });
      } finally {
        if (ignoreController.current === controller) {
          ignoreController.current = null;
        }
      }
    },
    onSuccess: ({ data }, input) => {
      void refreshOperationalData();
      if (!mounted.current) return;
      setBatch(null);
      setSelectionClearSignal((value) => value + 1);
      if (input.mode === "selected") {
        setMessage(
          data.ignored_count > 0
            ? input.items.length === 1
              ? "已忽略选中的 1 条提醒。"
              : "已忽略选中的 " + data.ignored_count + " 条提醒。"
            : "所选提醒已处于忽略状态。",
        );
      } else {
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
      }
    },
  });

  const navigationLocked = ignore.isPending || restores.pendingCount > 0;

  function openIgnoreDialog(request: IgnoreBatchRequest, trigger?: HTMLElement | null) {
    finalFocus.current =
      trigger ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    ignore.reset();
    setLastBatch(request);
    setBatch(request);
  }

  function select(
    nextType: AdminWorkItemTypeFilter,
    nextVisibility: Visibility,
  ) {
    if (navigationLocked) return;
    setSearch(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("type", nextType);
        if (nextVisibility === "IGNORED")
          next.set("visibility", nextVisibility);
        else next.delete("visibility");
        if (
          (nextVisibility !== "IGNORED" && next.get("sort_by") === "ignored_at") ||
          (nextVisibility === "IGNORED" && next.get("sort_by") === "priority")
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

  const shownBatch = batch ?? lastBatch;
  const dialogTitle = !shownBatch
    ? "确认忽略提醒"
    : shownBatch.mode === "all"
      ? `忽略全部筛选结果（跨页） · ${shownBatch.name}`
      : shownBatch.items.length === 1
        ? `忽略提醒 · ${shownBatch.items[0]!.title}`
        : `忽略已选的 ${shownBatch.items.length} 条提醒`;

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
                {filters
                  .filter(([value]) => !workspaceClientId || value !== "LEDGER_CONFLICT")
                  .map(([value, name]) => (
                    <TabsTrigger
                      key={value}
                      value={value}
                      disabled={navigationLocked}
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
          {workspaceClientId !== null && (
            <Alert>
              <AlertTitle>仅显示本站提醒</AlertTitle>
              <AlertDescription>
                账本冲突及归属未知的异常请到「待处理（全部网站）」处理。
              </AlertDescription>
            </Alert>
          )}
          <TabsContent value={type}>
            <WorkItemPage
              key={type + ":" + visibility}
              type={type}
              visibility={visibility}
              busy={ignore.isPending}
              navigationLocked={navigationLocked}
              restores={restores}
              selectionClearSignal={selectionClearSignal}
              onVisibility={(next) => select(type, next)}
              onIgnoreAll={(trigger) => {
                openIgnoreDialog(
                  {
                    mode: "all",
                    type,
                    clientId: workspaceClientId,
                    siteName: site?.data?.data.configuration?.name ?? null,
                    q: (search.get("q") ?? "").trim(),
                    name: filters.find(([value]) => value === type)![1],
                    operation_id: crypto.randomUUID(),
                  },
                  trigger,
                );
              }}
              onIgnoreSelected={(items, trigger) => {
                if (items.length === 0) return;
                openIgnoreDialog(
                  {
                    mode: "selected",
                    clientId: workspaceClientId,
                    siteName: site?.data?.data.configuration?.name ?? null,
                    items: items.map((item) => ({
                      type: item.type,
                      resource_id: item.resource_id,
                      title: workItemTitle(item),
                    })),
                    operation_id: crypto.randomUUID(),
                  },
                  trigger,
                );
              }}
            />
          </TabsContent>
        </Tabs>
      </ListLayout>
      <AlertDialog
        open={!!batch}
        onOpenChange={(open, event) => {
          if (!open) {
            if (ignore.isPending) {
              event.cancel();
              return;
            }
            if (ignore.error && !isSafeIgnoreRejection(ignore.error)) {
              void refreshOperationalData();
            }
            setBatch(null);
          }
        }}
      >
        <AlertDialogContent
          initialFocus={cancelIgnore}
          finalFocus={() => finalFocus.current}
          className="sm:max-w-lg"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{dialogTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {shownBatch?.clientId && (
                <>
                  {shownBatch.siteName ? (
                    <>仅限业务网站“{shownBatch.siteName}”</>
                  ) : (
                    <>仅限当前业务网站</>
                  )}
                  。网站 ID：
                  <span className="font-mono wrap-anywhere">
                    {shownBatch.clientId}
                  </span>
                  。不含其他网站及未归属提醒。
                </>
              )}
              {shownBatch?.mode === "all" ? (
                shownBatch.q ? (
                  <>
                    关键词“{shownBatch.q}
                    ”在此分类中的全部匹配项（跨页）。
                  </>
                ) : (
                  <>此分类的全部匹配项（跨页）。</>
                )
              ) : shownBatch?.mode === "selected" ? (
                shownBatch.items.length === 1 ? (
                  <>仅关闭当前选中的这条提醒。</>
                ) : (
                  <>仅关闭当前勾选的 {shownBatch.items.length} 条提醒。</>
                )
              ) : null}
              仅关闭现有提醒，不删除记录、处理冲突或停止通知重试；新增提醒不受影响，后续可在“已忽略”中随时恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
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
  navigationLocked,
  restores,
  selectionClearSignal,
  onVisibility,
  onIgnoreAll,
  onIgnoreSelected,
}: {
  type: AdminWorkItemTypeFilter;
  visibility: Visibility;
  busy: boolean;
  navigationLocked: boolean;
  restores: ReturnType<typeof useReminderRestores>;
  selectionClearSignal: number;
  onVisibility: (value: Visibility) => void;
  onIgnoreAll: (trigger?: HTMLElement | null) => void;
  onIgnoreSelected: (items: readonly AdminWorkItem[], trigger?: HTMLElement | null) => void;
}) {
  const mounted = useMounted();
  const { clientId } = useWorkspace();
  const pagination = useCursor();
  const sortFields = workItemSortFields(visibility);
  const listQuery = useListQuery(
    sortFields,
    visibility === "IGNORED" ? "ignored_at" : "priority",
    "desc",
  );
  const list = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const locationKey = useRef(location.key);
  locationKey.current = location.key;
  const [selectedMap, setSelectedMap] = useState<ReadonlyMap<string, AdminWorkItem>>(
    () => new Map(),
  );

  // Clear selection whenever scope, filters, page, or ignore completion changes.
  useEffect(() => {
    setSelectedMap(new Map());
  }, [type, visibility, clientId, pagination.pageKey, listQuery.query.q, listQuery.query.sortBy, listQuery.query.sortOrder, selectionClearSignal]);

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
  const quickRetry = useQuickRetryDelivery();
  const setRestoredMessage = useSuccessToast();

  // Keep selected items synchronized with items visible on the current page.
  const pageItems = work.data?.data ?? [];
  const selectedKeys = useMemo(() => {
    const visibleIds = new Set(pageItems.map(workItemKey));
    const keys = new Set<string>();
    for (const key of selectedMap.keys()) {
      if (visibleIds.has(key)) keys.add(key);
    }
    return keys;
  }, [pageItems, selectedMap]);
  const selectedItems = useMemo(
    () => pageItems.filter((item) => !item.ended && selectedKeys.has(workItemKey(item))),
    [pageItems, selectedKeys],
  );

  function toggleItemSelection(item: AdminWorkItem, checked: boolean) {
    if (item.ended) return;
    const key = workItemKey(item);
    setSelectedMap((current) => {
      const next = new Map(current);
      if (checked) next.set(key, item);
      else next.delete(key);
      return next;
    });
  }

  function toggleAllOnPage(checked: boolean) {
    setSelectedMap(() => {
      const next = new Map<string, AdminWorkItem>();
      if (checked) {
        for (const item of pageItems) {
          if (!item.ended) next.set(workItemKey(item), item);
        }
      }
      return next;
    });
  }

  function restore(item: AdminWorkItem, trigger: HTMLElement) {
    const currentState = restores.get(item);
    if (
      item.ended ||
      currentState?.status === "pending" ||
      currentState?.status === "refreshing"
    )
      return;
    const id = workItemKey(item);
    const ids = pageItems.map(workItemKey);
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
      if (outcome === "refresh") {
        restores.clear(item);
      }
      if (!mounted.current) return;
      const latest = latestAction.current;
      if (
        latest === action &&
        locationKey.current === action.locationKey &&
        outcome !== "refresh"
      ) {
        setRestoredMessage(restoreMessages[outcome]);
      }
      if (!latest?.completed || locationKey.current !== latest.locationKey)
        return;
      setPosition({ ...latest });
    };
    const readAgain = needsReminderRefresh(currentState);
    if (readAgain) {
      restores.markRefreshing(item);
      latestAction.current = action;
      setPosition(null);
      setRestoredMessage("");
      void completed("refresh");
      return;
    }
    if (!restores.submit(item, (outcome) => completed(outcome))) return;
    latestAction.current = action;
    setPosition(null);
    setRestoredMessage("");
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
      disabled={navigationLocked}
      onValueChange={(value) => {
        if (value[0]) onVisibility(value[0] as Visibility);
      }}
      aria-label="显示范围"
    >
      <ToggleGroupItem value="ACTIVE">待处理</ToggleGroupItem>
      <ToggleGroupItem value="IGNORED">已忽略</ToggleGroupItem>
    </ToggleGroup>
  );
  const canResetPrioritySort =
    visibility === "ACTIVE" && listQuery.query.sortBy !== "priority";
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
                {canResetPrioritySort && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    aria-label="恢复需要处理优先排序"
                    onClick={() => listQuery.setSort("priority", "desc")}
                  >
                    <RotateCcw aria-hidden="true" data-icon="inline-start" />
                    默认排序
                  </Button>
                )}
                {visibility === "ACTIVE" && (
                  <Button
                    variant="outline"
                    disabled={cannotIgnore}
                    onClick={(event) => onIgnoreAll(event.currentTarget)}
                  >
                    忽略全部筛选结果（跨页）
                  </Button>
                )}
                <RefreshButton
                  disabled={busy || work.isFetching}
                  onClick={() => {
                    void work.refetch();
                  }}
                  busy={busy || work.isFetching}
                />
              </>
            }
            mobileLeading={visibilityControl}
            mobileActions={
              <ListActionsMenu label="更多提醒操作" disabled={navigationLocked}>
                {(trigger) => (
                  <>
                    {visibility === "ACTIVE" && (
                      <DropdownMenuItem
                        disabled={cannotIgnore}
                        onClick={() => onIgnoreAll(trigger.current)}
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
                priority: "需要处理优先",
              }[value],
            }))}
          />
        </ListToolbarPart>
        {visibility === "ACTIVE" && selectedItems.length > 0 && (
          <div
            role="region"
            aria-label="已选提醒操作"
            data-work-items-selection-bar
            className="work-items-selection-bar"
          >
            <span className="text-sm font-medium text-foreground">
              已选 {selectedItems.length} 项
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={(event) =>
                  onIgnoreSelected(selectedItems, event.currentTarget)
                }
              >
                <EyeOff aria-hidden="true" data-icon="inline-start" />
                忽略已选（{selectedItems.length}）
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setSelectedMap(new Map())}
              >
                取消选择
              </Button>
            </div>
          </div>
        )}
        {restores.pendingCount > 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            {restores.pendingCount} 条提醒正在恢复…
          </p>
        )}
        <OverlayRecordList
          items={pageItems.map(workItemHref)}
          hasPrevious={pagination.canStepPrevious}
          hasNext={!!work.data?.page.next_cursor}
          pending={work.isPending || work.isPlaceholderData || busy}
          failed={!work.isPending && work.data === undefined && !!work.error}
          pageKey={pagination.pageKey}
          onPreviousPage={pagination.replacePrevious}
          onNextPage={() => pagination.replaceNext(work.data?.page.next_cursor)}
        >
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
                    showCategoryInIgnored={type === "ALL"}
                    selection={
                      visibility === "ACTIVE"
                        ? {
                            selectedKeys,
                            disabled: busy,
                            onToggle: toggleItemSelection,
                            onToggleAll: toggleAllOnPage,
                          }
                        : undefined
                    }
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
                    inlineAction={
                      visibility === "ACTIVE"
                        ? (item) => {
                            if (item.ended) return null;
                            const canQuickRetry =
                              item.type === "NOTIFICATION_FAILURE" &&
                              item.status === "RETRY_WAIT";
                            const retryPending = canQuickRetry
                              ? quickRetry.isPending(item.resource_id)
                              : false;
                            return (
                              <div className="flex flex-wrap items-center justify-center gap-1" data-row-action>
                                {canQuickRetry && (
                                  <Button
                                    type="button"
                                    size="xs"
                                    variant="outline"
                                    disabled={busy || retryPending}
                                    onClick={() =>
                                      quickRetry.run(item.resource_id, item.order_id)
                                    }
                                  >
                                    {retryPending && (
                                      <Spinner aria-hidden="true" data-icon="inline-start" />
                                    )}
                                    {retryPending ? "正在重试…" : "立即重试"}
                                  </Button>
                                )}
                                <Button
                                  type="button"
                                  size="xs"
                                  variant="ghost"
                                  data-work-item-ignore
                                  aria-label={"忽略提醒：" + workItemTitle(item)}
                                  disabled={busy}
                                  onClick={(event) =>
                                    onIgnoreSelected([item], event.currentTarget)
                                  }
                                >
                                  忽略
                                </Button>
                              </div>
                            );
                          }
                        : undefined
                    }
                  />
                </div>
                <CursorPagination
                  previousLabel={pagination.previousLabel}
                  page={pagination.page}
                  count={page.data.length}
                  hasNext={!!page.page.next_cursor}
                  pending={work.isPending || work.isPlaceholderData || busy}
                  onPrevious={pagination.previous}
                  onNext={() => pagination.next(page.page.next_cursor)}
                />
              </>
            )}
          </QueryView>
        </OverlayRecordList>
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
  const pending = state?.status === "pending" || state?.status === "refreshing";
  if (item.ended && !pending && !state?.error) return null;
  return (
    <div className="flex flex-col items-center gap-1.5">
      <Button
        data-reminder-restore
        data-reminder-ended={item.ended || undefined}
        size="sm"
        variant="outline"
        aria-label={
          (item.ended
            ? "已结束"
            : readAgain
              ? "刷新列表"
              : state?.error
                ? "重试恢复"
                : "恢复提醒") + "：" + workItemTitle(item)
        }
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
      {!!state?.error && !item.ended && (
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
              className="max-h-[calc(100dvh-2rem)] max-w-[calc(100dvw-2rem)] overflow-y-auto overscroll-contain"
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
