import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { auditMetadataQuery } from "@/api/audit";
import { auditCaptureLabel } from "@/lib/audit";
import { useDetailBack } from "@/navigation";
import { AuditCaptureNotice, AuditRetention, AuditTime } from "@/components/audit-record";
import { DetailFields, DetailNavigation, DetailPage } from "@/components/detail/DetailPrimitives";
import { PageHeading } from "@/components/page-heading";
import { PageHeaderActions } from "@/components/page-header-actions";
import { RefreshButton } from "@/components/refresh-button";
import { QueryView } from "@/components/request-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
      <AuditCaptureNotice capture={data.capture} compact />
      <Card aria-label="采集概况" className="detail-section" data-audit-capture-summary>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>{auditCaptureLabel(data.capture)}</CardTitle>
        </CardHeader>
        <CardContent><DetailFields density="comfortable" wide={["最近错误代码"]} items={[
          ["最近成功写入", data.capture.last_flush_at ? <AuditTime value={data.capture.last_flush_at} /> : "等待首次成功写入"],
          ["等待写入", data.capture.buffered_events.toLocaleString("zh-CN") + " 条"],
          ...(data.capture.last_dropped_at ? [["最近丢弃活动", <AuditTime value={data.capture.last_dropped_at} />] as const] : []),
          ["最近维护日志导入", data.capture.spool_last_import_at ? <AuditTime value={data.capture.spool_last_import_at} /> : "未记录"],
          ...(snapshot ? [["列表读取时间", <AuditTime value={snapshot} />] as const] : []),
          ...(data.capture.last_error_code ? [["最近错误代码", data.capture.last_error_code] as const] : []),
        ]} /></CardContent>
      </Card>
      <Card aria-label="记录与导出规则" className="detail-section">
        <CardHeader><CardTitle role="heading" aria-level={2}>记录与导出规则</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
          <AuditRetention />
          <p>列表按发生时间倒序显示，日期与时间均为北京时间。刷新列表可读取最新记录。</p>
          <p>CSV 导出当前筛选的全部匹配记录，最多 10,000 行；每组活动汇总占一行。请选择最多 366 天的发生日期范围。</p>
        </CardContent>
      </Card>
    </>}</QueryView>
  </DetailPage>;
}
