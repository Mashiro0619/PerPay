<!-- SPDX-License-Identifier: MIT -->

# 业务错误码与重试规范

调用原生业务接口 `/api/v1/*` 失败时，应结合 **HTTP 状态码**、`error.code`、`error.message` 与响应头 `Retry-After` 判断处理策略，并记录 `X-Request-Id` 便于服务端排查。

> 相关文档：[原生 API 快速接入](integration-quickstart.md) · [使用与接口参考](../USAGE.md) · [OpenAPI 规范](../openapi.yaml)

---

## 1. 重试基本规则

1. **业务参数保持不变**：同笔下单重试时，必须保留原 `merchant_order_no`、`idempotency_key` 与全部业务字段。
2. **每次重试重新签名**：服务端在进入业务校验前即消耗 `nonce`，无论上次返回何种错误，重试请求均须重新生成时间戳、`nonce` 与签名。
3. **结果不确定时先查单**：遇到超时、连接中断或 `500` 时，订单可能已在服务端创建成功。应先按原 `merchant_order_no` 查单，确认不存在后再重试；若需换单重付，须先确认旧单收银台已关闭或过期且未付款。

---

## 2. 错误码分类表

### 客户端请求错误（修正请求，不应直接重试）

| HTTP | `error.code` | 原因与处理 |
| --- | --- | --- |
| `400` | `invalid_json`、`duplicate_json_key`、`invalid_content_length` | JSON 语法错误、存在重复键或 `Content-Length` 与实际长度不符 |
| `401` | `api_authentication_failed` | 认证失败：检查客户端 ID、API 密钥（勿混用通知密钥）、系统时钟（±5 分钟）、原始正文 SHA-256 及 [路径规范化](../USAGE.md#2-请求签名)，可使用 [签名测试向量](signature-vectors.md) 验证 |
| `404` | `route_not_found` | 请求路径或 HTTP 方法错误 |
| `404` | `order_not_found`、`event_not_found` | 记录不存在或不属于当前网站（下单超时后查无此单可继续重试原下单） |
| `409` | `idempotency_conflict` / `merchant_order_no_conflict` | 同一 `idempotency_key` 或 `merchant_order_no` 提交了不同业务载荷，先查询原订单核对 |
| `413` | `request_body_too_large` | 请求体超出限制；`GET` 与关闭订单 `POST` 必须发送零字节空正文 |
| `415` | `unsupported_media_type` | JSON 接口缺少 `Content-Type: application/json` |
| `422` | `validation_failed` | 参数校验不通过（如金额非整数分或含未知字段），根据 `error.fields` 修正 |
| `422` | `webhook_disabled` / `webhook_target_invalid` / `webhook_target_not_allowed` | 站点未开启通知，或 `notify_url` 与后台「通知来源」不匹配 |
| `422` | `return_url_invalid` / `return_url_not_allowed` | `return_url` 格式不合法或与后台「返回来源」不匹配 |

### 临时故障与并发冲突（等待后可有限重试）

| HTTP | `error.code` | 原因与处理 |
| --- | --- | --- |
| `400` | `request_body_unreadable` | 请求体传输中断，可有限重试原请求 |
| `409` | `api_nonce_replayed` | `nonce` 重复使用，重新生成 `nonce` 与签名后重试（若频繁出现需排查并发逻辑） |
| `409` | `site_revision_conflict` | 下单同时管理员更新了站点配置，直接重试原请求 |
| `503` | `amount_slots_exhausted` / `site_order_limit_exceeded` | 该标价的可用应付金额槽位耗尽，或站点待付款订单数达上限；按 `Retry-After` 等待后重试 |
| `503` | `alipay_accounts_unavailable` / `system_not_ready` / `reconciliation_not_ready` / `order_clock_unavailable` | 收款账号暂不可用、查账未就绪或时钟异常；按 `Retry-After` 等待并检查后台「运行状态」 |
| `503` | `site_paused` / `system_not_configured` | 网站已暂停接单或尚未完成基础配置，需管理员在后台处理 |
| `503` | `webhook_unavailable` | 事件查询服务暂不可用，恢复后以原事件 ID 重新查询 |
| `500` | `internal_error` | 服务端内部错误：先查询原单确认状态，再决定有限重试，并提供 `X-Request-Id` 供排查 |

> **说明**：若收到非 JSON 格式的 `403`、`429` 或 `502`，通常由前置 Nginx、CDN 或 WAF 拦截产生，应排查代理日志；收到 `429` 同样需遵守 `Retry-After`。另外，`GET /api/v1/system/status` 返回 HTTP `200` 仅表示接口可达，实际是否可接单以响应体中的 `data.status`（`ready` / `not_ready`）为准。

---

<a id="与通知投递区分"></a>

## 3. 回调通知接收端响应规范

上述错误码适用于“业务后端调用 PerPay”。当 PerPay 向业务网站推送回调通知时，业务端应按以下规则返回状态码：

- **成功接收并落库**：原生协议返回 `200` 与规范 4 字段 JSON ACK；易支付协议返回 `2xx` 与纯文本 `success`。
- **临时故障需重试**：返回 `5xx` 或 `401 / 403 / 404 / 408 / 409 / 422 / 429` 均会触发 PerPay 自动退避重试。
- **永久拒绝**：返回 `410` 将立即终止当前投递任务的自动重试。

完整重试分类规则见 [回调通知](../USAGE.md#5-回调通知)。
