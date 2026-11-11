<!-- SPDX-License-Identifier: MIT -->

# 业务错误码与重试

调用 `/api/v1/*` 后，先检查 HTTP 状态，再读取 JSON 中的 `error.code`、`error.message` 和响应头 `Retry-After`。记录 `X-Request-Id`，便于维护者定位请求。完整接口字段和响应格式见 [OpenAPI](../openapi.yaml)，首次接入见[快速指南](integration-quickstart.md)。

## 重试时保持什么

同一次下单的 `merchant_order_no`、`idempotency_key` 和全部业务参数保持不变。超时、连接断开或 `500` 时，订单可能已经创建：先按原业务单号查单，再决定是否重发原请求。

每次发送都生成当前 Unix **秒**时间戳、全新随机 nonce 和签名。服务端在处理业务前就将 nonce 记为已使用，因此即使上一次字段校验失败，也要重新生成认证头。有 `Retry-After` 时至少等待指定时长；其他临时故障可逐步延长重试间隔，并设置最多尝试次数和最长等待时间。

确认旧收银台已结束且仍未付款后，新的付款尝试使用新单号和新幂等键。旧订单仍需保留，继续处理其后续合法通知。

## 常见业务响应

| HTTP | `error.code` | 处理方式 |
| --- | --- | --- |
| 400 | `invalid_json`、`duplicate_json_key`、`invalid_content_length` | 检查 JSON 格式、重复字段和 `Content-Length` 请求头。 |
| 400 | `request_body_unreadable` | 检查连接中断，有限重试原请求。 |
| 401 | `api_authentication_failed` | 核对当前客户端 ID、API 密钥、时间戳、原始正文和规范化请求目标，再重新签名。 |
| 404 | `order_not_found`、`event_not_found` | 核对 ID 和所属网站。下单结果未知时，继续按原商户订单号查询或重试原请求。 |
| 404 | `route_not_found` | 修正路径或 HTTP 方法。 |
| 409 | `api_nonce_replayed` | 使用新 nonce、当前时间戳和新签名，保留业务参数；持续出现时检查并发签名与重复发送。 |
| 409 | `idempotency_conflict` | 同一幂等键对应了不同请求。查找原订单和原参数，解决冲突后再操作。 |
| 409 | `merchant_order_no_conflict` | 业务单号已存在，找回原订单及其幂等键。 |
| 409 | `site_revision_conflict` | 创建期间网站配置变化，有限重试原请求；业务 API 无需提交网站 revision。 |
| 413 | `request_body_too_large` | 缩小正文；GET 和关闭订单接口必须使用空正文。 |
| 415 | `unsupported_media_type` | JSON 接口使用 `Content-Type: application/json`。 |
| 422 | `validation_failed` | 按错误指出的字段修正请求，例如金额使用整数分、删除接口不接受的字段。已创建或结果未知的订单继续保留原参数。 |
| 422 | `webhook_disabled`、`webhook_target_invalid`、`webhook_target_not_allowed` | 核对网站通知开关、允许来源和完整回调 URL。只调整服务配置时可重试原请求；修改订单参数前先查单。 |
| 422 | `return_url_invalid`、`return_url_not_allowed` | 核对完整返回 URL 和独立配置的 `return_origin`。 |
| 503 | `amount_slots_exhausted`、`site_order_limit_exceeded` | 可分配的应付金额已用完，或待付款订单数已达上限。按 `Retry-After` 有限重试原请求。 |
| 503 | `alipay_accounts_unavailable` | 所选收款账号当前均不可用。维护者检查账号配置、启用状态及查账；下单响应给出 `Retry-After: 30`。 |
| 503 | `site_paused` | 网站暂停接单，等待维护者恢复。 |
| 503 | `system_not_ready`、`reconciliation_not_ready` | 数据库、查账或自动确认暂时不能正常工作，按 `Retry-After` 等待并检查运行状态。 |
| 503 | `system_not_configured` | 完成所需收款或通知配置后再试。 |
| 503 | `order_clock_unavailable` | 维护者校准服务器时钟；等待 `Retry-After: 30` 后重试。 |
| 503 | `webhook_unavailable` | 事件查询服务恢复后，用原事件 ID 重查。 |
| 500 | `internal_error` | 先查原单，再有限重试原请求，并将请求编号交给维护者排查。 |

服务端将客户端、密钥、签名版本、签名格式和时间校验失败统一返回 `api_authentication_failed`。API 允许前后五分钟的时钟偏差；通知密钥不能代替 API 密钥。按[签名向量](signature-vectors.md)核对算法时使用固定输入，实际请求使用当前时间和新 nonce。

## 网关、网络与状态查询

反向代理、网关和 WAF 也可能返回错误。调用签名业务接口收到 `403`、`429` 或非 JSON 响应时，先检查这些服务的日志和网络连接；`429` 同样遵守 `Retry-After`。网络响应不完整时，保留原商户订单号、幂等键和参数，并先查单。

`GET /api/v1/system/status` 的 HTTP `200` 表示状态查询成功，能否接单要看 `data.status` 和 `data.code`。这些信息帮助定位问题，最终是否创建成功以实际下单响应为准。

管理员登录的 `auth_rate_limited`、管理员接口的 `csrf_invalid`、`admin_ip_not_allowed`，以及公开收银台的 `public_checkout_rate_limited` 属于各自接口，处理方式见 [USAGE](../USAGE.md)。

<a id="与通知投递区分"></a>

## 业务网站收到通知后怎么回复

PerPay 向业务网站发通知时，由业务网站的接收端回复成功回执（ACK）：原生协议使用指定格式的 JSON，易支付使用文本 `success`。

原生通知接收端返回 `401`、`403`、`404`、`409`、`422` 等状态时，PerPay 会按网站配置的间隔自动重试；`410` 表示明确拒收。详细状态分类、尝试上限和人工重发见 [回调通知](../USAGE.md#5-回调通知)。
