<!-- SPDX-License-Identifier: MIT -->

# 业务错误码与重试

本文面向网站后端调用 `/api/v1/*`。先查看 HTTP 状态，再读取 JSON 的 `error.code`、`error.message` 和可能存在的 `Retry-After` 响应头；保留 `X-Request-Id` 便于排查。完整字段见 [OpenAPI](../openapi.yaml)，接入流程见[快速指南](integration-quickstart.md)。

## 重试时保持什么

- 同一次下单重试保留原 `merchant_order_no`、`idempotency_key` 和全部业务参数；请求超时、连接断开或 500 不代表订单一定没有创建，先按原业务单号查单。
- 每次实际发送请求都使用当前 Unix **秒**时间戳、全新随机 nonce 和新签名。认证 nonce 在业务处理前消费，不能复用上一条请求的认证头，即使上次业务校验失败。
- 有 `Retry-After` 时先等待；无明确等待时间的暂时故障采用有限退避，设置最大等待时间及人工排查入口。不要因暂时故障自动换单号制造第二笔订单。
- 仅当服务端已确认旧收银台结束且仍未付款、用户要发起新的付款尝试时，换新业务单号和新幂等键。原单仍保留并继续处理其合法通知。

## 常见业务响应

| HTTP | `error.code` | 建议 |
| --- | --- | --- |
| 400 | `invalid_json`、`duplicate_json_key`、`invalid_content_length` | 修正正文序列化或请求头，不原样循环重试；保持原业务参数的含义。 |
| 400 | `request_body_unreadable` | 检查传输中断，有限重试原请求。 |
| 401 | `api_authentication_failed` | 核对客户端 ID、网站 API 密钥、签名格式、原始正文、规范化请求目标和两端时钟。修正后重新签名发送；不要使用通知密钥签业务请求。 |
| 404 | `order_not_found`、`event_not_found` | 核对 ID、业务单号和网站范围。不存在、格式错误或其他网站的资源均不可见；结果未知的下单仍按原业务单号查询、按原身份重试。 |
| 404 | `route_not_found` | 修正路径或方法，勿原样重试。 |
| 409 | `api_nonce_replayed` | 换新 nonce、当前时间和签名，业务参数保持不变；持续出现时检查并发签名或重复发送的实现。 |
| 409 | `idempotency_conflict` | 同一幂等键已经对应不同请求。停止重试并核对原订单，不能换一个 key 来掩盖冲突。 |
| 409 | `merchant_order_no_conflict` | 该业务单号已存在，先找回原订单及其请求参数、幂等键。 |
| 409 | `site_revision_conflict` | 创建期间网站配置发生变化，可有限重试原请求；业务客户端无需提交网站 revision。 |
| 413 | `request_body_too_large` | 缩小正文；GET 和关闭订单接口按契约发送空正文。 |
| 415 | `unsupported_media_type` | JSON 接口使用 `Content-Type: application/json`，按契约发送正文。 |
| 422 | `validation_failed` | 核对字段、整数分金额、范围和未知字段。修正请求；已有或结果未知的订单不能更改原身份所对应的业务参数。 |
| 422 | `webhook_disabled`、`webhook_target_invalid`、`webhook_target_not_allowed` | 核对网站通知开关、允许来源和完整回调 URL。仅修服务配置可重试原请求；改变回调参数时先核对是否已有订单。 |
| 422 | `return_url_invalid`、`return_url_not_allowed` | 核对返回地址及该网站独立的允许返回来源。处理参数变更时同样保留原订单身份边界。 |
| 503 | `amount_slots_exhausted`、`site_order_limit_exceeded` | 按 `Retry-After` 等待可用金额档位或待付款容量，有限重试原单号和原参数。 |
| 503 | `site_paused` | 网站暂停接单，等待维护者恢复。 |
| 503 | `system_not_ready`、`reconciliation_not_ready` | 数据库、查账或自动确认门禁未就绪；遵守 `Retry-After`，检查运行状态。 |
| 503 | `system_not_configured` | 等待收款或通知配置完成，重复请求本身不能补全配置。 |
| 503 | `order_clock_unavailable` | 联系维护者校准服务器时钟；当前等待提示为 `Retry-After: 30`。 |
| 503 | `webhook_unavailable` | 事件查询服务不可用，恢复后用原事件 ID 重查。 |
| 500 | `internal_error` | 下单结果可能已经提交；先查原单，再有限重试原请求并保留请求编号排查。 |

服务端将签名版本、客户端、密钥、格式及时间校验失败统一返回 `api_authentication_failed`，不会公开内部的 `TIMESTAMP_OUT_OF_RANGE` 等校验原因。API 时间允许偏差为五分钟；固定签名向量里的历史时间只能用于算法核对。

## 网关、网络与状态查询

当前业务签名路由没有独立的 403 或 429 错误分支。遇到这些响应时先检查反向代理、网关或 WAF；若返回 429，遵守 `Retry-After` 并有限退避。无 JSON、连接断开或超时时保留原下单身份，不能据此确认下单失败。管理员的 `csrf_invalid`、`admin_ip_not_allowed`、`auth_rate_limited` 和公开收银台的 `public_checkout_rate_limited` 属于其他接口，不能套用到本表。

`GET /api/v1/system/status` 在未就绪时仍可能返回 HTTP 200，应读取 `data.status`、`data.code` 及相关状态字段。它是诊断信息，不能替代真实下单结果。

## 与通知投递区分

上述表格描述**网站调用 PerPay**时的处理。PerPay 向网站发送通知时，接收端返回 401、403、404、409、422 等会触发自动退避重试；410 表示明确拒收。通知规则见 [严格 ACK 与重试说明](../USAGE.md#5-回调通知)。不要把通知接收端的规则当成业务 API 无条件重试策略。

本表依据[HTTP 路由与状态映射](../src/http/app.ts)、[订单服务](../src/orders/service.ts)、[网站范围与策略](../src/sites/store.ts)和[签名校验](../src/security/api-signature.ts)。如升级后出现未列出的错误码，保留原请求信息并核对对应版本的 OpenAPI 和服务端日志。
