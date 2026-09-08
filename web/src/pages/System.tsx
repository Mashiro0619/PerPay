import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, RefreshCw } from "lucide-react";
import { Link } from "../navigation";

import { api, result } from "../api/client";
import { Badge, Button, CopyValue, Details, JsonDetails, Notice, PageHeading, Panel, QueryView } from "../components/ui";
import { count, dateTime } from "../lib/format";
import { label } from "../lib/labels";

export default function System() {
  const status = useQuery({ queryKey: ["status"], queryFn: ({ signal }) => result(api.getAdministratorSystemStatus({ signal })), refetchInterval: 30_000 });
  return <><PageHeading title="运行状态" actions={<Button pending={status.isFetching} onClick={() => { void status.refetch(); }}><RefreshCw size={16} />立即刷新</Button>} />
    <QueryView query={status}>{({ data }) => <>
      <Panel title="实例概况" action={<Badge value={data.status} />} className="content-panel"><Details items={[["应用版本", `v${data.version}`], ["实例编号", <CopyValue value={data.instance_id} />], ["配置状态", data.configured ? "已完成" : <Link to="/settings">继续配置</Link>], ["配置版本 / 收款版本", `${data.settings_revision ?? "—"} / ${data.payment_revision}`], ["当前支付宝账户", data.provider_account_key ?? "尚未配置"], ["最后读取", dateTime(status.dataUpdatedAt)]]} /></Panel>
      {data.status === "not_ready" && <Notice tone="warning">当前不能创建新的收款订单。请检查配置、数据库及下方采集与自动确认状态。</Notice>}
      <div className="two-column">
        <Panel title="账本采集" action={<HealthIndicator enabled={data.ledger.enabled} healthy={data.ledger.collection_ready && data.ledger.consecutive_failures === 0} />} className="content-panel"><Details items={[["调度状态", label(data.ledger.state)], ["正在采集", data.ledger.in_flight ? "是" : "否"], ["最近成功", dateTime(data.ledger.last_success_at)], ["连续失败", data.ledger.consecutive_failures], ["最近错误", data.ledger.last_error_code ?? "无"], ["开放冲突", <Link to="/reconciliation?tab=conflicts">{data.ledger.conflicts?.open ?? "—"}</Link>]]} /></Panel>
        <Panel title="自动确认" action={<HealthIndicator enabled={data.reconciliation.enabled} healthy={data.reconciliation.confirmation_ready && data.reconciliation.consecutive_failures === 0} />} className="content-panel"><Details items={[["调度状态", label(data.reconciliation.state)], ["正在核对", data.reconciliation.in_flight ? "是" : "否"], ["最近成功", dateTime(data.reconciliation.last_success_at)], ["待核对订单", data.reconciliation.pending_orders], ["最近错误", data.reconciliation.last_error_code ?? "无"], ["开放异常", <Link to="/reconciliation?tab=exceptions">{data.reconciliation.exceptions?.open ?? "—"}</Link>]]} /></Panel>
        <Panel title="业务通知" action={<HealthIndicator enabled={data.webhook.enabled} healthy={data.webhook.consecutive_failures === 0 && data.webhook.dead_letters === 0} />} className="content-panel"><Details items={[["调度状态", label(data.webhook.state)], ["最近成功", dateTime(data.webhook.last_success_at)], ["待投递", data.webhook.pending_deliveries], ["投递失败", <Link to="/notifications?status=DEAD_LETTER">{data.webhook.dead_letters}</Link>], ["连续失败", data.webhook.consecutive_failures], ["最近错误", data.webhook.last_error_code ?? "无"]]} /></Panel>
        <Panel title="数据库" action={<HealthIndicator enabled healthy={data.database.ok} />} className="content-panel"><Details items={[["引擎", "SQLite"], ["健康检查", data.database.result], ["管理员初始化", data.initialized ? "已完成" : "尚未完成"]]} /></Panel>
      </div>
      <Panel title="自动备份" action={<HealthIndicator enabled={data.backup.enabled} healthy={data.backup.ok} />} className="content-panel">
        {data.backup.recovery_required && <Notice tone="danger">实例需要恢复处理。请先按服务器维护流程核查，不要直接覆盖正在运行的数据库。</Notice>}
        {data.backup.configuration_mismatch && <Notice tone="warning">备份配置与实际运行状态不一致，请检查服务器备份任务。</Notice>}
        {data.backup.clock_moved_backwards && <Notice tone="warning">检测到系统时钟回退，请核查主机时间同步。</Notice>}
        <Details items={[["最近成功", dateTime(data.backup.last_success_at)], ["最近失败阶段", data.backup.last_error_stage ?? "无"], ["备份文件", data.backup.backup_name ?? "暂无"], ["文件大小", data.backup.backup_size_bytes ? `${count(data.backup.backup_size_bytes)} 字节` : "—"], ["保留数量", `${data.backup.retained_count ?? 0} / ${data.backup.keep_count ?? "—"}`], ["正在备份", data.backup.backup_in_progress ? "是" : "否"], ["备份可用", data.backup.backup_available ? "是" : "否"], ["实例匹配", data.backup.instance_matches === null ? "尚未验证" : data.backup.instance_matches ? "是" : "否"]]} />
        {data.backup.backup_sha256 && <CopyValue value={data.backup.backup_sha256} label="复制备份 SHA-256" />}<Link className="text-link" to="/settings/backup">修改自动备份策略</Link>
      </Panel>
      <JsonDetails data={data} label="查看完整健康检查数据" />
    </>}</QueryView>
  </>;
}

function HealthIndicator({ enabled, healthy }: { enabled: boolean; healthy: boolean }) {
  if (!enabled) return <Badge value="UNPAID" label="未启用" />;
  return <span className={`health-indicator ${healthy ? "is-healthy" : "is-warning"}`}>{healthy ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}{healthy ? "正常" : "需关注"}</span>;
}
