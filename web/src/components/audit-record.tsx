import type { ReactNode } from "react";
import type { AuditChange, AuditEventItem, AuditMetadata } from "../../../src/shared/audit";
import { AUDIT_CATEGORY_LABELS } from "../../../src/shared/audit";
import { Link } from "@/navigation";
import { AUDIT_ACTOR_LABELS, AUDIT_RECORD_LABELS, auditChangeValues, auditClientLabel, auditContextUnavailable, auditDateTime, auditDuration, auditFieldLabel } from "@/lib/audit";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FieldList } from "@/components/record/FieldList";
import { Section } from "@/components/record/Sections";
import { RecordTime } from "@/components/record/Timeline";

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
    {event.is_aggregate && <Badge variant="secondary">活动汇总 · {event.event_count.toLocaleString("zh-CN")} 次</Badge>}
  </div>;
}

/** A link from an audit record to another record: underlined text followed by "›". The label keeps its own element so it can still be found by its exact text. */
export function AuditRecordLink({ to, title, children }: { to: string; title?: string | undefined; children: ReactNode }) {
  return <Link global to={to} title={title} className="w-fit underline underline-offset-4 outline-none wrap-anywhere focus-visible:ring-2 focus-visible:ring-ring"><span>{children}</span><span aria-hidden="true"> ›</span></Link>;
}

/** `record` shows the website as record details link to other records; lists keep the compact secondary link. */
export function AuditSite({ event, deleted = false, record = false }: { event: Pick<AuditEventItem, "site_id" | "site_name">; deleted?: boolean; record?: boolean }) {
  if (!event.site_id) return <span>未关联网站</span>;
  const title = event.site_name || event.site_id;
  if (deleted) return <span className="wrap-anywhere">{title}（已删除）</span>;
  const to = "/sites/" + encodeURIComponent(event.site_id) + "/summary";
  if (record) return <AuditRecordLink to={to} title={event.site_id}>{title}</AuditRecordLink>;
  return <Link global to={to} title={event.site_id} className="list-secondary-link wrap-anywhere">{title}</Link>;
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
  return <p className="text-xs text-muted-foreground" data-audit-retention>核心审计持续保留；活动记录保留 30 天。普通查询和匿名错误请求按分钟汇总，其中未关联核心审计的查询和匿名请求最多保留 20,000 条。</p>;
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
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {capture.dropped_events > 0 && <span>未记录活动：{capture.dropped_events.toLocaleString("zh-CN")} 条</span>}
        {capture.write_failures > 0 && <span>写入失败：{capture.write_failures.toLocaleString("zh-CN")} 次</span>}
        {capture.spool_failures > 0 && <span>维护日志导入失败：{capture.spool_failures.toLocaleString("zh-CN")} 次</span>}
        {capture.spool_gap_count > 0 && <span>维护日志缺口：{capture.spool_gap_count.toLocaleString("zh-CN")} 处</span>}
        {capture.buffered_events > 0 && <span>等待写入：{capture.buffered_events.toLocaleString("zh-CN")} 条</span>}
      </div>
      {capture.last_error_code === "activity_http_budget_exceeded" && <p>查询和匿名请求超过采集预算，部分活动未记录。该类请求每分钟最多接收 600 条待写入记录，重复请求会先合并。</p>}
      {!compact && capture.last_dropped_at && <p>最近丢弃活动：<AuditTime value={capture.last_dropped_at} /></p>}
      {!compact && capture.last_flush_at && <p>最近成功写入：<AuditTime value={capture.last_flush_at} /></p>}
      {!compact && capture.spool_last_import_at && <p>最近维护日志导入：<AuditTime value={capture.spool_last_import_at} /></p>}
      {!compact && capture.last_error_code && <p className="wrap-anywhere">错误代码：{capture.last_error_code}</p>}
    </AlertDescription>
  </Alert>;
}

/** Counts and timings of one aggregated activity group; a top-level section of the audit record. */
export function AuditAggregation({ event }: { event: AuditEventItem }) {
  if (!event.is_aggregate) return null;
  return <Section id="aggregate" title={`活动汇总 · ${event.event_count.toLocaleString("zh-CN")} 次`}>
    <p className="text-[0.8125rem] leading-5 text-muted-foreground">同类活动的次数、时间与耗时统计；不同结果和错误分别汇总。</p>
    <FieldList items={[
      { label: "首次发生", value: <RecordTime value={event.first_occurred_at} />, kind: "time" },
      { label: "最后发生", value: <RecordTime value={event.last_occurred_at} />, kind: "time" },
      { label: "发生次数", value: event.event_count.toLocaleString("zh-CN") },
      { label: "累计耗时", value: auditDuration(event.duration_ms) },
      { label: "平均耗时", value: auditDuration(event.duration_ms === null || event.event_count <= 0 ? null : event.duration_ms / event.event_count) },
    ]} />
  </Section>;
}

/** Recorded configuration changes, one group of before and after per field. */
export function AuditChanges({ changes }: { changes: readonly AuditChange[]; category: AuditEventItem["category"] }) {
  if (changes.length === 0) return null;
  return <Section id="changes" title="配置变更">
    <p className="text-[0.8125rem] leading-5 text-muted-foreground">只列出已记录的变更字段。密码、密钥等敏感值仅保留变更状态。</p>
    <ul className="flex min-w-0 flex-col gap-3">
      {changes.map(change => {
        const [before, after] = auditChangeValues(change);
        return <li key={change.field} className="flex min-w-0 flex-col gap-1">
          <h3 className="text-sm font-medium wrap-anywhere" title={change.field}>{auditFieldLabel(change.field)}</h3>
          <FieldList items={[{ label: "变更前", value: before }, { label: "变更后", value: after }]} />
        </li>;
      })}
    </ul>
  </Section>;
}

export function AuditCategory({ category, sourceType }: Pick<AuditEventItem, "category"> & { sourceType?: AuditEventItem["source_type"] }) {
  const label = AUDIT_CATEGORY_LABELS[category] ?? category;
  if (sourceType && AUDIT_RECORD_LABELS[sourceType] === label) return null;
  return <span>{label}</span>;
}
