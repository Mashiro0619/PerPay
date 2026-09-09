import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Search } from "lucide-react";
import { useSearchParams } from "react-router";

import { Link, useNavigate } from "../navigation";
import { SelectionIndicator } from "../components/SelectionIndicator";

import { api, result } from "../api/client";
import { LinkedTableRow } from "../components/LinkedTableRow";
import { Badge, Button, EmptyState, Notice, PageHeading, Pagination, Panel, QueryView, useCursor } from "../components/ui";
import { dateTime, resourceIdPattern, shortId } from "../lib/format";
import { label } from "../lib/labels";
import { FinancialDialog } from "./FinancialDialog";

type Section = "matches" | "conflicts" | "exceptions";

export default function Reconciliation() {
  const [search, setSearch] = useSearchParams();
  const [operation, setOperation] = useState<"settlement" | "refund" | null>(null);
  const [completed, setCompleted] = useState(false);
  const [ledgerId, setLedgerId] = useState("");
  const navigate = useNavigate();
  const section: Section = search.get("tab") === "conflicts" ? "conflicts" : search.get("tab") === "exceptions" ? "exceptions" : "matches";
  const allowed = section === "matches" ? ["SETTLED", "REVERSED"] : ["OPEN", "RESOLVED", "IGNORED", "ALL"];
  const status = allowed.includes(search.get("status") ?? "") ? search.get("status")! : allowed[0]!;
  return <><PageHeading title="账本与对账" actions={<><Button onClick={() => setOperation("refund")}>登记已发生退款</Button><Button variant="primary" onClick={() => setOperation("settlement")}>人工关联收款</Button></>} />
    {completed && <Notice tone="success">账务操作已记录，相关订单和待处理事项已刷新。</Notice>}
    <Panel><div className="tabs" role="group" aria-label="对账记录类型"><SelectionIndicator active={section} underline />{([["matches", "支付关联"], ["exceptions", "账务异常"], ["conflicts", "账本冲突"]] as const).map(([value, text]) => <button type="button" key={value} aria-pressed={section === value} onClick={() => setSearch({ tab: value }, { replace: true })}>{text}</button>)}</div>
      <div className="list-toolbar"><form className="inline-search" onSubmit={(event) => { event.preventDefault(); navigate(`/reconciliation/ledger/${ledgerId.trim()}`); }}>
        <label className="search-input"><Search size={16} aria-hidden="true" /><span className="sr-only">账本流水编号</span><input name="ledger-lookup" required pattern={resourceIdPattern.source} value={ledgerId} onChange={(event) => setLedgerId(event.target.value)} placeholder="按完整流水编号追溯" /></label><Button type="submit">查询流水</Button>
      </form>{section !== "exceptions" && <label><span className="sr-only">对账状态筛选</span><select value={status} onChange={(event) => setSearch({ tab: section, status: event.target.value }, { replace: true })}>{allowed.map((value) => <option key={value} value={value}>{({ SETTLED: "已关联", REVERSED: "已撤销", OPEN: "待处理", RESOLVED: "已处理", IGNORED: "已隔离", ALL: "全部状态" } as Record<string, string>)[value]}</option>)}</select></label>}</div>
      <ReconciliationList key={`${section}:${status}`} section={section} status={status} />
    </Panel>
    {operation && <FinancialDialog mode={operation} onClose={() => setOperation(null)} onSuccess={() => { setOperation(null); setCompleted(true); }} />}
  </>;
}

function ReconciliationList({ section, status }: { section: Section; status: string }) {
  const pagination = useCursor();
  const query = useQuery({ queryKey: ["reconciliation", section, status, pagination.cursor], queryFn: async ({ signal }) => {
    const pageQuery = { limit: 20, ...(pagination.cursor ? { cursor: pagination.cursor } : {}) };
    if (section === "conflicts") {
      const page = await result(api.listLedgerConflicts({ signal, query: { ...pageQuery, status: status as "OPEN" | "RESOLVED" | "IGNORED" | "ALL" } }));
      return { page: page.page, items: page.data.map((item) => ({ id: item.conflict_id, title: label(item.conflict_type), orderId: null, status: item.status, createdAt: item.created_at })) };
    }
    if (section === "exceptions") {
      const page = await result(api.listOpenFinancialExceptions({ signal, query: pageQuery }));
      return { page: page.page, items: page.data.map((item) => ({ id: item.exception_id, title: label(item.exception_type), orderId: item.order_id, status: item.status, createdAt: item.created_at })) };
    }
    const page = await result(api.listPaymentMatches({ signal, query: { ...pageQuery, status: status as "SETTLED" | "REVERSED" } }));
    return { page: page.page, items: page.data.map((item) => ({ id: item.payment_match_id, title: item.evidence_type === "MANUAL" ? "人工关联" : "金额推断关联", orderId: item.order_id, status: item.status, createdAt: item.created_at })) };
  } });
  return <><div className="list-subtoolbar">{section === "exceptions" && <span>待处理异常</span>}<Button variant="quiet" pending={query.isFetching} onClick={() => { void query.refetch(); }}><RefreshCw size={14} />刷新</Button></div>
    <QueryView query={query}>{(page) => <>{page.items.length ? <div className="table-scroll" role="region" aria-label="对账记录列表" tabIndex={0}><table className="data-table"><thead><tr><th>记录 / 类型</th><th>关联订单</th><th>状态</th><th>创建时间</th></tr></thead><tbody>{page.items.map((item) => <LinkedTableRow key={item.id}>
      <td><Link className="table-primary" data-row-link to={`/reconciliation/${section}/${item.id}`}>{item.title}</Link><span className="table-secondary mono">{shortId(item.id)}</span></td><td>{item.orderId ? <Link className="mono" to={`/orders/${item.orderId}`}>{shortId(item.orderId)}</Link> : "—"}</td><td><Badge value={item.status} label={item.status === "OPEN" ? "待处理" : undefined} /></td><td>{dateTime(item.createdAt)}</td>
    </LinkedTableRow>)}</tbody></table></div> : <EmptyState title="暂无符合条件的记录" description="账本采集与自动对账运行后，相关记录会出现在这里。" />}<Pagination previousLabel={pagination.previousLabel} page={pagination.page} count={page.items.length} hasNext={!!page.page.next_cursor} pending={query.isFetching} onPrevious={pagination.previous} onNext={() => pagination.next(page.page.next_cursor)} /></>}</QueryView>
  </>;
}
