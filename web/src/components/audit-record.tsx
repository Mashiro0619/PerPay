import { Fragment } from "react";
import type { AuditChange, AuditEventItem, AuditMetadata } from "../../../src/shared/audit";
import { AUDIT_CATEGORY_LABELS } from "../../../src/shared/audit";
import { Link } from "@/navigation";
import { AUDIT_ACTOR_LABELS, AUDIT_RECORD_LABELS, auditChangeValues, auditClientLabel, auditContextUnavailable, auditDateTime, auditDuration, auditFieldLabel } from "@/lib/audit";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemContent, ItemGroup, ItemSeparator, ItemTitle } from "@/components/ui/item";
import { DetailFields } from "@/components/detail/DetailPrimitives";

export function AuditTime({ value }: { value: string }) {
  return <time dateTime={value} title={auditDateTime(value) + "（北京时间）"} className="list-time tabular-nums">{auditDateTime(value)}</time>;
}

export function AuditResult({ outcome, source_type, http_status, is_aggregate, action }: Pick<AuditEventItem, "outcome" | "source_type" | "http_status" | "is_aggregate" | "action">) {
  const label = outcome === "FAILURE" ? "失败"
    : source_type === "CORE" && action.endsWith(".export_generated") ? "文件已生成"
      : source_type === "HTTP" && http_status === 202 ? "已接受"
        : source_type === "BACKGROUND" ? is_aggregate ? "运行成功" : "本轮完成"
          : source_type === "MAINTENANCE" ? "已完成" : "成功";
  return <Badge variant={outcome === "SUCCESS" ? "success" : "destructive"}>{label}</Badge>;
}

export function AuditRecordType({ event }: { event: AuditEventItem }) {
  return <div className="flex min-w-0 flex-wrap items-center gap-1.5">
    <Badge variant="outline">{AUDIT_RECORD_LABELS[event.source_type] ?? event.source_type}</Badge>
    {event.is_aggregate && <Badge variant="secondary">分钟汇总 · {event.event_count.toLocaleString("zh-CN")} 次</Badge>}
  </div>;
}

export function AuditSite({ event, deleted = false }: { event: Pick<AuditEventItem, "site_id" | "site_name">; deleted?: boolean }) {
  if (!event.site_id) return <span>未关联网站</span>;
  const title = event.site_name || event.site_id;
  if (deleted) return <span className="wrap-anywhere">{title}（已删除）</span>;
  return <Link global to={"/sites/" + encodeURIComponent(event.site_id) + "/summary"} title={event.site_id} className="list-secondary-link wrap-anywhere">{title}</Link>;
}

export function AuditActor({ event }: { event: Pick<AuditEventItem, "actor_type" | "actor_id"> }) {
  const label = AUDIT_ACTOR_LABELS[event.actor_type] ?? event.actor_type;
  return <span className="wrap-anywhere">{label}{event.actor_id ? ` · ${event.actor_id}` : ""}</span>;
}

export function AuditSourceInfo({ event }: { event: AuditEventItem }) {
  if (!event.source_address && !event.user_agent) return <span className="text-xs text-muted-foreground">来源：{auditContextUnavailable(event)}</span>;
  return <div className="flex min-w-0 flex-col gap-1">
    <span className="list-code wrap-anywhere">{event.source_address ?? auditContextUnavailable(event)}</span>
    {event.user_agent && <span className="text-xs text-muted-foreground">{auditClientLabel(event)}</span>}
  </div>;
}

export function AuditRetention() {
  return <p className="text-xs text-muted-foreground" data-audit-retention>核心审计持续保留；活动记录保留 30 天。成功查询按分钟汇总。</p>;
}

export function AuditCaptureNotice({ capture, compact = false }: Pick<AuditMetadata, "capture"> & { compact?: boolean }) {
  const gaps = capture.dropped_events > 0 || capture.spool_gap_count > 0;
  const errors = capture.write_failures > 0 || capture.spool_failures > 0;
  if (capture.state === "healthy" && !gaps && !errors) return compact ? null : <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-audit-capture>
    <span>采集正常 · {capture.last_flush_at ? <>最近成功写入：<AuditTime value={capture.last_flush_at} /></> : "等待首次成功写入"}</span>
    {capture.spool_last_import_at && <span>最近维护日志导入：<AuditTime value={capture.spool_last_import_at} /></span>}
    {capture.buffered_events > 0 && <span>等待写入：{capture.buffered_events.toLocaleString("zh-CN")} 条</span>}
  </div>;
  return <Alert variant={capture.state === "healthy" ? "default" : "destructive"} data-audit-capture>
    <AlertTitle>{gaps ? "部分活动日志未完整记录" : capture.state === "unavailable" ? "采集状态暂不可用" : capture.state === "degraded" ? "日志采集异常" : "日志采集曾出现异常"}</AlertTitle>
    <AlertDescription>
      <p>仍可查看已保存的日志；没有新记录不代表这段时间没有系统活动。</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {capture.dropped_events > 0 && <span>未记录活动：{capture.dropped_events.toLocaleString("zh-CN")} 条</span>}
        {capture.write_failures > 0 && <span>写入失败：{capture.write_failures.toLocaleString("zh-CN")} 次</span>}
        {capture.spool_failures > 0 && <span>维护日志导入失败：{capture.spool_failures.toLocaleString("zh-CN")} 次</span>}
        {capture.spool_gap_count > 0 && <span>维护日志缺口：{capture.spool_gap_count.toLocaleString("zh-CN")} 处</span>}
        {capture.buffered_events > 0 && <span>等待写入：{capture.buffered_events.toLocaleString("zh-CN")} 条</span>}
      </div>
      {!compact && capture.last_flush_at && <p>最近成功写入：<AuditTime value={capture.last_flush_at} /></p>}
      {!compact && capture.spool_last_import_at && <p>最近维护日志导入：<AuditTime value={capture.spool_last_import_at} /></p>}
      {!compact && capture.last_error_code && <p className="wrap-anywhere">错误代码：{capture.last_error_code}</p>}
    </AlertDescription>
  </Alert>;
}

export function AuditAggregation({ event }: { event: AuditEventItem }) {
  if (!event.is_aggregate) return null;
  return <Card aria-label="分钟汇总">
    <CardHeader>
      <CardTitle role="heading" aria-level={2}>分钟汇总 · {event.event_count.toLocaleString("zh-CN")} 次</CardTitle>
      <CardDescription>同类成功活动的分钟统计；本条记录不对应一次独立请求。</CardDescription>
    </CardHeader>
    <CardContent>
      <DetailFields items={[
        ["首次发生", <AuditTime value={event.first_occurred_at} />],
        ["最后发生", <AuditTime value={event.last_occurred_at} />],
        ["发生次数", event.event_count.toLocaleString("zh-CN")],
        ["累计耗时", auditDuration(event.duration_ms)],
        ["平均耗时", auditDuration(event.duration_ms === null || event.event_count <= 0 ? null : event.duration_ms / event.event_count)],
      ]} />
    </CardContent>
  </Card>;
}

export function AuditChanges({ changes, category }: { changes: readonly AuditChange[]; category: AuditEventItem["category"] }) {
  if (changes.length === 0 && category !== "configuration") return null;
  return <Card aria-label="配置变更">
    <CardHeader>
      <CardTitle role="heading" aria-level={2}>配置变更</CardTitle>
      <CardDescription>只列出已记录的变更字段。密码、密钥等敏感值仅保留变更状态。</CardDescription>
    </CardHeader>
    <CardContent>
      {changes.length === 0 ? <p className="text-sm text-muted-foreground">这条记录未保存前后值，不能据此判断没有配置变更。</p> : <ItemGroup>
        {changes.map((change, index) => {
          const [before, after] = auditChangeValues(change);
          return <Fragment key={change.field}>
            {index > 0 && <ItemSeparator aria-hidden="true" />}
            <Item role="listitem" className="min-w-0 px-0">
              <ItemContent className="min-w-0">
                <ItemTitle className="wrap-anywhere" title={change.field}>{auditFieldLabel(change.field)}</ItemTitle>
                <DetailFields items={[["变更前", before], ["变更后", after]]} />
              </ItemContent>
            </Item>
          </Fragment>;
        })}
      </ItemGroup>}
    </CardContent>
  </Card>;
}

export function AuditCategory({ category, sourceType }: Pick<AuditEventItem, "category"> & { sourceType?: AuditEventItem["source_type"] }) {
  const label = AUDIT_CATEGORY_LABELS[category] ?? category;
  if (sourceType && AUDIT_RECORD_LABELS[sourceType] === label) return null;
  return <span>{label}</span>;
}
