import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { auditEventQuery, auditMetadataQuery } from "@/api/audit";
import { auditActionLabel, auditClientLabel, auditContextUnavailable, auditDuration, auditEventHref } from "@/lib/audit";
import { Link, useDetailBack } from "@/navigation";
import { AuditActor, AuditAggregation, AuditCaptureNotice, AuditCategory, AuditChanges, AuditRecordType, AuditResult, AuditRetention, AuditSite, AuditTime } from "@/components/audit-record";
import { DetailFields, DetailNavigation, DetailPage, TechnicalDetailsDialog } from "@/components/detail/DetailPrimitives";
import { CopyValue } from "@/components/copy-value";
import { PageHeading } from "@/components/page-heading";
import { PageHeaderActions } from "@/components/page-header-actions";
import { RefreshButton } from "@/components/refresh-button";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
  const [technical, setTechnical] = useState(false);
  const technicalTrigger = useRef<HTMLButtonElement>(null);
  const refreshing = event.isFetching || metadata.isFetching;
  return <DetailPage>
    <PageHeading title="审计日志详情" />
    <DetailNavigation back={back} identifier={eventId} identifierLabel="日志编号" global>
      <PageHeaderActions><RefreshButton busy={refreshing} disabled={!valid || refreshing} onClick={() => { void event.refetch(); void metadata.refetch(); }} /></PageHeaderActions>
    </DetailNavigation>
    <AuditRetention />
    {metadata.data && <AuditCaptureNotice capture={metadata.data.data.capture} />}
    <ErrorNotice error={metadata.error} retry={() => { void metadata.refetch(); }} retainedData={!!metadata.data} />
    {!valid ? <ErrorNotice error={new Error("日志地址无效，请返回审计日志列表。")} /> : <QueryView query={event}>
      {({ data }) => <>
        <Card aria-label="日志概况">
          <CardHeader>
            <CardTitle role="heading" aria-level={2} className="min-w-0 wrap-anywhere">{auditActionLabel(data.action)}</CardTitle>
            <CardDescription><AuditRecordType event={data} /></CardDescription>
            <CardAction><Button ref={technicalTrigger} variant="outline" onClick={() => setTechnical(true)}>技术详情</Button></CardAction>
          </CardHeader>
          <CardContent><DetailFields density="comfortable" items={[
            ["操作结果", <AuditResult outcome={data.outcome} source_type={data.source_type} http_status={data.http_status} is_aggregate={data.is_aggregate} action={data.action} />],
            [data.is_aggregate ? "排序时间" : "发生时间", <AuditTime value={data.occurred_at} />],
            ["操作类别", <AuditCategory category={data.category} />],
            ["操作标识", data.action],
            ["执行者", <AuditActor event={data} />],
            ["关联网站", <AuditSite event={data} deleted={metadata.data?.data.sites.some(site => site.site_id === data.site_id && site.deleted) ?? false} />],
            ["对象类型", data.subject_type ?? "未记录"],
            ["对象编号", data.subject_id ? <CopyValue value={data.subject_id} label="复制对象编号" /> : "未记录"],
            ...(!data.is_aggregate ? [["耗时", auditDuration(data.duration_ms)] as const] : []),
          ]} /></CardContent>
        </Card>
        <AuditAggregation event={data} />
        <Card aria-label="来源与请求">
          <CardHeader><CardTitle role="heading" aria-level={2}>来源与请求</CardTitle>
            <CardDescription>客户端名称根据 User-Agent 识别，仅供追溯参考。完整原文见技术详情。</CardDescription>
          </CardHeader>
          <CardContent><DetailFields density="comfortable" wide={["接口路径"]} items={[
            ["来源 IP", data.source_address ? <CopyValue value={data.source_address} label="复制来源 IP" /> : auditContextUnavailable(data)],
            ["设备 / 客户端", auditClientLabel(data)],
            ["请求编号", data.is_aggregate ? "分钟汇总，不对应单次请求" : data.request_id ? <CopyValue value={data.request_id} label="复制请求编号" /> : "未记录"],
            ["HTTP 方法", data.http_method ?? auditContextUnavailable(data)],
            ["HTTP 状态", data.http_status ?? auditContextUnavailable(data)],
            ["接口路径", data.route ?? auditContextUnavailable(data)],
          ]} /></CardContent>
        </Card>
        <AuditChanges changes={data.changes} category={data.category} />
        {data.related_activity_available === false && <Alert><AlertDescription>关联活动当前不可用，可能已超过保留期或未完整记录；这不影响当前核心审计记录。</AlertDescription></Alert>}
        {data.related_events.length > 0 && <Card aria-label="关联日志">
          <CardHeader><CardTitle role="heading" aria-level={2}>关联日志</CardTitle>
            <CardDescription>同一请求可能产生不同类别的日志；关联记录不表示操作执行了多次。</CardDescription>
          </CardHeader>
          <CardContent><ItemGroup>{data.related_events.map(related => <Item key={`${related.source}:${related.event_id}`} className="px-0">
            <ItemContent><ItemTitle><Link global to={auditEventHref(related)} className="list-primary-link">{auditActionLabel(related.action)}</Link></ItemTitle>
              <ItemDescription><AuditTime value={related.occurred_at} /> · {related.source === "core" ? "核心审计" : "活动记录"} · {related.outcome === "SUCCESS" ? "成功" : "失败"}</ItemDescription>
            </ItemContent>
          </Item>)}</ItemGroup></CardContent>
        </Card>}
        <TechnicalDetailsDialog open={technical} onOpenChange={setTechnical} finalFocus={() => technicalTrigger.current}
          data={{ action: data.action, source: data.source, sequence: data.sequence, context_recorded: data.context_recorded,
            request: { source_address: data.source_address, user_agent: data.user_agent, http_method: data.http_method, route: data.route, http_status: data.http_status }, details: data.details,
            changes: data.changes.map(change => change.kind === "redacted_change" ? { field: change.field, kind: change.kind, configured_before: change.configured_before, configured_after: change.configured_after } : change) }}
          identifiers={[["日志编号", data.event_id], ["请求编号", data.request_id], [data.is_aggregate ? "汇总组编号" : "关联活动编号", data.activity_id], ["事件哈希", data.event_hash], ["前一事件哈希", data.previous_hash], ["请求上下文指纹", data.context_fingerprint], ["历史来源哈希", data.remote_address_hash]]} />
      </>}
    </QueryView>}
  </DetailPage>;
}
