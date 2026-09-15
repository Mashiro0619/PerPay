import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, refreshOperationalData, result, type OrderWebhookDeliveryDetail, type WebhookDeliveryDetail, type WebhookAttempt } from "../../api/client";
import { Badge, Button, CopyValue, ErrorNotice, JsonDetails, Pagination, useCursor } from "../ui";
import { ReasonDialog } from "../ReasonDialog";
import { attemptResult, latestAttempt, notificationErrorName } from "../../lib/detail-summary";
import { dateTime } from "../../lib/format";
import { label } from "../../lib/labels";
import { DetailFields, DetailLink, LazyDetails, TechnicalDetails } from "./DetailPrimitives";

type DeliveryContext = WebhookDeliveryDetail & { attempts: readonly WebhookAttempt[] };
export function DeliveryCard({ detail, embedded = false, attemptsAvailable = true, sectionTitle }: { detail: DeliveryContext; embedded?: boolean; attemptsAvailable?: boolean; sectionTitle?: string }) {
  const [snapshot, setSnapshot] = useState<DeliveryContext | null>(null);
  const [sent, setSent] = useState(false);
  const delivery = detail.delivery;
  const last = latestAttempt(detail.attempts);
  const terminal = delivery.status === "ACKNOWLEDGED" || delivery.status === "DEAD_LETTER";
  return <article className="detail-record" aria-label="业务通知记录">
    <div className="detail-record-heading"><div className="detail-record-identity">{sectionTitle ? <><h2>{sectionTitle}</h2><span className="detail-muted">{label(detail.event.event_type)}</span></> : <h3>{label(detail.event.event_type)}</h3>}</div><div className="detail-statuses">{!detail.is_latest && <span className="detail-muted">历史投递</span>}<Badge value={delivery.status} /></div></div>
    <DetailFields wide={["通知地址", "重发理由"]} items={[["最近结果", attemptsAvailable ? attemptResult(last) : "投递尝试尚未读取"], ["投递次数", delivery.attempt_count + " 次"],
      ["通知地址", <CopyValue value={detail.target.target_url} label="复制通知地址" />], ["发起时间", dateTime(delivery.created_at)],
      ...(delivery.next_attempt_at && !terminal ? [["下次重试", dateTime(delivery.next_attempt_at)] as const] : []),
      ...(delivery.acknowledged_at ? [["业务确认时间", dateTime(delivery.acknowledged_at)] as const] : []),
      ...(delivery.last_error_code && delivery.last_error_code !== last?.error_code ? [["最近错误", notificationErrorName(delivery.last_error_code)] as const] : []),
      ...(delivery.requested_by_type === "ADMIN" ? [["发起人", delivery.requested_by_actor_id ?? "管理员"] as const] : []),
      ...(delivery.reason ? [["重发理由", delivery.reason] as const] : []),
    ]} />
    <div className="detail-record-footer"><div className="detail-actions">{terminal && detail.is_latest && <Button disabled={sent} onClick={() => setSnapshot(detail)}>重新投递</Button>}
      {!terminal && <span className="detail-muted">仍在自动投递流程中，无需手动重发。</span>}{terminal && !detail.is_latest && <span className="detail-muted">已有后续投递，旧记录不能再次重发。</span>}
      {sent && <span role="status" className="detail-feedback">已创建新的投递记录，等待后台发送。</span>}
    </div>{embedded && <DetailLink to={"/notifications/" + delivery.delivery_id} />}</div>
    <LazyDetails className="detail-disclosure" summary={"投递尝试（" + detail.attempts.length + "）"}>{detail.attempts.length ? <div className="detail-attempts"><table><thead><tr><th>次数 / 开始时间</th><th>结果</th><th>HTTP / ACK</th></tr></thead><tbody>{detail.attempts.map(attempt => <tr key={attempt.attempt_id}><td>第 {attempt.attempt_number} 次<time dateTime={attempt.started_at}>{dateTime(attempt.started_at)}</time></td><td>{label(attempt.outcome)}</td><td>{attemptResult(attempt)}</td></tr>)}</tbody></table></div> : <p className="detail-empty">{attemptsAvailable ? "尚未开始投递" : "投递尝试尚未读取，请稍后重试。"}</p>}
      <JsonDetails data={detail.attempts} label="查看投递技术字段" />
    </LazyDetails>
    <JsonDetails data={detail.event.payload} label="业务事件与载荷" />
    <TechnicalDetails data={{ delivery, target: detail.target, event_id: detail.event.event_id }} identifiers={[["投递编号", delivery.delivery_id], ["事件编号", detail.event.event_id]]} label="通知技术详情" />
    {snapshot && <ReasonDialog title="重新投递业务通知" description="这会新建一代投递记录。业务接收方必须按事件编号幂等处理，即使以前已经确认过该事件。" action="确认重新投递" onClose={() => setSnapshot(null)}
      execute={(reason, operationId) => result(api.redeliverWebhookDelivery({ path: { deliveryId: snapshot.delivery.delivery_id }, body: { reason, redelivery_id: operationId } }))}
      onSuccess={() => { setSnapshot(null); setSent(true); void refreshOperationalData(); }}><DetailFields items={[["事件", label(snapshot.event.event_type)], ["通知地址", snapshot.target.target_url]]} /></ReasonDialog>}
  </article>;
}
export function OrderNotifications({ orderId, notifyUrl }: { orderId: string; notifyUrl: string | null }) {
  const pagination = useCursor();
  const query = useQuery({ queryKey: ["order-notifications", orderId, pagination.cursor], queryFn: ({ signal }) => result(api.listAdministratorOrderWebhookDeliveries({ path: { orderId }, signal, query: { limit: 10, ...(pagination.cursor ? { cursor: pagination.cursor } : {}) } })) });
  return <div className="order-notification-content">{!query.data?.data.length && <header className="detail-record-heading detail-empty-heading"><h2>业务通知</h2></header>}<ErrorNotice error={query.error} retry={() => { void query.refetch(); }} />
    {query.isPending ? <p className="detail-empty" role="status">正在读取通知结果…</p> : query.data && <>
      {query.data.data.length ? query.data.data.map((detail: OrderWebhookDeliveryDetail, index: number) => index === 0 ? <DeliveryCard key={detail.delivery.delivery_id} detail={detail} embedded sectionTitle="业务通知" /> : <details className="detail-disclosure detail-history-row" key={detail.delivery.delivery_id}><summary><span>{label(detail.event.event_type)} · {dateTime(detail.delivery.created_at)}</span><Badge value={detail.delivery.status} /></summary><DeliveryCard detail={detail} embedded /></details>) : <p className="detail-empty">{pagination.page > 1 ? "这一页没有投递记录，请返回上一页。" : notifyUrl ? "已配置业务通知，尚未产生投递记录。" : "此订单未配置业务通知。"}</p>}
      {(pagination.page > 1 || !!query.data.page.next_cursor) && <Pagination previousLabel={pagination.previousLabel} page={pagination.page} count={query.data.data.length} hasNext={!!query.data.page.next_cursor} pending={query.isFetching} onPrevious={pagination.previous} onNext={() => pagination.next(query.data!.page.next_cursor)} />}
    </>}
  </div>;
}
