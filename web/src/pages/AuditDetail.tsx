import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { auditEventQuery, auditMetadataQuery } from "@/api/audit";
import { auditActionLabel, auditClientLabel, auditContextUnavailable, auditDuration, auditEventHref, auditSubjectLabel } from "@/lib/audit";
import { Link, useDetailBack } from "@/navigation";
import { AuditActor, AuditAggregation, AuditCaptureNotice, AuditChanges, AuditRecordType, AuditResult, AuditSite, AuditTime } from "@/components/audit-record";
import { DetailFields, DetailNavigation, DetailPage, TechnicalDetails } from "@/components/detail/DetailPrimitives";
import { DetailSection } from "@/components/detail/DetailSections";
import { CopyValue } from "@/components/copy-value";
import { PageHeading } from "@/components/page-heading";
import { PageHeaderActions } from "@/components/page-header-actions";
import { RefreshButton } from "@/components/refresh-button";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";

export default function AuditDetail() {
  const { source = "", eventId = "" } = useParams();
  return <AuditDetailView key={`${source}:${eventId}`} source={source} eventId={eventId} />;
}

function AuditDetailView({ source, eventId }: { source: string; eventId: string }) {
  const valid = (source === "core" || source === "activity") && !!eventId;
  const event = useQuery({ ...auditEventQuery(source === "activity" ? "activity" : "core", eventId), enabled: valid });
  const metadata = useQuery(auditMetadataQuery());
  const back = useDetailBack("/audit", "审计日志");
  const refreshing = event.isFetching || metadata.isFetching;
  const refresh = <RefreshButton busy={refreshing} disabled={!valid || refreshing} onClick={() => { void event.refetch(); void metadata.refetch(); }} />;
  return <DetailPage>
    <PageHeading title="审计日志详情" />
    <DetailNavigation back={back} identifier={eventId} identifierLabel="日志编号" global>
      <PageHeaderActions>{refresh}</PageHeaderActions>
    </DetailNavigation>
    {metadata.data && <AuditCaptureNotice capture={metadata.data.data.capture} compact />}
    <ErrorNotice error={metadata.error} retry={() => { void metadata.refetch(); }} retainedData={!!metadata.data} />
    {!valid ? <ErrorNotice error={new Error("日志地址无效，请返回审计日志列表。")} /> : <QueryView query={event}>
      {({ data }) => <>
        <Card aria-label="日志概况" className="detail-section" data-audit-summary>
          <CardHeader>
            <div className="flex min-w-0 flex-wrap items-center gap-2" data-detail-summary>
              <CardTitle role="heading" aria-level={2} className="min-w-0 wrap-anywhere">{auditActionLabel(data.action)}</CardTitle>
              <AuditResult outcome={data.outcome} source_type={data.source_type} http_status={data.http_status} is_aggregate={data.is_aggregate} action={data.action} />
              <AuditRecordType event={data} />
            </div>
          </CardHeader>
          <CardContent><DetailSection title="操作信息" headingLevel={3}><DetailFields density="comfortable" items={[
            [data.is_aggregate ? "排序时间" : "发生时间", <AuditTime value={data.occurred_at} />],
            ["执行者", <AuditActor event={data} />],
            ["关联网站", <AuditSite event={data} deleted={metadata.data?.data.sites.some(site => site.site_id === data.site_id && site.deleted) ?? false} />],
            ["操作对象", auditSubjectLabel(data.subject_type)],
          ]} /></DetailSection></CardContent>
        </Card>
        <AuditAggregation event={data} />
        <Card aria-label="来源与请求" className="detail-section" data-audit-source>
          <CardHeader><CardTitle role="heading" aria-level={2}>来源与请求</CardTitle></CardHeader>
          <CardContent><DetailFields density="comfortable" wide={["接口路径"]} items={[
            ["来源 IP", data.source_address ? <CopyValue value={data.source_address} label="复制来源 IP" /> : auditContextUnavailable(data)],
            ["设备 / 客户端", auditClientLabel(data)],
            ...(data.source_type === "HTTP" ? [
              ["HTTP 方法", data.http_method ?? auditContextUnavailable(data)],
              ["HTTP 状态", data.http_status ?? auditContextUnavailable(data)],
              ["接口路径", data.route ?? auditContextUnavailable(data)],
            ] as const : []),
            ...(!data.is_aggregate && data.duration_ms !== null ? [["耗时", auditDuration(data.duration_ms)] as const] : []),
          ]} /></CardContent>
        </Card>
        <AuditChanges changes={data.changes} category={data.category} />
        {data.related_activity_available === false && <Alert><AlertDescription>关联活动当前不可用，可能已超过保留期或未完整记录；这不影响当前核心审计记录。</AlertDescription></Alert>}
        {data.related_events.length > 0 && <Card aria-label="关联日志" className="detail-section">
          <CardHeader><CardTitle role="heading" aria-level={2}>关联日志</CardTitle></CardHeader>
          <CardContent><ItemGroup>{data.related_events.map(related => <Item role="listitem" key={`${related.source}:${related.event_id}`} className="px-0">
            <ItemContent><ItemTitle><Link global to={auditEventHref(related)} className="list-primary-link">{auditActionLabel(related.action)}</Link></ItemTitle>
              <ItemDescription><AuditTime value={related.occurred_at} /> · {related.source === "core" ? "核心审计" : "活动记录"} · {related.outcome === "SUCCESS" ? "成功" : "失败"}</ItemDescription>
            </ItemContent>
          </Item>)}</ItemGroup></CardContent>
        </Card>}
        <TechnicalDetails
          title="审计日志技术信息"
          data={{ action: data.action, category: data.category, source: data.source, source_type: data.source_type, sequence: data.sequence,
            subject_type: data.subject_type, subject_id: data.subject_id, context_recorded: data.context_recorded, duration_ms: data.duration_ms,
            request: { source_address: data.source_address, user_agent: data.user_agent, http_method: data.http_method, route: data.route, http_status: data.http_status }, details: data.details,
            changes: data.changes.map(change => change.kind === "redacted_change" ? { field: change.field, kind: change.kind, configured_before: change.configured_before, configured_after: change.configured_after } : change) }}
          identifiers={[["日志编号", data.event_id], ["对象编号", data.subject_id], ["请求编号", data.request_id], [data.is_aggregate ? "汇总组编号" : "关联活动编号", data.activity_id], ["事件哈希", data.event_hash], ["前一事件哈希", data.previous_hash], ["请求上下文指纹", data.context_fingerprint], ["历史来源哈希", data.remote_address_hash]]}>
          <div className="flex flex-col gap-2 text-xs text-muted-foreground">
            {data.is_aggregate && <p>活动汇总，不对应单次请求。</p>}
            <p>客户端名称根据 User-Agent 识别，原文保留于下方请求信息。</p>
            {data.related_events.length > 0 && <p>同一请求可能产生不同类别的日志；关联记录不表示操作执行了多次。</p>}
          </div>
        </TechnicalDetails>
      </>}
    </QueryView>}
  </DetailPage>;
}
