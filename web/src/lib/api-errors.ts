const messages: Record<string, string> = {
  invalid_credentials: "管理员密码不正确，请检查后重试。",
  identity_already_initialized: "实例已经初始化，请前往登录。",
  identity_not_initialized: "实例尚未初始化，请先创建管理员。",
  auth_rate_limited: "尝试过于频繁，请等待后再试。",
  password_work_busy: "密码处理繁忙，请稍后再试。",
  password_unchanged: "新密码不能与当前密码相同。",
  session_invalid: "登录已过期，请重新登录。",
  csrf_invalid: "安全校验失败，请重新登录后再操作。",
  origin_not_allowed: "访问来源不匹配，请使用配置的实例地址并检查反向代理。",
  settings_revision_conflict: "配置已在其他会话中更新。你的修改仍保留，请核对后重新读取配置。",
  settings_validation_failed: "配置未通过校验，请检查必填项、数值范围和密钥格式。",
  settings_unavailable: "无法读取实例配置，请查看运行状态后重试。",
  settings_not_configured: "请先完成实例配置，再执行此操作。",
  provider_application_key_missing: "尚未生成应用密钥，请先在支付宝接入中生成密钥。",
  provider_application_key_rotation_not_supported: "已有应用密钥不能在此重新生成，请使用配置页更新接入信息。",
  provider_switch_blocked: "仍有未完成的收款业务，暂时不能切换支付宝应用。",
  secret_not_found: "此密钥尚未配置，请先完成对应设置。",
  system_not_configured: "实例配置尚未完成，请前往实例设置。",
  system_not_ready: "实例暂时不能接受新收款，请查看运行状态。",
  reconciliation_not_ready: "采集或对账尚未就绪，请等待一次成功运行后重试。",
  reconciliation_unavailable: "对账服务暂时不可用，请查看运行状态。",
  ledger_unavailable: "账本暂时不可用，请查看运行状态。",
  amount_slots_exhausted: "此金额的可用收款位已用完，请稍后重试或调整金额。",
  validation_failed: "输入未通过校验，请检查格式、必填项和数值范围。",
  invalid_json: "请求内容无效，请重新加载页面后再试。",
  request_body_too_large: "提交内容过大，请缩短内容后重试。",
  order_not_found: "找不到该订单，请核对订单号或返回订单列表。",
  ledger_entry_not_found: "找不到该流水，请重新读取账本。",
  candidate_not_found: "该候选关联已不存在，请重新读取证据。",
  candidate_set_changed: "候选证据已变化，请重新读取并核对后再操作。",
  match_not_found: "找不到该关联，请重新读取订单与流水。",
  match_state_conflict: "订单或流水状态已变化，请重新核对证据，不要重复确认。",
  financial_exception_not_found: "此账务异常已不存在，请刷新待处理列表。",
  ledger_conflict_not_found: "此账本冲突已不存在，请刷新列表。",
  ledger_conflict_state_conflict: "账本冲突状态已变化，请重新读取后再处理。",
  ledger_conflict_action_not_allowed: "当前冲突不允许此操作，请重新核对处理方式。",
  ledger_conflict_operation_conflict: "操作编号已用于其他请求，请重新核对账本处理结果。",
  operation_conflict: "操作编号与已执行请求不一致，请先核对已有处理结果。",
  idempotency_conflict: "该请求编号已用于不同内容，请先核对已有操作结果。",
  webhook_delivery_not_found: "找不到此通知记录，请刷新通知列表。",
  webhook_delivery_state_conflict: "通知状态已变化，请刷新后核对，避免重复重发。",
  webhook_operation_conflict: "通知操作与已有请求不一致，请先核对投递记录。",
  webhook_disabled: "业务通知尚未启用，请检查通知设置。",
  webhook_target_inactive: "通知目标已停用，请核对通知设置后再操作。",
  webhook_target_not_allowed: "通知地址不在允许的来源内，请核对业务通知配置。",
  webhook_target_invalid: "通知地址无效，请使用允许来源下的 HTTPS 地址。",
  webhook_unavailable: "通知服务暂时不可用，请查看运行状态。",
  webhook_signing_key_unavailable: "通知签名密钥暂不可用，请检查通知设置。",
  internal_error: "服务处理失败，请稍后重试；若持续失败，请使用请求编号检查服务日志。",
};

export function apiErrorMessage(code: string | undefined, message: unknown, status: number | undefined): string {
  if (typeof message === "string" && /[\u3400-\u9fff]/u.test(message)) return message;
  if (code && messages[code]) return messages[code];
  if (!status) return "无法连接服务，请检查网络后重试。";
  if (status === 401) return "登录已过期，请重新登录。";
  if (status === 403) return "安全校验未通过，请重新登录并核对访问地址。";
  if (status === 409) return "数据状态已变化，请重新读取并核对后再操作。";
  if (status === 429) return "请求过于频繁，请等待后再试。";
  if (status >= 500) return "服务暂时不可用，请稍后重试并检查运行状态。";
  if (status === 404) return "找不到请求的记录，请返回列表重新查找。";
  return `请求未完成（HTTP ${status}），请检查输入后重试。`;
}
