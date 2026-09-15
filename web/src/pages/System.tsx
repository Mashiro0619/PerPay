import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, RefreshCw } from "lucide-react";
import { Link } from "../navigation";

import { api, result } from "../api/client";
import { Badge, Button, Notice, PageHeading, Panel, QueryView } from "../components/ui";
import { RecordTools } from "../components/detail/RecordTools";
import { dateTime } from "../lib/format";
import { notificationErrorName } from "../lib/detail-summary";
import { OfficialUpdatePanel } from "../updates";

export default function System() {
  const status = useQuery({ queryKey: ["status"], queryFn: ({ signal }) => result(api.getAdministratorSystemStatus({ signal })), refetchInterval: 30_000 });
  return <><PageHeading title="运行状态" actions={<Button pending={status.isFetching} onClick={() => { void status.refetch(); }}><RefreshCw size={16} />刷新</Button>} />
    <QueryView query={status}>{({ data }) => {
      const canReceive = data.status !== "not_ready" && data.configured && data.database.ok && data.ledger.collection_ready && data.reconciliation.confirmation_ready;
      const conflicts = data.ledger.conflicts?.open ?? 0;
      const exceptions = data.reconciliation.exceptions?.open ?? 0;
      const ledgerHealthy = data.ledger.collection_ready && data.ledger.consecutive_failures === 0 && conflicts === 0;
      const reconciliationHealthy = data.reconciliation.confirmation_ready && data.reconciliation.consecutive_failures === 0 && exceptions === 0;
      const webhookHealthy = data.webhook.consecutive_failures === 0 && data.webhook.dead_letters === 0;
      const backupHealthy = data.backup.ok && !data.backup.recovery_required && !data.backup.configuration_mismatch && !data.backup.clock_moved_backwards;
      const needsAttention = data.status === "degraded" || !ledgerHealthy || !reconciliationHealthy || (data.webhook.enabled && !webhookHealthy) || (data.backup.enabled && !backupHealthy) || data.backup.recovery_required || data.backup.configuration_mismatch || data.backup.clock_moved_backwards;
      return <>
        <Panel className="content-panel system-overview"><div className="system-summary"><div className="system-summary-title" data-ready={canReceive && !status.isError}>{canReceive && !status.isError ? <CheckCircle2 size={24} /> : <CircleAlert size={24} />}<div><h2>{status.isError ? "收款状态待刷新" : canReceive ? "可以收款" : "暂不能收款"}</h2><p>{status.isError ? "以下为上次读取结果，请重试。" : !data.configured ? "收款配置未完成。" : !data.database.ok ? "数据库不可用，请检查服务器。" : !data.ledger.collection_ready ? "账本采集尚未就绪，请检查支付宝接入。" : !data.reconciliation.confirmation_ready ? "自动确认尚未就绪。" : needsAttention ? "部分环节需要关注，详见下方。" : "收款链路运行正常。"}</p></div></div>
          <div className="system-version"><span>v{data.version}</span><time>更新于 {dateTime(status.dataUpdatedAt)}</time></div></div>
          {!data.configured && <Link className="button button--primary" to="/settings/onboarding">继续配置</Link>}
        </Panel>
        <Panel title="运行环节" description="统计包含已忽略提醒的记录。" className="system-components">
          <ComponentStatus title="账本采集" enabled={data.ledger.enabled} healthy={ledgerHealthy}
            summary={"最近成功 " + dateTime(data.ledger.last_success_at)}
            metrics={"未处理冲突 " + (data.ledger.conflicts?.open ?? "—")}
            action={!ledgerHealthy && <Link className="text-link" to="/settings/provider">支付宝接入</Link>}>
            {!data.ledger.collection_ready && <p>采集尚未就绪或已中断，新订单收款入口暂不可用。</p>}
            {data.ledger.last_error_code && <p>最近错误：{data.ledger.last_error_code} · 连续失败 {data.ledger.consecutive_failures} 次</p>}
            {conflicts > 0 && <p>冲突仍保留校验约束。<Link to="/reconciliation?tab=conflicts&status=ALL">查看全部冲突记录</Link></p>}
          </ComponentStatus>
          <ComponentStatus title="自动确认" enabled={data.reconciliation.enabled} healthy={reconciliationHealthy}
            summary={"最近成功 " + dateTime(data.reconciliation.last_success_at)}
            metrics={"待核对订单 " + data.reconciliation.pending_orders + " · 未处理异常 " + (data.reconciliation.exceptions?.open ?? "—")}
            action={exceptions > 0 && <Link className="text-link" to="/work-items?type=FINANCIAL_EXCEPTION">查看未忽略提醒</Link>}>
            {!data.reconciliation.confirmation_ready && <p>等待自动核对恢复后才能确认付款。可先检查账本采集是否正常。</p>}
            {data.reconciliation.last_error_code && <p>最近错误：{data.reconciliation.last_error_code} · 连续失败 {data.reconciliation.consecutive_failures} 次</p>}
          </ComponentStatus>
          <ComponentStatus title="业务通知" enabled={data.webhook.enabled} healthy={webhookHealthy}
            summary={data.webhook.enabled ? "最近成功 " + dateTime(data.webhook.last_success_at) : "已关闭，业务网站需主动查单"}
            metrics={<><span>待投递 {data.webhook.pending_deliveries}</span><span>投递失败 {data.webhook.dead_letters > 0 ? <Link to="/notifications?status=DEAD_LETTER">{data.webhook.dead_letters}</Link> : 0}</span></>}
            action={!webhookHealthy && <Link className="text-link" to="/notifications">查看投递</Link>}>
            {data.webhook.last_error_code && <p>{notificationErrorName(data.webhook.last_error_code)} · 连续失败 {data.webhook.consecutive_failures} 次</p>}
            {data.webhook.dead_letters > 0 && <p>自动重试已结束的投递，可查看结果后按需重新投递。</p>}
          </ComponentStatus>
          <ComponentStatus title="数据库" enabled healthy={data.database.ok} summary={data.database.ok ? "SQLite · 检查正常" : "SQLite · 检查未通过"}>
            {!data.database.ok && <p>{data.database.result}</p>}
          </ComponentStatus>
          <ComponentStatus title="自动备份" enabled={data.backup.enabled} healthy={backupHealthy}
            summary={"最近成功 " + dateTime(data.backup.last_success_at)}
            metrics={data.backup.backup_in_progress ? "正在备份" : "保留 " + (data.backup.retained_count ?? 0) + " 份"}
            action={<Link className="text-link" to="/settings/backup">备份设置</Link>}>
            {data.backup.recovery_required && <Notice tone="danger">实例需要恢复。请按维护文档处理，不要覆盖运行中的数据库。</Notice>}
            {data.backup.configuration_mismatch && <Notice tone="warning">备份配置与运行状态不一致，请检查服务器备份任务。</Notice>}
            {data.backup.clock_moved_backwards && <Notice tone="warning">系统时钟发生回退，请检查主机时间同步。</Notice>}
            {data.backup.last_error_stage && <p>最近失败阶段：{data.backup.last_error_stage}</p>}
            {!data.backup.backup_available && data.backup.enabled && <p>暂无可用备份。</p>}
          </ComponentStatus>
        </Panel>
        <RecordTools label="运行技术信息" data={data} identifiers={[["实例编号", data.instance_id], ["支付宝账户", data.provider_account_key], ["备份文件", data.backup.backup_name], ["备份 SHA-256", data.backup.backup_sha256]]} />
      </>;
    }}</QueryView>
    <OfficialUpdatePanel />
  </>;
}

function ComponentStatus({ title, enabled, healthy, summary, metrics, action, children }: {
  title: string; enabled: boolean; healthy: boolean; summary: string; metrics?: ReactNode; action?: ReactNode; children?: ReactNode;
}) {
  return <section className="component-status"><div className="component-status-row"><div className="component-status-name"><h3>{title}</h3><HealthIndicator enabled={enabled} healthy={healthy} /></div><p className="component-status-summary">{summary}</p>{metrics && <div className="component-status-metrics">{metrics}</div>}{action}</div>
    {!healthy && <div className="component-status-issue">{children}</div>}
  </section>;
}
function HealthIndicator({ enabled, healthy }: { enabled: boolean; healthy: boolean }) {
  if (!enabled) return <Badge value="UNPAID" label="未启用" />;
  return <span className={"health-indicator " + (healthy ? "is-healthy" : "is-warning")}>{healthy ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}{healthy ? "正常" : "需关注"}</span>;
}
