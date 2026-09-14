import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useSearchParams } from "react-router";
import { SelectionIndicator } from "../components/SelectionIndicator";
import { api, refreshOperationalData, result, type AdminWorkItem, type AdminWorkItemTypeFilter } from "../api/client";
import { WorkItemList } from "../components/WorkItemList";
import { Button, Dialog, ErrorNotice, Notice, PageHeading, Pagination, Panel, QueryView, useCursor } from "../components/ui";
import { useOperationKey } from "../lib/idempotency";

const filters = [["ALL", "全部事项"], ["FINANCIAL_EXCEPTION", "账务异常"], ["LEDGER_CONFLICT", "账本冲突"], ["NOTIFICATION_FAILURE", "通知失败"]] as const;
type Visibility = "ACTIVE" | "IGNORED";
export default function WorkItems() {
  const mounted = useMounted();
  const [search, setSearch] = useSearchParams();
  const type = filters.find(([value]) => value === search.get("type"))?.[0] ?? "ALL";
  const visibility: Visibility = search.get("visibility") === "IGNORED" ? "IGNORED" : "ACTIVE";
  const [batch, setBatch] = useState<{ type: AdminWorkItemTypeFilter; name: string; operation_id: string } | null>(null);
  const [message, setMessage] = useState("");
  const ignore = useMutation({ mutationFn: (input: NonNullable<typeof batch>) =>
    result(api.ignoreAllAdministratorWorkItems({ body: { operation_id: input.operation_id, type: input.type } })),
    onSuccess: ({ data }, input) => {
      void refreshOperationalData();
      if (!mounted.current) return;
      setBatch(null); setMessage("已忽略“" + input.name + "”中的 " + data.ignored_count + " 条提醒。");
      setSearch((current) => { const next = new URLSearchParams(current); next.delete("cursor"); next.delete("page"); return next; }, { replace: true });
    },
  });
  function select(nextType: AdminWorkItemTypeFilter, nextVisibility: Visibility) {
    setSearch({ type: nextType, ...(nextVisibility === "IGNORED" ? { visibility: nextVisibility } : {}) }, { replace: true });
    setMessage("");
  }
  return <><PageHeading title="待处理" />
    {message && <Notice tone="success">{message}</Notice>}
    <Panel><div className="tabs" role="group" aria-label="待处理类型"><SelectionIndicator active={type} underline />{filters.map(([value, name]) => <button type="button" key={value} disabled={ignore.isPending} aria-pressed={type === value} onClick={() => select(value, visibility)}>{name}</button>)}</div>
      <WorkItemPage key={type + ":" + visibility} type={type} visibility={visibility} busy={ignore.isPending}
        onVisibility={() => select(type, visibility === "ACTIVE" ? "IGNORED" : "ACTIVE")}
        onIgnore={() => { ignore.reset(); setBatch({ type, name: filters.find(([value]) => value === type)![1], operation_id: crypto.randomUUID() }); }} />
    </Panel>
    {batch && <Dialog title={"忽略全部" + batch.name + "提醒"} description="覆盖当前分类的所有分页，仅关闭提醒；不删除记录、不解决账本冲突，也不停止通知自动重试。操作完成后新产生的事项仍会提醒。" busy={ignore.isPending} onClose={() => { if (!ignore.isPending) setBatch(null); }}>
      <ErrorNotice error={ignore.error} />
      <div className="form-actions"><Button disabled={ignore.isPending} onClick={() => setBatch(null)}>取消</Button><Button variant="danger" pending={ignore.isPending} onClick={() => ignore.mutate(batch)}>确认全部忽略</Button></div>
    </Dialog>}
  </>;
}

function WorkItemPage({ type, visibility, busy, onVisibility, onIgnore }: {
  type: AdminWorkItemTypeFilter; visibility: Visibility; busy: boolean; onVisibility: () => void; onIgnore: () => void;
}) {
  const mounted = useMounted();
  const pagination = useCursor();
  const [, setSearch] = useSearchParams();
  const work = useQuery({ queryKey: ["work-items", type, visibility, pagination.cursor], queryFn: ({ signal }) => result(api.listAdministratorWorkItems({ signal, query: { type, visibility, limit: 20, ...(pagination.cursor ? { cursor: pagination.cursor } : {}) } })) });
  function restored() {
    void refreshOperationalData();
    if (!mounted.current) return;
    setSearch((current) => { const next = new URLSearchParams(current); next.delete("cursor"); next.delete("page"); return next; }, { replace: true });
  }
  return <><div className="list-toolbar"><span>{visibility === "ACTIVE" ? "未忽略提醒" : "已忽略提醒"}</span><div className="reminder-toolbar-actions">
    <Button variant="quiet" disabled={busy} onClick={onVisibility}>{visibility === "ACTIVE" ? "查看已忽略" : "返回未忽略"}</Button>
    {visibility === "ACTIVE" && <Button disabled={busy || work.isPending || work.isError || (!work.data?.data.length && pagination.page === 1)} onClick={onIgnore}>全部忽略</Button>}
    <Button variant="quiet" pending={work.isFetching} disabled={busy} onClick={() => { void work.refetch(); }}><RefreshCw size={15} />刷新</Button>
  </div></div>
    <QueryView query={work}>{(page) => <><WorkItemList items={page.data} emptyTitle={visibility === "IGNORED" ? "暂时没有已忽略提醒" : undefined}
      actions={visibility === "IGNORED" ? (item) => <RestoreReminder item={item} onRestored={restored} /> : undefined} />
      <Pagination previousLabel={pagination.previousLabel} page={pagination.page} count={page.data.length} hasNext={!!page.page.next_cursor} pending={work.isFetching || busy} onPrevious={pagination.previous} onNext={() => pagination.next(page.page.next_cursor)} /></>}</QueryView>
  </>;
}
function RestoreReminder({ item, onRestored }: { item: AdminWorkItem; onRestored: () => void }) {
  const operationKey = useOperationKey();
  const restore = useMutation({ mutationFn: () => result(api.restoreAdministratorWorkItem({
    path: { type: item.type, resourceId: item.resource_id }, body: { operation_id: operationKey([item.type, item.resource_id, item.ignored_at]) },
  })), onSuccess: onRestored });
  return <div className="reminder-actions"><Button disabled={item.ended} pending={restore.isPending} onClick={() => restore.mutate()}>{item.ended ? "已结束" : "恢复提醒"}</Button><ErrorNotice error={restore.error} /></div>;
}

function useMounted() {
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return mounted;
}
