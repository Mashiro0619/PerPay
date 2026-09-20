import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useSearchParams } from "react-router";
import {
  api,
  refreshOperationalData,
  result,
  type AdminWorkItem,
  type AdminWorkItemTypeFilter,
} from "@/api/client";
import { useOperationKey } from "@/lib/idempotency";
import { useCursor } from "@/lib/cursor";
import { WorkItemsTable } from "@/components/work-items-table";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { CursorPagination } from "@/components/cursor-pagination";
import { SuccessMessage, useFeedback } from "@/components/Feedback";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
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
    operation_id: string;
  } | null>(null);
  const finalFocus = useRef<HTMLElement | null>(null);
  const [message, setMessage] = useFeedback();
  const ignore = useMutation({
    mutationFn: (input: NonNullable<typeof batch>) =>
      result(
        api.ignoreAllAdministratorWorkItems({
          body: { operation_id: input.operation_id, type: input.type },
        }),
      ),
    onSuccess: ({ data }, input) => {
      void refreshOperationalData();
      if (!mounted.current) return;
      setBatch(null);
      setMessage(
        "已忽略“" + input.name + "”中的 " + data.ignored_count + " 条提醒。",
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
      {
        type: nextType,
        ...(nextVisibility === "IGNORED" ? { visibility: nextVisibility } : {}),
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
            <AlertDialogTitle>全部忽略 · {batch?.name}</AlertDialogTitle>
            <AlertDialogDescription>
              包括此分类的所有分页。仅关闭提醒，不删除记录、不解决冲突，也不停止通知重试。新事项仍会提醒。
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
              确认全部忽略
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
  const [, setSearch] = useSearchParams();
  const work = useQuery({
    queryKey: ["work-items", type, visibility, pagination.cursor],
    queryFn: ({ signal }) =>
      result(
        api.listAdministratorWorkItems({
          signal,
          query: {
            type,
            visibility,
            limit: 20,
            ...(pagination.cursor ? { cursor: pagination.cursor } : {}),
          },
        }),
      ),
  });
  const [restoredMessage, setRestoredMessage] = useFeedback();
  function restored() {
    setRestoredMessage("已恢复提醒");
    void refreshOperationalData();
    if (!mounted.current) return;
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
              全部忽略
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
      <SuccessMessage message={message || restoredMessage} />
      <QueryView query={work}>
        {(page) => (
          <>
            <div className="overflow-hidden rounded-lg border">
              <WorkItemsTable
                items={page.data}
                emptyTitle={
                  visibility === "IGNORED" ? "暂无已忽略提醒" : undefined
                }
                actions={
                  visibility === "IGNORED"
                    ? (item) => (
                        <RestoreReminder item={item} onRestored={restored} />
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
  onRestored,
}: {
  item: AdminWorkItem;
  onRestored: () => void;
}) {
  const operationKey = useOperationKey();
  const restore = useMutation({
    mutationFn: () =>
      result(
        api.restoreAdministratorWorkItem({
          path: { type: item.type, resourceId: item.resource_id },
          body: {
            operation_id: operationKey([
              item.type,
              item.resource_id,
              item.ignored_at,
            ]),
          },
        }),
      ),
    onSuccess: onRestored,
  });
  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={item.ended || restore.isPending}
        onClick={() => {
          if (!restore.isPending && !item.ended) restore.mutate();
        }}
      >
        {restore.isPending && (
          <Spinner aria-hidden="true" data-icon="inline-start" />
        )}
        {item.ended ? "已结束" : "恢复提醒"}
      </Button>
      <ErrorNotice error={restore.error} />
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
