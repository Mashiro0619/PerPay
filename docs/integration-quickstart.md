<!-- SPDX-License-Identifier: MIT -->

# 快速接入 PerPay

本指南带你用原生 API 完成下单、打开收银台和接收付款通知。已有易支付插件的网站可直接阅读[易支付接入](epay-integration.md)；需要先跑通一个接收端，可使用 [Node.js 调用端示例](../examples/node-client/README.md)。

先在 PerPay 创建业务网站，配置可用的收款账号，再从「网站设置 → 接入与通知」取得以下参数：

| 参数 | 填写方式 |
| --- | --- |
| `PERPAY_URL` | PerPay 服务地址，如 `https://pay.example.com`，不带 `/admin` 或 `/api`。 |
| `PERPAY_CLIENT_ID` | 当前网站的客户端 ID。 |
| `PERPAY_API_SECRET` | 「管理 API 与通知密钥」中的 API 密钥，业务后端用它为请求生成签名。 |
| 通知密钥 | 同一网站的通知签名密钥，用于业务后端验证收到的签名（验签）。 |
| `notification_origin` | 接收通知的网站地址，如 `https://shop.example.com`，包含 `https://`、域名和必要的端口，不带路径。 |
| `return_origin`（可选） | 付款人返回的业务网站地址，填写格式同上。 |

API 密钥用于向 PerPay 证明请求来自你的业务后端，通知密钥用于验证 PerPay 发来的通知；两者都保存在业务后端。接收端配置完成后，在 PerPay 开启该网站的通知。更换客户端 ID 时，同步更新业务端配置；已有订单和防止重复下单的记录仍属于原网站。[网站身份与密钥](multi-site.md#创建与接入)

## 1. 签名

每次请求都使用当前 Unix **秒**时间戳，并生成 32 字节随机值，用 base64url 编码后作为 nonce。nonce 每次只能使用一次，用于识别重复发送的请求。将 API 密钥从 base64url 解码为字节，用 HMAC-SHA256 计算以下八行文本的签名；行间使用 LF，末尾没有换行，结果为小写十六进制：

```text
PERPAY-HMAC-SHA256
v1
大写 HTTP 方法
规范化的路径和查询字符串
Unix 秒时间戳
base64url nonce
当前客户端 ID
原始请求体的小写 SHA-256
```

发送 `X-PerPay-Client-Id`、`X-PerPay-Timestamp`、`X-PerPay-Nonce`、`X-PerPay-Signature-Version: v1` 和 `X-PerPay-Signature`。JSON 请求使用 `Content-Type: application/json`；GET 以零字节正文计算摘要。服务端允许前后五分钟的时钟偏差。

Node.js 可复用 [PerPayClient](../examples/node-client/perpay.mjs)。以下代码的导入路径以仓库根目录为起点：

```js
import { PerPayClient, orderSnapshot } from "./examples/node-client/perpay.mjs";

const client = new PerPayClient({
  url: process.env.PERPAY_URL,
  clientId: process.env.PERPAY_CLIENT_ID,
  secret: process.env.PERPAY_API_SECRET,
});
```

该客户端已经实现下单、按订单 ID 查单和按商户订单号查单所需的签名。这些接口使用固定 ASCII 路径，不带查询参数。自行编写其他语言的客户端，或增加其他路径和查询参数时，按[请求目标规范化规则](../USAGE.md#2-请求签名)处理，并用[固定签名向量](signature-vectors.md)核对每一步的计算结果。

## 2. 下单

业务后端先保存商户订单号、幂等键和完整请求参数，再调用 `POST /api/v1/orders`。幂等键用于识别同一次下单，让超时后的重复提交仍返回原订单：

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

`amount_cents` 是整数分，`1000` 表示 10.00 元。`notify_url` 和 `return_url` 是完整 URL，来源分别匹配该网站的通知来源和返回来源；`return_url` 可省略。订单备注使用可选字段 `note`。完整字段限制见 [USAGE](../USAGE.md#3-创建订单)。

首次创建返回 HTTP `201`，重复提交相同请求返回原订单和 `200`。超时或响应丢失时，用 `client.getByMerchantNo("SHOP-1001")` 找回订单；已知 `order_id` 时也可用 `client.getOrder(orderId)`。需要重试下单时，保持原单号、幂等键和全部参数，每次重新生成时间戳、nonce 和签名。

业务客户端应记录 HTTP 状态、`error.code`、`Retry-After` 和请求编号，再按[错误码与重试规则](integration-errors.md)决定等待多久、是否重试。示例客户端把 PerPay 返回的错误转成可读消息，不自动重试；为它增加自动重试时，还需保留上述响应信息。

## 3. 跳转收银台

收银台地址在响应的 `data.checkout.checkout_url` 中；`PerPayClient` 已取出 `data`。在业务后端读取上一步保存的 `savedRequest`：

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

`orderSnapshot` 会核对订单数据和收银台来源。付款人按收银台显示的准确金额付款，例如商品 10.00 元，对应应付金额可能是 10.03 元。

`return_url` 用于浏览器返回。业务网站收到返回请求后主动查单，并以服务端的付款状态更新页面；发货和充值由后端确认。

## 4. 接收通知

为业务网站设置 `POST /webhooks/perpay` 接收路由，保留原始正文及以下请求头：

```text
X-PerPay-Webhook-Version
X-PerPay-Webhook-Key-Id
X-PerPay-Webhook-Timestamp
X-PerPay-Webhook-Delivery-Id
X-PerPay-Webhook-Event-Id
X-PerPay-Webhook-Attempt
X-PerPay-Webhook-Signature
```

通知版本头为 `1`，时间戳为 Unix **毫秒**，签名为 `v1=<小写十六进制>`。接收路由应限制正文大小和处理超时，并把验签放在 JSON 解析和业务处理之前。

## 5. 验签并确认接收

使用 [verifyWebhook](../examples/node-client/perpay.mjs) 按以下顺序处理；完整 HTTP 接收方式见 [server.mjs](../examples/node-client/server.mjs)：

1. 读取未经重写的原始正文，检查版本、头部格式，以及发送时间与本机时间的偏差。
2. 选择该网站的通知密钥，验证 HMAC，再解析 JSON。核对正文与头部的 `event_id`、事件类型及订单字段。
3. 将下一节要求的订单状态和处理记录保存到数据库，提交事务后返回成功回执。

通知签名原文依次为 `perpay:webhook:v1`、key-id、毫秒时间戳、delivery-id、event-id、attempt 和原始正文 SHA-256，以 LF 连接。通知密钥也须先从 base64url 解码；不要对解析后的 JSON 重新序列化来验签。

回执使用 HTTP `200`、`Content-Type: application/json`，正文只能包含以下四个字段，编号取自本次已验签通知：

```js
const acknowledgement = {
  schema: "perpay:webhook-ack:v1",
  ack: true,
  event_id: verified.event.event_id,
  delivery_id: verified.deliveryId
};
```

成功回执也称 ACK。重复收到通知时仍要验签，并使用本次 `delivery_id` 回执。`204`、纯文本 `success` 或缺字段 JSON 都不是原生通知的有效 ACK。数据库保存失败时应返回临时错误；`410` 表示明确拒收，会终止重试。

更换通知密钥时，可根据 PerPay 后台提供的 key-id 配置新旧两把密钥。示例支持 `PERPAY_WEBHOOK_KEYS`；遇到未知 key-id，或通知时间戳与本机相差超过五分钟时，返回 `503`，修好配置或校准时钟后由 PerPay 重试。[更换密钥的配置](../examples/node-client/README.md#通知密钥轮换与可重试错误)

<a id="6-幂等履约"></a>

## 6. 避免重复发货或开通服务

通知可能重复、延迟或乱序，同一笔业务订单仍应只发货、充值或开通服务一次。把以下操作放进同一个数据库事务，保证它们一起保存成功：

1. 找到本站已有订单，核对 `order_id`、`merchant_order_no`、下单金额和币种。
2. 用 `event_id` 判断这条通知是否已经处理，再按 `order_version` 更新状态；旧版本不覆盖新版本，同一版本内容冲突时交给管理员核对。
3. 通知已验签且付款状态为 `CONFIRMED` 时，按业务规则为该订单创建唯一的发货或充值任务；提交事务后发送 ACK。后台执行任务时也按业务订单防止重复处理，并保存执行进度，以便失败后继续。
4. `UNPAID` 保持等待，`DISPUTED` 交给管理员核对。兼容历史 `REFUND_UPDATED`；新的管理员退款标记不产生业务通知，外部退款由业务系统另行处理。

通知迟迟未到时，查看 PerPay 的通知发送记录，并主动查单。处理查询结果时，同样检查订单版本，防止重复发货或充值，可参考 [DemoStore](../examples/node-client/store.mjs)。

确认旧收银台已关闭或过期且仍未付款后，新的付款尝试使用新的商户订单号和幂等键。保留旧单和原参数，继续处理其后续合法通知；截止前付款的流水仍可能稍后才被发现。

完整响应、事件字段、ACK 和重试策略见 [USAGE](../USAGE.md)，接口字段与类型定义见 [OpenAPI](../openapi.yaml)。
