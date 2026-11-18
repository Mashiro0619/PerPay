import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { auditMetadataQuery } from "@/api/audit";
import { auditCaptureLabel } from "@/lib/audit";
import { useDetailBack } from "@/navigation";
import { AuditCaptureNotice, AuditRetention } from "@/components/audit-record";
import { DetailNavigation, DetailPage } from "@/components/detail/DetailPrimitives";
import { OverlaySummary } from "@/components/overlay-actions";
import { PageHeading } from "@/components/page-heading";
import { PageHeaderActions } from "@/components/page-header-actions";
import { FieldList } from "@/components/record/FieldList";
import { RecordSummary } from "@/components/record/RecordSummary";
import { Section, Sections } from "@/components/record/Sections";
import { RecordTime } from "@/components/record/Timeline";
import { RefreshButton } from "@/components/refresh-button";
import { QueryView } from "@/components/request-state";

export default function AuditStatus() {
  const metadata = useQuery(auditMetadataQuery());
  const [search] = useSearchParams();
  const requestedSnapshot = search.get("snapshot_at");
  const snapshot = requestedSnapshot && Number.isFinite(Date.parse(requestedSnapshot)) ? requestedSnapshot : null;
  const back = useDetailBack("/audit", "审计日志");
  const refresh = <RefreshButton busy={metadata.isFetching} disabled={metadata.isFetching} onClick={() => { void metadata.refetch(); }} />;

  return <DetailPage>
    <PageHeading title="审计采集状态" />
    <DetailNavigation back={back} global><PageHeaderActions>{refresh}</PageHeaderActions></DetailNavigation>
    <QueryView query={metadata}>{({ data }) => <>
      <OverlaySummary>
        <RecordSummary label="采集状态" size="phrase" value={auditCaptureLabel(data.capture)}
          meta={[data.capture.last_flush_at ? <>最近成功写入：<RecordTime value={data.capture.last_flush_at} /></> : "等待首次成功写入"]} />
      </OverlaySummary>
      <AuditCaptureNotice capture={data.capture} compact />
      <Sections>
        {/* The summary already names these figures, so they carry no visible title of their own. */}
        <div role="group" aria-label="采集概况" data-audit-capture-summary className="min-w-0">
          <FieldList items={[
            { label: "等待写入", value: data.capture.buffered_events.toLocaleString("zh-CN") + " 条" },
            data.capture.last_dropped_at ? { label: "最近丢弃活动", value: <RecordTime value={data.capture.last_dropped_at} />, kind: "time" } : null,
            { label: "最近维护日志导入", value: data.capture.spool_last_import_at ? <RecordTime value={data.capture.spool_last_import_at} /> : "未记录", kind: data.capture.spool_last_import_at ? "time" : "text" },
            snapshot ? { label: "列表读取时间", value: <RecordTime value={snapshot} />, kind: "time" } : null,
            data.capture.last_error_code ? { label: "最近错误代码", value: data.capture.last_error_code, kind: "id" } : null,
          ]} />
        </div>
        <Section id="rules" title="记录与导出规则">
          <div className="flex min-w-0 flex-col gap-2 text-sm leading-5 text-muted-foreground">
            <AuditRetention />
            <p>列表按发生时间倒序显示，日期与时间均为北京时间。刷新列表可读取最新记录。</p>
            <p>CSV 导出当前筛选的全部匹配记录，最多 10,000 行；每组活动汇总占一行。请选择最多 366 天的发生日期范围。</p>
          </div>
        </Section>
      </Sections>
    </>}</QueryView>
  </DetailPage>;
}
