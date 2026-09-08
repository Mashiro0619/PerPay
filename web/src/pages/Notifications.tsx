import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Send } from "lucide-react";
import { useParams, useSearchParams } from "react-router";

import { Link } from "../navigation";

import { api, refreshOperationalData, result, type WebhookDeliveryStatus } from "../api/client";
import { ReasonDialog } from "../components/ReasonDialog";
import { LinkedTableRow } from "../components/LinkedTableRow";
import { Badge, Button, CopyValue, Details, EmptyState, JsonDetails, Notice, PageHeading, Pagination, Panel, QueryView, useCursor } from "../components/ui";
import { dateTime, shortId } from "../lib/format";
import { label } from "../lib/labels";

const statuses = [["", "全部状态"], ["PENDING", "等待投递"], ["LEASED", "投递中"], ["RETRY_WAIT", "等待重试"], ["ACKNOWLEDGED", "已确认送达"], ["DEAD_LETTER", "投递失败"]] as const;

export default function Notifications() {
  const [search, setSearch] = useSearchParams();
  const status = statuses.find(([value]) => value === search.get("status"))?.[0] ?? "";
  return <><PageHeading title="业务通知" actions={<Link className="button" to="/settings/notifications">通知设置</Link>} />
    <Panel><div className="list-toolbar"><span>通知投递记录</span><label><span className="sr-only">通知状态筛选</span><select value={status} onChange={(event) => setSearch(event.target.value ? { status: event.target.value } : {}, { replace: true })}>{statuses.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label></div>
      <DeliveryPage key={status} status={status || undefined} />
    </Panel>
  </>;
}

function DeliveryPage({ status }: { status: WebhookDeliveryStatus | undefined }) {
  const pagination = useCursor();
  const deliveries = useQuery({ queryKey: ["notifications", status, pagination.cursor], queryFn: ({ signal }) => result(api.listWebhookDeliveries({ signal, query: { limit: 20, ...(status ? { status } : {}), ...(pagination.cursor ? { cursor: pagination.cursor } : {}) } })) });
  return <><div className="list-subtoolbar"><Button variant="quiet" pending={deliveries.isFetching} onClick={() => { void deliveries.refetch(); }}><RefreshCw size={14} />刷新</Button></div>
    <QueryView query={deliveries}>{(page) => <>{page.data.length ? <div className="table-scroll" role="region" aria-label="通知列表" tabIndex={0}><table className="data-table"><thead><tr><th>事件 / 投递编号</th><th>关联订单</th><th>投递状态</th><th>尝试次数</th><th>下次尝试</th></tr></thead><tbody>{page.data.map((delivery) => <LinkedTableRow key={delivery.delivery_id}>
      <td><Link className="table-primary" data-row-link to={`/notifications/${delivery.delivery_id}`}>{label(delivery.event.event_type)}</Link><span className="table-secondary mono">{shortId(delivery.delivery_id)}</span></td>
      <td><Link className="mono" to={`/orders/${delivery.event.order_id}`}>{shortId(delivery.event.order_id)}</Link></td><td><Badge value={delivery.status} /></td><td className="numeric">{delivery.attempt_count}</td><td>{dateTime(delivery.next_attempt_at)}</td>
    </LinkedTableRow>)}</tbody></table></div> : <EmptyState title="暂无符合条件的通知" description="启用通知并创建带通知地址的订单后，付款事件会自动投递。" />}
      <Pagination page={pagination.page} count={page.data.length} hasNext={!!page.page.next_cursor} pending={deliveries.isFetching} onPrevious={pagination.previous} onNext={() => pagination.next(page.page.next_cursor)} />
    </>}</QueryView>
  </>;
}

export function NotificationDetail() {
  const { deliveryId = "" } = useParams();
  return <DeliveryDetail key={deliveryId} deliveryId={deliveryId} />;
}

function DeliveryDetail({ deliveryId }: { deliveryId: string }) {
  const [redeliver, setRedeliver] = useState(false);
  const [newDeliveryId, setNewDeliveryId] = useState<string | null>(null);
  const delivery = useQuery({ queryKey: ["notification", deliveryId], queryFn: ({ signal }) => result(api.getWebhookDelivery({ path: { deliveryId }, signal })) });
  const attempts = useQuery({ queryKey: ["notification-attempts", deliveryId], queryFn: ({ signal }) => result(api.listWebhookDeliveryAttempts({ path: { deliveryId }, signal })) });
  return <><PageHeading title="通知详情" back={{ to: "/notifications", label: "业务通知" }} actions={<Button pending={delivery.isFetching || attempts.isFetching} onClick={() => { void delivery.refetch(); void attempts.refetch(); }}><RefreshCw size={16} />刷新</Button>} />
    {newDeliveryId && <Notice tone="success">重发请求已创建，等待后台投递。<Link to={`/notifications/${newDeliveryId}`}>查看新投递记录</Link></Notice>}
    <QueryView query={delivery}>{({ data }) => <>
      <Panel title={label(data.event.event_type)} action={<Badge value={data.delivery.status} />} className="content-panel">
        <Details items={[["投递编号", <CopyValue value={data.delivery.delivery_id} />], ["关联订单", <Link to={`/orders/${data.event.order_id}`}>{shortId(data.event.order_id)}</Link>], ["通知地址", <CopyValue value={data.target.target_url} />], ["创建时间", dateTime(data.delivery.created_at)], ["尝试次数", data.delivery.attempt_count], ["投递代次", data.delivery.generation], ["下次尝试", dateTime(data.delivery.next_attempt_at)], ["确认时间", dateTime(data.delivery.acknowledged_at)], ["最近错误", data.delivery.last_error_code ?? "无"], ["发起方", data.delivery.requested_by_type === "ADMIN" ? "管理员" : "系统"], ["上一次投递", data.delivery.predecessor_delivery_id ? <Link to={`/notifications/${data.delivery.predecessor_delivery_id}`}>{shortId(data.delivery.predecessor_delivery_id)}</Link> : "原始投递"], ["重发理由", data.delivery.reason ?? "—"]]} />
        {["ACKNOWLEDGED", "DEAD_LETTER"].includes(data.delivery.status) ? <div className="form-actions"><Button onClick={() => setRedeliver(true)} disabled={!!newDeliveryId}><Send size={16} />重新投递</Button><span className="field-hint">仅最新一代的已确认或失败通知允许人工重发。</span></div> : <Notice>此通知仍在自动投递流程中。请先等待完成，避免同时发起重复投递。</Notice>}
      </Panel>
      <Panel title="投递尝试"><QueryView query={attempts}>{({ data: records }) => records.length ? <div className="table-scroll" role="region" aria-label="通知投递尝试" tabIndex={0}><table className="data-table"><thead><tr><th>次数</th><th>开始时间</th><th>结果</th><th>HTTP 状态</th><th>确认码 / 错误</th></tr></thead><tbody>{records.map((attempt) => <tr key={attempt.attempt_id}><td>第 {attempt.attempt_number} 次</td><td>{dateTime(attempt.started_at)}</td><td>{label(attempt.outcome)}</td><td>{attempt.http_status ?? "—"}</td><td><code>{attempt.error_code ?? attempt.ack_code ?? "—"}</code></td></tr>)}</tbody></table></div> : <EmptyState title="尚未开始投递" headingLevel={3} />}</QueryView></Panel>
      <JsonDetails data={data.event} label="查看业务事件与负载" />
      {redeliver && <ReasonDialog title="重新投递业务通知" description="这会新建一代投递记录。业务接收方必须按事件编号幂等处理，即使以前已经确认过该事件。" action="确认重新投递" onClose={() => setRedeliver(false)} execute={async (reason, operationId) => {
        const response = await result(api.redeliverWebhookDelivery({ path: { deliveryId }, body: { reason, redelivery_id: operationId } }));
        setNewDeliveryId(response.data.delivery.delivery_id);
      }} onSuccess={() => { setRedeliver(false); void refreshOperationalData(); }}><Details items={[["事件", label(data.event.event_type)], ["通知地址", data.target.target_url]]} /></ReasonDialog>}
    </>}</QueryView>
  </>;
}
