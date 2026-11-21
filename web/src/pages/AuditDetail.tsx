import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import type { AuditEventDetail } from "../../../src/shared/audit";
import { auditEventQuery, auditMetadataQuery } from "@/api/audit";
import { auditActionLabel, auditClientLabel, auditContextUnavailable, auditDuration, auditEventHref, auditSubjectLabel } from "@/lib/audit";
import { useDetailBack } from "@/navigation";
import { AuditActor, AuditAggregation, AuditCaptureNotice, AuditChanges, AuditRecordLink, AuditRecordType, AuditResult, AuditSite } from "@/components/audit-record";
import { DetailNavigation, DetailPage, TechnicalDetails } from "@/components/detail/DetailPrimitives";
import { OverlaySummary } from "@/components/overlay-actions";
import { PageHeading } from "@/components/page-heading";
import { PageHeaderActions } from "@/components/page-header-actions";
import { Disclosure } from "@/components/record/Disclosure";
import { FieldList } from "@/components/record/FieldList";
import { RecordNotice, RecordSummary, type SectionLink } from "@/components/record/RecordSummary";
import { Section, Sections } from "@/components/record/Sections";
import { RecordTime } from "@/components/record/Timeline";
import { RefreshButton } from "@/components/refresh-button";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { apiErrorMessage } from "@/lib/api-errors";

export default function AuditDetail() {
  const { source = "", eventId = "" } = useParams();
  return <AuditDetailView key={`${source}:${eventId}`} source={source} eventId={eventId} />;
}

function failureReason(event: AuditEventDetail): string {
  if (typeof event.details.reason === "string" && event.details.reason) return event.details.reason;
  return typeof event.details.error_code === "string"
    ? apiErrorMessage(event.details.error_code, null, event.http_status ?? 500) : "这条历史记录未保存具体原因。";
}

function AuditDetailView({ source, eventId }: { source: string; eventId: string }) {
  const valid = (source === "core" || source === "activity") && !!eventId;
  const event = useQuery({ ...auditEventQuery(source === "activity" ? "activity" : "core", eventId), enabled: valid });
  const metadata = useQuery(auditMetadataQuery());
  const back = useDetailBack("/audit", "审计日志");
  const refreshing = event.isFetching || metadata.isFetching;
  const refresh = <RefreshButton busy={refreshing} disabled={!valid || refreshing} onClick={() => { void event.refetch(); void metadata.refetch(); }} />;
  return <DetailPage>
    {/* Until the event is read, the overlay shows its route title as the heading. */}
    {event.data && <PageHeading title={auditActionLabel(event.data.data.action)} eyebrow={event.data.data.site_id ? event.data.data.site_name || event.data.data.site_id : undefined} />}
    <DetailNavigation back={back} global>
      <PageHeaderActions>{refresh}</PageHeaderActions>
    </DetailNavigation>
    {metadata.data && <AuditCaptureNotice capture={metadata.data.data.capture} compact />}
    <ErrorNotice error={metadata.error} retry={() => { void metadata.refetch(); }} retainedData={!!metadata.data} />
    {!valid ? <ErrorNotice error={new Error("日志地址无效，请返回审计日志列表。")} /> : <QueryView query={event}>
      {({ data }) => <AuditRecord event={data} siteDeleted={metadata.data?.data.sites.some(site => site.site_id === data.site_id && site.deleted) ?? false} />}
    </QueryView>}
  </DetailPage>;
}

function AuditRecord({ event, siteDeleted }: { event: AuditEventDetail; siteDeleted: boolean }) {
  const http = event.source_type === "HTTP";
  const related = event.related_events.length > 0 || event.related_activity_available === false;
  const relatedCount = event.related_events.length > 0 ? { count: event.related_events.length } : {};
  const sections: SectionLink[] = [
    { id: "overview", label: "操作信息" },
    ...(event.is_aggregate ? [{ id: "aggregate", label: "活动汇总" }] : []),
    ...(event.changes.length > 0 ? [{ id: "changes", label: "配置变更" }] : []),
    ...(related ? [{ id: "related", label: "关联日志", ...relatedCount }] : []),
  ];
  return <>
    <OverlaySummary>
      {/* The record has no amount or status phrase of its own, so its badges lead the summary. */}
      <RecordSummary label="日志概况"
        status={<><AuditResult outcome={event.outcome} source_type={event.source_type} http_status={event.http_status} is_aggregate={event.is_aggregate} action={event.action} /><AuditRecordType event={event} /></>}
        meta={[<><RecordTime value={event.occurred_at} /> · <AuditActor event={event} /></>]}
        nav={sections} />
    </OverlaySummary>
    {event.outcome === "FAILURE" && <RecordNotice tone="danger">
      <p className="font-medium">失败原因</p>
      <p>{failureReason(event)}</p>
    </RecordNotice>}
    <Sections>
      <Section id="overview" title="操作信息">
        <FieldList items={[
          { label: event.is_aggregate ? "排序时间" : "发生时间", value: <RecordTime value={event.occurred_at} />, kind: "time" },
          { label: "执行者", value: <AuditActor event={event} /> },
          { label: "关联网站", value: <AuditSite event={event} deleted={siteDeleted} record /> },
          { label: "操作对象", value: event.subject_type === "alipay_account" && event.subject_id
            ? <AuditRecordLink to={"/settings/accounts/" + encodeURIComponent(event.subject_id)}>查看支付宝账号</AuditRecordLink>
            : auditSubjectLabel(event.subject_type) },
          { label: "来源 IP", value: event.source_address ?? auditContextUnavailable(event), kind: event.source_address ? "id" : "text", copy: event.source_address },
          { label: "设备 / 客户端", value: auditClientLabel(event) },
          http && { label: "HTTP 方法", value: event.http_method ?? auditContextUnavailable(event) },
          http && { label: "HTTP 状态", value: event.http_status ?? auditContextUnavailable(event) },
          http && { label: "接口路径", value: event.route ?? auditContextUnavailable(event), kind: event.route ? "id" : "text" },
          !event.is_aggregate && event.duration_ms !== null && { label: "耗时", value: auditDuration(event.duration_ms) },
          { label: "日志编号", value: event.event_id, kind: "id", copy: event.event_id },
        ]} />
        {event.user_agent && <Disclosure label="设备信息">
          <p className="font-mono text-xs leading-5 text-muted-foreground wrap-anywhere">{event.user_agent}</p>
        </Disclosure>}
      </Section>
      <AuditAggregation event={event} />
      <AuditChanges changes={event.changes} category={event.category} />
      {related && <Section id="related" title="关联日志" {...relatedCount}>
        {event.related_activity_available === false && <p className="text-[0.8125rem] leading-5 text-muted-foreground">关联活动当前不可用，可能已超过保留期或未完整记录；这不影响当前核心审计记录。</p>}
        {event.related_events.length > 0 && <ul className="flex min-w-0 flex-col gap-3">
          {event.related_events.map(item => <li key={`${item.source}:${item.event_id}`} className="flex min-w-0 flex-col gap-0.5 text-sm leading-5">
            <AuditRecordLink to={auditEventHref(item)}>{auditActionLabel(item.action)}</AuditRecordLink>
            <p className="text-[0.8125rem] text-muted-foreground"><RecordTime value={item.occurred_at} /> · {item.source === "core" ? "核心审计" : "活动记录"} · {item.outcome === "SUCCESS" ? "成功" : "失败"}</p>
          </li>)}
        </ul>}
      </Section>}
    </Sections>
    {/* The record has no footer, so its only technical entry closes the content. */}
    <TechnicalDetails
      title="审计日志技术信息"
      data={{ action: event.action, category: event.category, source: event.source, source_type: event.source_type, sequence: event.sequence,
        subject_type: event.subject_type, subject_id: event.subject_id, context_recorded: event.context_recorded, duration_ms: event.duration_ms,
        request: { source_address: event.source_address, user_agent: event.user_agent, http_method: event.http_method, route: event.route, http_status: event.http_status }, details: event.details,
        changes: event.changes.map(change => change.kind === "redacted_change" ? { field: change.field, kind: change.kind, configured_before: change.configured_before, configured_after: change.configured_after } : change) }}
      identifiers={[["日志编号", event.event_id], ["对象编号", event.subject_id], ["请求编号", event.request_id], [event.is_aggregate ? "汇总组编号" : "关联活动编号", event.activity_id], ["事件哈希", event.event_hash], ["前一事件哈希", event.previous_hash], ["请求上下文指纹", event.context_fingerprint], ["历史来源哈希", event.remote_address_hash]]}>
      <div className="flex flex-col gap-2 text-xs text-muted-foreground">
        {event.is_aggregate && <p>活动汇总，不对应单次请求。</p>}
        <p>客户端名称根据 User-Agent 识别，原文保留于下方请求信息。</p>
        {event.related_events.length > 0 && <p>同一请求可能产生不同类别的日志；关联记录不表示操作执行了多次。</p>}
      </div>
    </TechnicalDetails>
  </>;
}
