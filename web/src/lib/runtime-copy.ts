export type RuntimeTask = "查账" | "自动确认收款" | "通知";

/** User-facing explanations only; error codes and worker state remain unchanged. */
export function runtimeErrorMessage(task: RuntimeTask, code: string): string {
  if (task === "查账") {
    switch (code) {
      case "provider_authentication_failed":
      case "remote_authentication_failed":
      case "request_signing_failed":
        return "支付宝身份验证失败，请检查应用和密钥配置。";
      case "remote_authorization_failed":
        return "支付宝查询权限不足，请检查应用授权。";
      case "remote_rate_limited":
        return "支付宝限制了查询频率，系统会等待后再试。";
      case "transport_network":
      case "transport_timeout":
        return "支付宝查询连接失败或超时，请检查网络并等待下次查账。";
      case "ledger_schedule_storage_error":
        return "查账进度暂时无法读取或保存，请检查数据库和运行诊断。";
      case "pagination_invalid":
      case "response_invalid_shape":
        return "支付宝账单未通过校验，请保留失败记录并查看运行诊断。";
      case "scan_failed":
        return "查账未完成，请检查网络、支付宝账号和运行诊断。";
      default:
        return "查账任务运行异常，请查看运行诊断。";
    }
  }
  if (task === "自动确认收款") {
    if (code === "reconciliation_storage_error")
      return "自动确认收款记录暂时无法读取或保存，请检查数据库和运行诊断。";
    if (code === "transport_timeout")
      return "自动确认收款任务超时，请查看运行状态。";
    return "自动确认收款未完成，请查看待核对记录和运行诊断。";
  }
  if (code === "webhook_delivery_failed")
    return "部分付款通知发送失败，请查看通知投递记录。";
  if (code === "transport_network" || code === "transport_timeout")
    return "通知发送连接失败或超时，请查看通知投递记录。";
  return "通知任务运行异常，请查看运行诊断。";
}

export function backupFailureStageName(stage: string): string {
  switch (stage) {
    case "state": return "备份状态读取或保存";
    case "database_backup": return "数据库备份";
    case "verification": return "备份校验";
    case "retention": return "旧备份清理";
    case "restore": return "备份恢复";
    default: return "未确定的阶段";
  }
}
