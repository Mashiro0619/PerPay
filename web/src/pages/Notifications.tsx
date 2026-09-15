import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useParams, useSearchParams } from "react-router";

import { Link, useDetailBack } from "../navigation";

import { api, refreshOperationalData, result, type WebhookDeliveryStatus } from "../api/client";
import { DeliveryCard } from "../components/detail/NotificationEvidence";
import { RelatedOrder } from "../components/detail/DetailPrimitives";
import { LinkedTableRow } from "../components/LinkedTableRow";
import { Badge, Button, EmptyState, ErrorNotice, PageHeading, Pagination, Panel, QueryView, useCursor } from "../components/ui";
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
      <Pagination previousLabel={pagination.previousLabel} page={pagination.page} count={page.data.length} hasNext={!!page.page.next_cursor} pending={deliveries.isFetching} onPrevious={pagination.previous} onNext={() => pagination.next(page.page.next_cursor)} />
    </>}</QueryView>
  </>;
}

export function NotificationDetail() {
  const { deliveryId = "" } = useParams();
  return <DeliveryDetail key={deliveryId} deliveryId={deliveryId} />;
}
function DeliveryDetail({ deliveryId }: { deliveryId: string }) {
  const back = useDetailBack("/notifications", "业务通知");
  const delivery = useQuery({ queryKey: ["notification", deliveryId], queryFn: ({ signal }) => result(api.getWebhookDelivery({ path: { deliveryId }, signal })) });
  const attempts = useQuery({ queryKey: ["notification-attempts", deliveryId], queryFn: ({ signal }) => result(api.listWebhookDeliveryAttempts({ path: { deliveryId }, signal })) });
  return <div className="detail-page"><PageHeading title="通知详情" back={back} actions={<Button pending={delivery.isFetching || attempts.isFetching} onClick={() => { void refreshOperationalData(); }}><RefreshCw size={16} />刷新</Button>} />
    <QueryView query={delivery}>{({ data }) => <Panel className="detail-panel"><RelatedOrder orderId={data.event.order_id} />
      <ErrorNotice error={attempts.error} retry={() => { void attempts.refetch(); }} />
      <DeliveryCard detail={{ ...data, attempts: attempts.data?.data ?? [] }} attemptsAvailable={!!attempts.data} />
    </Panel>}</QueryView>
  </div>;
}
