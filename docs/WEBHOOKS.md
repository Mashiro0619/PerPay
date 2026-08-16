<!-- SPDX-License-Identifier: Apache-2.0 -->

# 订单事件通知接收契约

本文定义当前原生通知格式 `NATIVE_JSON_V1`。接收方必须按原始字节验签，并按事件 ID 实现幂等处理。通知采用至少一次投递，不承诺恰好一次，也不承诺不同订单之间的全局顺序。

## 启用

在根目录 `docker-compose.yml` 中填写：

```yaml
PERPAY_WEBHOOK_ENABLED: "true"
PERPAY_WEBHOOK_ALLOWED_ORIGIN: "https://hooks.your-domain.test"
PERPAY_WEBHOOK_SECRET: "一份独立的 32 字节无填充 base64url 密钥"
```

`PERPAY_WEBHOOK_ALLOWED_ORIGIN` 只允许 HTTPS DNS origin，不能包含路径、query、fragment、凭据、IP 地址或尾点域名。创建订单时的 `notify_url` 必须精确属于这个 origin，可以包含路径和已有 query。例如允许 origin 为 `https://hooks.your-domain.test` 时，可以使用：

```text
https://hooks.your-domain.test/perpay/events?tenant=personal
```

通知目标与订单原子保存，之后不能修改。同一订单创建幂等键只能重放完全相同的目标。关闭通知或更改 Compose 中的允许 origin 都不会改写历史目标，历史下单请求的精确重放仍返回保存的原订单。关闭通知会暂停全部历史待投递任务，使用原配置重新启用后才会继续；更改允许 origin 后，旧 origin 的待投递任务无法发送并会进入死信，且不能创建新的人工补发代次。

## HTTP 请求

系统向订单保存的完整 `notify_url` 发出 HTTPS POST：

```http
Content-Type: application/json
Accept: application/json
Accept-Encoding: identity
User-Agent: perpay-webhook/1
X-PerPay-Webhook-Version: 1
X-PerPay-Webhook-Key-Id: <UUID v4>
X-PerPay-Webhook-Timestamp: <Unix 毫秒整数>
X-PerPay-Webhook-Delivery-Id: <UUID v4>
X-PerPay-Webhook-Event-Id: <UUID v4>
X-PerPay-Webhook-Attempt: <从 1 开始的整数>
X-PerPay-Webhook-Signature: v1=<64 位小写十六进制 HMAC>
```

所有 `X-PerPay-*` 头都只发送一次。接收方应拒绝重复头、未知签名版本、非法整数和非规范 UUID，不应依赖 HTTP 头名称的大小写。

请求体是 Outbox 中持久化的原始 UTF-8 JSON 字节。验签前不能重新序列化、改变空白、字段顺序或 Unicode 表示。当前请求体上限为 128 KiB。

## 验签

先对原始 body 计算小写十六进制 SHA-256：

```text
body_sha256 = hex_lower(SHA256(raw_body))
```

再使用换行符 `\n` 连接以下七行，最后一行后没有换行：

```text
perpay:webhook:v1
<key_id>
<timestamp>
<delivery_id>
<event_id>
<attempt>
<body_sha256>
```

将 `PERPAY_WEBHOOK_SECRET` 按无填充 base64url 解码为恰好 32 字节，以它作为 HMAC-SHA256 密钥。期望请求头为：

```text
v1=<hex_lower(HMAC_SHA256(secret_bytes, canonical_text_utf8))>
```

比较 MAC 时必须使用恒定时间比较。验签后还应确认请求头中的 `event_id` 与 JSON 的 `event_id` 相同。可以对时间戳设置合理的新鲜度窗口来降低截获重放风险，但它不能代替持久化的事件幂等记录；服务器时间必须保持同步。

Node.js 验签核心示例：

```js
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhook({ secret, rawBody, keyId, timestamp, deliveryId, eventId, attempt, signature }) {
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const canonical = [
    "perpay:webhook:v1",
    keyId,
    timestamp,
    deliveryId,
    eventId,
    attempt,
    bodyHash,
  ].join("\n");
  const expected = `v1=${createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(canonical, "utf8")
    .digest("hex")}`;
  const actualBytes = Buffer.from(signature, "ascii");
  const expectedBytes = Buffer.from(expected, "ascii");
  return actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes);
}
```

示例只展示密码学计算。生产接收器还必须限制请求体、拒绝重复头、严格校验字段格式，并在解析 JSON 前完成验签。

## 事件 JSON

新事件使用 `perpay:outbox-event:v2`。公共字段为：

```json
{
  "schema": "perpay:outbox-event:v2",
  "event_id": "UUID v4",
  "event_type": "PAYMENT_CONFIRMED",
  "financial_operation_id": "UUID v4",
  "order_id": "UUID v4",
  "merchant_order_no": "merchant-order-1",
  "requested_amount_cents": 1000,
  "payable_amount_cents": 1001,
  "received_amount_cents": 1001,
  "currency": "CNY",
  "payment_status": "CONFIRMED",
  "payment_basis": "MANUAL",
  "refund_status": "NONE",
  "event_details": {},
  "order_version": 3,
  "occurred_at": 1786700000000
}
```

金额单位均为整数分，时间为 Unix 毫秒。`event_details` 随事件类型变化：

| `event_type` | `event_details` |
| --- | --- |
| `PAYMENT_CONFIRMED` | `payment_match_id`、`evidence_type` |
| `PAYMENT_DISPUTED` | `payment_match_id` |
| `REFUND_UPDATED` | `refund_record_id`、`refund_amount_cents`、`refunded_amount_cents` |

数据库升级不会改写历史 Outbox 字节，因此恢复自旧版本的数据卷时仍可能读取到 `perpay:outbox-event:v1`。接收方和 `GET /api/v1/events/{eventId}` 的调用方必须按 `schema` 分派，保留未知字段，并容忍未来出现新的事件类型；不能把未知事件当成支付成功。

## 严格 ACK

只有同时满足以下条件才确认 delivery：

- HTTP 状态码恰好为 `200`。
- `Content-Type` 为 `application/json`，可以不带 charset，或只带 `charset=utf-8`。
- `Content-Encoding` 不存在或为 `identity`。
- 响应体不超过 16 KiB，是没有重复键的 UTF-8 JSON。
- JSON 只包含下面四个字段，不得有额外字段。
- `event_id` 和 `delivery_id` 与本次请求头完全相同。

```json
{
  "schema": "perpay:webhook-ack:v1",
  "ack": true,
  "event_id": "复制本次 X-PerPay-Webhook-Event-Id",
  "delivery_id": "复制本次 X-PerPay-Webhook-Delivery-Id"
}
```

推荐接收顺序：验签，严格解析事件，在本地事务中按 `event_id` 写入幂等记录并提交业务状态，最后返回 ACK。重复事件已经处理成功时，也应返回与当前 delivery 匹配的 ACK。不要先 ACK 再异步写入关键业务状态。

## 重试与补发

自动投递保持 `event_id`、`delivery_id` 和 generation 不变，`attempt` 每次增加。默认最多尝试 12 次，使用带确定性抖动的指数退避；默认基础为 5 秒、上限为 3600 秒。

- HTTP `408`、`425`、`429` 和 `5xx` 会重试。
- HTTP 200 但 ACK 缺失、JSON/字段/ID 不匹配通常会重试。
- 其他 `4xx`、不支持的响应编码、非公网 DNS、TLS 证书失败、重定向目标或超大响应属于永久失败。
- 进程退出或请求结果无法确定时记录 `OUTCOME_UNKNOWN`，并按至少一次语义重试。
- 达到尝试上限或发生永久失败后进入 `DEAD_LETTER`。

管理员只能对最新一代、状态为 `ACKNOWLEDGED` 或 `DEAD_LETTER` 的 delivery 发起人工补发。补发使用调用方生成的 UUID v4 `redelivery_id` 作为幂等键，创建下一 generation 和新的 `delivery_id`；完全相同的请求重放返回既有结果，即使通知随后被关闭或允许 origin 已轮换也不会创建或重新激活 delivery。同一编号改动理由或目标 delivery 返回冲突；新的补发代次始终按当前通知配置校验。

业务去重应以 `event_id` 为主，而不是 `delivery_id` 或 `attempt`。`delivery_id` 用于对一次自动重试链返回 ACK，generation 和 attempt 用于诊断。

## 出站安全边界

每次尝试都会重新解析目标域名，最多接受 16 个地址，且所有 A/AAAA 结果都必须是全局公网地址。系统将经过检查的结果固定到 TLS 连接，并在响应时复核实际远端地址。DNS 解析并发有界，单次总超时同时覆盖 DNS 与 HTTPS。

系统不会读取 `HTTP_PROXY`、`HTTPS_PROXY` 或类似代理环境变量，不会跟随 `3xx`，不会执行协议升级，不接受压缩响应，并为每次请求关闭连接。这些限制用于阻止通知配置成为内网访问或开放代理通道。

## 密钥轮换

更改 `PERPAY_WEBHOOK_SECRET` 并重启会生成新的单调密钥版本和 `key_id`。新尝试立即使用新密钥；旧版本只保留标识与指纹，不保存旧明文密钥。系统拒绝重新启用已经退役的密钥指纹。

轮换应先让接收方临时接受新旧两份密钥，再更新 Compose 并重启，确认只出现新 `key_id` 后再移除旧密钥。不要在日志、管理页面、错误响应或问题单中记录密钥、完整签名或原始敏感事件。

## 查询与运维

API 客户端用原有 HMAC 请求认证读取自己的事件：

```text
GET /api/v1/events/{eventId}
```

不存在、ID 非法或属于其他客户端均返回 `404 event_not_found`，避免跨客户端探测。

管理员会话可读取 delivery 列表、详情和 attempts。人工补发还要求同源、CSRF 和近期密码 step-up。attempt 投影包含签名 key ID、请求体指纹、解析地址指纹、连接地址、HTTP/ACK 结果和时间，但永远不返回内部租约 token。

匿名 `/readyz` 只返回顶层状态；签名的 `/api/v1/system/status` 返回完整通知健康。持续 `degraded`、`dead_letters > 0`、`pending_deliveries` 长期不下降或 `last_success_at` 长期不更新都需要人工检查。
