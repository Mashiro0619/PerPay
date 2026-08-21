<!-- SPDX-License-Identifier: MIT -->

# PerPay 使用方法

本文面向需要把网站接入 PerPay 的开发者。所有 API 密钥和通知密钥只能保存在网站后端，不能放进浏览器 JavaScript、移动端安装包或公开仓库。

## 1. 准备配置

1. 通过 `POST /api/admin/v1/setup` 设置管理员密码，再通过 `POST /api/admin/v1/session/login` 创建管理员会话。
2. 使用 `POST /api/admin/v1/settings/provider/application-key/actions/generate` 和 `POST /api/admin/v1/settings/api-key/actions/rotate` 生成或轮换 `default` 客户端 API 密钥。
3. 使用 `PUT /api/admin/v1/settings/notifications` 启用通知并填写网站的 HTTPS Origin，例如 `https://shop.example.com`。这里只填写来源，不填写路径。
4. 使用密钥 reveal 管理接口查看通知密钥，并只保存到网站后端的环境变量或密钥管理器。
5. 创建订单时，将 `notify_url` 填成已允许来源下的完整地址，例如 `https://shop.example.com/webhooks/perpay`。

## 2. 请求签名

每次请求都必须生成新的 Unix 秒时间戳和 32 字节随机 `base64url` nonce。签名原文由以下 8 行组成，换行符必须是 LF：

```text
PERPAY-HMAC-SHA256
v1
大写 HTTP 方法
规范化 origin-form 路径和查询字符串
Unix 秒时间戳
32 字节 base64url nonce
客户端 ID（固定为 default）
请求体的小写 SHA-256
```

请求头为：

```text
X-PerPay-Client-Id
X-PerPay-Timestamp
X-PerPay-Nonce
X-PerPay-Signature-Version
X-PerPay-Signature
```

示例使用 Node.js 24 内置 `fetch`：

```js
import { createHash, createHmac, randomBytes } from "node:crypto";

const perpayUrl = process.env.PERPAY_URL ?? "https://pay.example.com";
const clientId = "default";
const secret = Buffer.from(process.env.PERPAY_API_SECRET, "base64url");

async function perpayRequest(method, target, data) {
  const body = data === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(data));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(32).toString("base64url");
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const signingText = [
    "PERPAY-HMAC-SHA256", "v1", method.toUpperCase(), target,
    timestamp, nonce, clientId, bodyDigest,
  ].join("\n");
  const signature = createHmac("sha256", secret).update(signingText).digest("hex");
  const response = await fetch(new URL(target, perpayUrl), {
    method,
    headers: {
      "content-type": "application/json",
      "x-perpay-client-id": clientId,
      "x-perpay-timestamp": timestamp,
      "x-perpay-nonce": nonce,
      "x-perpay-signature-version": "v1",
      "x-perpay-signature": signature,
    },
    body: body.length === 0 ? undefined : body,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`PerPay ${response.status}: ${JSON.stringify(result)}`);
  return result.data;
}
```

签名密钥只在服务端使用。时钟偏差超过允许范围、nonce 重复、请求体被改动或签名路径不一致，都会导致请求被拒绝。

## 3. 创建订单

`amount_cents` 使用人民币分，`1000` 表示 10.00 元。`idempotency_key` 必须在同一业务订单的重试中保持不变；金额、商品名称、备注、商户订单号或通知地址变化时不能复用旧幂等键。

```js
const order = await perpayRequest("POST", "/api/v1/orders", {
  idempotency_key: `shop-${yourOrderId}`,
  merchant_order_no: String(yourOrderNo),
  amount_cents: 1000,
  product_name: "商品名称",
  note: "可选的商户备注",
  notify_url: "https://shop.example.com/webhooks/perpay",
  return_url: "https://shop.example.com/orders/paid",
});

// 返回给浏览器，或由网站服务端直接 303 跳转。
return Response.redirect(order.checkout.checkout_url, 303);
```

订单响应中的 `data.payment.status` 有以下值：

| 状态 | 含义 |
| --- | --- |
| `UNPAID` | 尚未付款或尚未采集到唯一流水。 |
| `CONFIRMED` | 已自动确认或已由管理员认领。 |
| `DISPUTED` | 已撤销付款关联，进入争议处理。 |

只有 `CONFIRMED` 才能为用户发货或充值。订单关闭、过期和退款需要结合 `data.checkout`、`data.refund` 一起判断。

## 4. 查询订单

使用同一套签名工具调用：

```text
GET /api/v1/orders/{order_id}
```

网站服务端应在用户返回收银台后主动查询一次，并以 PerPay 服务端的最终状态为准。浏览器跳转结果不能直接视为支付成功。

## 5. 回调通知

PerPay 会向订单的 `notify_url` 发送签名 JSON。通知可能重复、延迟或乱序，网站必须按 `event_id` 做幂等处理，不能按投递次数重复发货、充值或增加余额。

请求头为：

```text
X-PerPay-Webhook-Version
X-PerPay-Webhook-Key-Id
X-PerPay-Webhook-Timestamp
X-PerPay-Webhook-Delivery-Id
X-PerPay-Webhook-Event-Id
X-PerPay-Webhook-Attempt
X-PerPay-Webhook-Signature
```

接收端必须先读取原始请求体，再计算摘要和验签。不要先解析 JSON 再重新序列化：字段顺序、空白和编码变化都会使摘要不同。

下面是 Node.js Fetch 风格的完整接收示例：

```js
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const webhookSecret = Buffer.from(process.env.PERPAY_WEBHOOK_SECRET, "base64url");

export async function receivePerPayWebhook(request) {
  const body = Buffer.from(await request.arrayBuffer());
  const headers = request.headers;
  const version = headers.get("x-perpay-webhook-version");
  const keyId = headers.get("x-perpay-webhook-key-id");
  const timestamp = headers.get("x-perpay-webhook-timestamp");
  const deliveryId = headers.get("x-perpay-webhook-delivery-id");
  const eventId = headers.get("x-perpay-webhook-event-id");
  const attempt = headers.get("x-perpay-webhook-attempt");
  const received = headers.get("x-perpay-webhook-signature");

  if (!version || !keyId || !timestamp || !deliveryId || !eventId || !attempt || !received) {
    return new Response("invalid webhook headers", { status: 400 });
  }

  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const signingText = [
    "perpay:webhook:v1", keyId, timestamp, deliveryId, eventId, attempt, bodyDigest,
  ].join("\n");
  const expected = `v1=${createHmac("sha256", webhookSecret)
    .update(signingText, "utf8").digest("hex")}`;
  const valid = received.length === expected.length && timingSafeEqual(
    Buffer.from(received, "ascii"), Buffer.from(expected, "ascii"),
  );
  if (version !== "1" || !valid) {
    return new Response("invalid webhook signature", { status: 401 });
  }

  const event = JSON.parse(body.toString("utf8"));
  // 在数据库事务中按 event.event_id 去重；重复通知直接返回同一个 ACK。
  await processOnceByEventId(event.event_id, event);

  return Response.json({
    schema: "perpay:webhook-ack:v1",
    ack: true,
    event_id: eventId,
    delivery_id: deliveryId,
  });
}
```

通知 JSON 的固定核心字段包括：

```json
{
  "schema": "perpay:outbox-event:v2",
  "event_id": "evt_...",
  "event_type": "PAYMENT_CONFIRMED",
  "order_id": "ord_...",
  "merchant_order_no": "ORDER-20260821-0001",
  "product_name": "商品名称",
  "note": "用户名：demo",
  "payment_status": "CONFIRMED",
  "payment_basis": "INFERRED",
  "refund_status": "NONE",
  "order_version": 2,
  "occurred_at": 1776700800000
}
```

接收成功必须返回 HTTP `200`、`application/json`，响应体只能包含以下四个字段：

```json
{
  "schema": "perpay:webhook-ack:v1",
  "ack": true,
  "event_id": "evt_...",
  "delivery_id": "delivery_..."
}
```

网络错误、`5xx`、`429` 或错误 ACK 会触发重试；`401`、`403` 等鉴权错误可能直接进入失败或死信。事件类型包括 `PAYMENT_CONFIRMED`、`PAYMENT_DISPUTED` 和 `REFUND_UPDATED`，客户端应根据 `schema` 分派并容忍未来增加的字段。

## 6. 上线检查

- API 密钥和通知密钥只保存在网站服务端环境变量或密钥管理器。
- 生产环境使用 HTTPS，`notify_url` 必须位于管理 API 配置的允许来源下，不能依赖重定向。
- 创建订单遇到网络超时，使用相同幂等键重试，不要重复生成业务订单号。
- 通知和查询都可能重复或乱序，业务状态更新必须幂等并单向推进。
- 只有服务端查询或验签通知显示 `CONFIRMED` 时，才执行发货、充值或余额增加。

完整字段、错误码和接口契约见 [`openapi.yaml`](openapi.yaml)。
