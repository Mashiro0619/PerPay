<!-- SPDX-License-Identifier: MIT -->

# 原生 API 快速接入指南

本文说明自研业务后端接入 PerPay 原生支付接口的核心流程：请求签名、创建订单、跳转收银台、回调验签与幂等履约。

> - 若业务系统已内置易支付插件，请参阅 [易支付 V1/V2 接入指南](epay-integration.md)。
> - 如需先运行可交互参考实现，请参阅 [Node.js 调用端示例](../examples/node-client/README.md)。

---

## 前置参数

在 PerPay 创建业务网站并绑定收款账号后，于 **网站设置 → 接入与通知** 获取以下配置（均应仅保存于业务后端，切勿暴露至前端）：

| 参数 | 说明 |
| --- | --- |
| `PERPAY_URL` | PerPay 基址，如 `https://pay.example.com`（不含 `/admin` 或 `/api`） |
| `PERPAY_CLIENT_ID` | 当前网站的客户端 ID |
| `PERPAY_API_SECRET` | API 密钥，用于对发往 PerPay 的请求签名 |
| 通知签名密钥 | 独立密钥，用于验证 PerPay 推送的回调通知签名 |
| `notification_origin` | 后台配置的回调接收域名，如 `https://shop.example.com`（仅协议与域名，不含路径） |
| `return_origin`（可选） | 收银台「返回商家」目标域名，格式同上 |

---

## 1. 计算请求签名

所有原生业务接口 `/api/v1/*` 均采用 HMAC-SHA256 认证：

- 每次请求生成当前 Unix **秒**时间戳（允许 ±5 分钟偏差）和全新的 32 字节随机 `nonce`（无填充 base64url，43 字符）。
- 将 `PERPAY_API_SECRET` 从 base64url 解码为原始字节，对以下 8 行文本（以 `\n` 连接，末尾无换行）计算 HMAC-SHA256 并输出小写十六进制：

```text
PERPAY-HMAC-SHA256
v1
大写 HTTP 方法
规范化路径与查询串（如 /api/v1/orders）
Unix 秒时间戳
base64url nonce
当前客户端 ID
原始请求体的小写 SHA-256（空请求体固定为 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855）
```

请求须携带 5 个认证头：`X-PerPay-Client-Id`、`X-PerPay-Timestamp`、`X-PerPay-Nonce`、`X-PerPay-Signature-Version: v1`、`X-PerPay-Signature`。

Node.js 项目可直接复用 [perpay.mjs](../examples/node-client/perpay.mjs)；其他语言实现请遵循 [路径规范化规则](../USAGE.md#2-请求签名) 并使用 [签名测试向量](signature-vectors.md) 校验：

```js
import { PerPayClient, orderSnapshot } from "./examples/node-client/perpay.mjs";

const client = new PerPayClient({
  url: process.env.PERPAY_URL,
  clientId: process.env.PERPAY_CLIENT_ID,
  secret: process.env.PERPAY_API_SECRET,
});
```

---

## 2. 创建订单

调用 `POST /api/v1/orders` 前，应先将商户单号、`idempotency_key` 及完整下单参数持久化到业务数据库：

```json
{
  "idempotency_key": "shop-SHOP-1001",
  "merchant_order_no": "SHOP-1001",
  "amount_cents": 1000,
  "product_name": "商品名称",
  "notify_url": "https://shop.example.com/webhooks/perpay",
  "return_url": "https://shop.example.com/orders/result"
}
```

- `amount_cents` 单位为人民币分（`1000` 表示 `10.00` 元）。
- 首次创建返回 `201`；携带相同参数重复提交返回 `200` 与原订单。
- 请求超时或网络中断导致结果不确定时，先调用 `GET /api/v1/orders/by-merchant-no/{merchant_order_no}` 查单；确认未创建再重试。重试须保持原商户单号、原 `idempotency_key` 与原业务载荷不变，但每次必须重新生成时间戳、`nonce` 与签名（详见 [业务错误码与重试](integration-errors.md)）。

---

## 3. 跳转公开收银台

读取响应中的 `checkout.checkout_url`，仅在 `checkout.status === "OPEN"` 且 `payment.status === "UNPAID"` 时返回 `303` 跳转：

```js
async function openCheckout(savedRequest) {
  const order = await client.createOrder(savedRequest);
  const snapshot = orderSnapshot(order, client.origin);
  if (snapshot.checkout_status === "OPEN" && snapshot.payment_status === "UNPAID") {
    return Response.redirect(snapshot.checkout_url, 303);
  }
  return Response.json(snapshot);
}
```

> **说明**：付款人须按收银台显示的完整应付金额付款（含 PerPay 小额加价）。`return_url` 仅用于浏览器同步回跳展示，收到跳转后应由业务后端主动查单确认状态，不可凭浏览器跳转参数直接履约。

---

## 4. 接收回调请求

在业务后端提供公网 HTTPS 回调接口（如 `POST /webhooks/perpay`），需满足两点前提：

1. 读取**未经解析或重序列化的原始请求体（Raw Body）**用于验签。
2. 保留 7 个回调请求头：`X-PerPay-Webhook-Version`（`1`）、`X-PerPay-Webhook-Key-Id`、`X-PerPay-Webhook-Timestamp`（Unix **毫秒**）、`X-PerPay-Webhook-Delivery-Id`、`X-PerPay-Webhook-Event-Id`、`X-PerPay-Webhook-Attempt`、`X-PerPay-Webhook-Signature`（`v1=<hex>`）。

---

## 5. 验签与回复 ACK

参考实现见 [perpay.mjs](../examples/node-client/perpay.mjs) 与 [server.mjs](../examples/node-client/server.mjs)，处理顺序如下：

1. 校验协议版本与时间戳偏差（建议容差 ±5 分钟）。
2. 将通知签名密钥从 base64url 解码，对以下 7 行文本（以 `\n` 连接，末尾无换行）计算 HMAC-SHA256，与签名头 `v1=` 后内容做恒定时间比对：

   ```text
   perpay:webhook:v1
   key-id
   Unix 毫秒时间戳
   delivery-id
   event-id
   attempt
   原始通知正文的小写 SHA-256
   ```

3. 验签通过后再解析 JSON，校验正文与请求头中的 `event_id` 一致。
4. 业务数据库事务提交完成后，返回 **HTTP `200`**、`Content-Type: application/json` 及严格的 4 字段 JSON 回执（ACK）：

```json
{
  "schema": "perpay:webhook-ack:v1",
  "ack": true,
  "event_id": "取自本次已验签通知",
  "delivery_id": "取自本次请求头"
}
```

> **注意**：
> - 返回 `204`、纯文本 `success` 或增删字段的 JSON 均不视为有效原生 ACK，PerPay 会判定失败并重试。
> - 数据库写入等临时故障应返回 `500` 或 `503` 以触发自动重试；返回 `410` 将立即终止重试。
> - 通知密钥轮换期间可按 `key-id` 同时配置新旧密钥，参考 [Demo 密钥轮换](../examples/node-client/README.md#通知密钥轮换与可重试错误)。

---

<a id="6-幂等履约"></a>

## 6. 幂等履约与状态处理

回调通知可能出现重复、延迟或乱序。建议在**同一数据库事务**中完成以下校验与写入：

1. **校验订单匹配**：查询本地订单，核对 `order_id`、`merchant_order_no`、原价 `requested_amount_cents` 及币种 `CNY`。
2. **事件去重与版本防回退**：以 `event_id` 去重（已处理事件直接返回当前 `delivery_id` 的 ACK）；按 `order_version` 推进状态，拒绝较旧版本覆盖较新版本。
3. **按状态履约**：
   - `CONFIRMED`：为该订单创建唯一的发货/充值任务，事务提交后再返回 ACK。
   - `UNPAID`：保持等待。
   - `DISPUTED`：标记异常并转人工核查（历史 `REFUND_UPDATED` 可兼容忽略；后台新的「标记已退款」不发送业务通知）。

若长时间未收到回调，可在 PerPay 后台检查投递日志或由业务端主动查单补齐状态。若旧收银台已过期或关闭且仍未付款，需发起新支付时应使用新的商户单号与 `idempotency_key`。

完整协议字段与后台规则见 [USAGE.md](../USAGE.md) 与 [openapi.yaml](../openapi.yaml)。
