import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useSearchParams } from "react-router";

import { SelectionIndicator } from "../components/SelectionIndicator";

import { api, result, type AdminWorkItemTypeFilter } from "../api/client";
import { WorkItemList } from "../components/WorkItemList";
import { Button, PageHeading, Pagination, Panel, QueryView, useCursor } from "../components/ui";

const filters = [["ALL", "全部事项"], ["FINANCIAL_EXCEPTION", "账务异常"], ["LEDGER_CONFLICT", "账本冲突"], ["NOTIFICATION_FAILURE", "通知失败"]] as const;

export default function WorkItems() {
  const [search, setSearch] = useSearchParams();
  const type = filters.find(([value]) => value === search.get("type"))?.[0] ?? "ALL";
  return <><PageHeading title="待处理" />
    <Panel><div className="tabs" role="group" aria-label="待处理类型"><SelectionIndicator active={type} underline />{filters.map(([value, name]) => <button type="button" key={value} aria-pressed={type === value} onClick={() => setSearch({ type: value }, { replace: true })}>{name}</button>)}</div>
      <WorkItemPage key={type} type={type} />
    </Panel>
  </>;
}

function WorkItemPage({ type }: { type: AdminWorkItemTypeFilter }) {
  const pagination = useCursor();
  const work = useQuery({ queryKey: ["work-items", type, pagination.cursor], queryFn: ({ signal }) => result(api.listAdministratorWorkItems({ signal, query: { type, limit: 20, ...(pagination.cursor ? { cursor: pagination.cursor } : {}) } })) });
  return <><div className="list-toolbar"><span>未解决事项</span><Button variant="quiet" pending={work.isFetching} onClick={() => { void work.refetch(); }}><RefreshCw size={15} />刷新</Button></div>
    <QueryView query={work}>{(page) => <><WorkItemList items={page.data} /><Pagination page={pagination.page} count={page.data.length} hasNext={!!page.page.next_cursor} pending={work.isFetching} onPrevious={pagination.previous} onNext={() => pagination.next(page.page.next_cursor)} /></>}</QueryView>
  </>;
}
