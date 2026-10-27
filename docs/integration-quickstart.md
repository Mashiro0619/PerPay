<!-- SPDX-License-Identifier: MIT -->

# 快速接入 PerPay

本文按一次网站支付的顺序接入。完整字段见 [OpenAPI](../openapi.yaml)，可运行版本见 [Node.js 调用端示例](../examples/node-client/README.md)。示例使用 Node.js 24.15+（24.x）；下面的请求正文和函数定义不会自动下单或付款。

接入前，在 PerPay 创建业务网站，确认收款就绪，并准备以下配置：

| 配置 | 用途 |
| --- | --- |
| `PERPAY_URL`、`PERPAY_CLIENT_ID` | PerPay 的来源地址和该业务网站的客户端 ID；地址不带 `/admin`。 |
| `PERPAY_API_SECRET` | 业务后端签名调用 PerPay，使用后台生成的 32 字节 base64url 密钥。 |
| 通知密钥、`notification_origin` | 验证通知；通知来源填业务网站的 HTTPS Origin，不带路径。 |
| `return_origin`（可选） | 允许收银台返回的业务网站来源，与通知来源分别配置。 |

API 密钥和通知密钥用途不同，只保存在业务后端。先配置接收端，再启用该网站的通知；需要下单时再由用户明确发起。安装与试运行步骤见示例 README。

## 1. 签名

每次 API 请求都重新生成 Unix **秒**时间戳和 32 字节随机 base64url nonce。用解码后的 API 密钥计算 HMAC-SHA256，输出小写十六进制签名。签名原文为以下八行，以 LF 连接，末尾不追加换行：

```text
PERPAY-HMAC-SHA256
v1
大写 HTTP 方法
规范化的路径和查询字符串
Unix 秒时间戳
base64url nonce
客户端 ID
原始请求体的小写 SHA-256
```

发送 `X-PerPay-Client-Id`、`X-PerPay-Timestamp`、`X-PerPay-Nonce`、`X-PerPay-Signature-Version: v1`、`X-PerPay-Signature`；JSON 正文使用 `Content-Type: application/json`。GET 的正文按零字节计算摘要。

实现其他语言的签名时，先用[固定签名测试向量](signature-vectors.md)核对原始字节和预期签名。

可以复用已测试的 [PerPayClient](../examples/node-client/perpay.mjs)。以下导入路径按仓库根目录中的 Node.js 模块编写：

```js
import { PerPayClient, orderSnapshot } from "./examples/node-client/perpay.mjs";
const client = new PerPayClient({
  url: process.env.PERPAY_URL,
  clientId: process.env.PERPAY_CLIENT_ID,
  secret: process.env.PERPAY_API_SECRET,
});
```

该示例只支持固定 ASCII 订单路径，不含查询参数；扩展其他路径前按[请求签名说明](../USAGE.md#2-请求签名)和 OpenAPI 实现规范化。签名与发送必须使用同一份正文，不能在签名后重新序列化。

示例不自动重试，也未把远端状态和 `Retry-After` 单独暴露给调用者；生产客户端应保留 HTTP 状态、错误码与该响应头，再实现下述重试策略。

## 2. 下单

业务后端调用 `POST /api/v1/orders`，首次成功为 HTTP `201`，同一请求的幂等重放为 `200`。先在业务数据库保存商户订单号、幂等键及完整请求参数，再发送请求。例如：

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

金额使用整数分，`1000` 表示 10.00 元。`notify_url`、`return_url` 是完整 URL，其来源须分别匹配该网站配置；`return_url` 可省略。备注使用可选字段 `note`。

超时或响应丢失时，先用 `client.getByMerchantNo("SHOP-1001")` 查询；也可用已取得的 `order_id` 调用 `client.getOrder(orderId)`。重试下单保持原单号、幂等键和参数，每次重新签名，不能把未知结果当成失败直接换单。业务侧按错误及 `Retry-After` 退避，设定最大等待时间。

具体响应分类见[业务错误码与重试建议](integration-errors.md)。

确认旧单收银台已关闭或过期且仍未付款后，新付款尝试使用新商户订单号和新幂等键。保留旧单及原参数，继续处理旧单后续的合法通知；收银台过期不等于可以忽略迟到的收款确认。

## 3. 跳转收银台

成功响应在 `data.checkout.checkout_url` 给出收银台地址；`PerPayClient` 已取出 `data`。在业务后端的用户下单处理函数中调用，`savedRequest` 为上一步已持久化的请求：

```js
async function openCheckout(savedRequest) {
  const order = await client.createOrder(savedRequest);
  const snapshot = orderSnapshot(order, client.origin);
  if (!snapshot.checkout_url) throw new Error("订单不能继续付款，请先查询订单状态。");
  return Response.redirect(snapshot.checkout_url, 303);
}
```

`orderSnapshot` 校验返回订单及收银台来源。付款人在收银台按含识别尾数的准确金额付款；下单金额和实际应付金额可能不同。`return_url` 只是浏览器返回地址，打开返回页或看到前端成功提示都不能作为发货依据。

## 4. 接收通知

把业务网站的 `POST /webhooks/perpay` 交给后端处理，并保留未经解析、重写或解压的原始正文和下列请求头：

```text
X-PerPay-Webhook-Version
X-PerPay-Webhook-Key-Id
X-PerPay-Webhook-Timestamp
X-PerPay-Webhook-Delivery-Id
X-PerPay-Webhook-Event-Id
X-PerPay-Webhook-Attempt
X-PerPay-Webhook-Signature
```

通知时间戳是 Unix **毫秒**，版本头为 `1`，签名格式为 `v1=<小写十六进制>`。通知会重复、延迟或乱序，接收器需要有限的正文大小与超时。不要在验签前保存成有效业务事件或返回成功 ACK。

## 5. 验签并确认接收

复用 [verifyWebhook](../examples/node-client/perpay.mjs)，按 [server.mjs](../examples/node-client/server.mjs) 的顺序读取原始字节、验签，再调用持久化处理。不要对解析后的 JSON 重新序列化来验签。

通知使用独立通知密钥。HMAC 原文依次为 `perpay:webhook:v1`、key-id、毫秒时间戳、delivery-id、event-id、attempt 和原始正文 SHA-256，以 LF 连接；与 API 请求签名格式不同。

示例校验头部格式、五分钟时间偏差、恒定时间签名比较、正文与头部事件 ID、事件类型及订单字段。轮换期间可配置 `PERPAY_WEBHOOK_KEYS`，按已确认的 key-id 选择新旧密钥；不要从未验签请求自动添加密钥。未知 key-id 或时钟偏差应先修复配置，再由 PerPay 重试。

完成下一节的持久化事务后，返回 HTTP `200`、`Content-Type: application/json` 和且仅有以下四个字段。编号必须取自**本次已验签通知**：

```js
const acknowledgement = {
  schema: "perpay:webhook-ack:v1",
  ack: true,
  event_id: verified.event.event_id,
  delivery_id: verified.deliveryId
};
```

同一事件再次投递也要验签；ACK 的 delivery-id 使用本次值，不能盲目复用旧投递的回执。`204`、普通 `success` 文本或缺字段 JSON 都不是有效 ACK。持久化失败时不要返回成功；`410` 表示明确拒收并终止重试，不能用来表示临时故障。

## 6. 幂等履约

1. 将已验签通知关联到本站已有业务订单，核对 `order_id`、`merchant_order_no`、金额和币种。以 `event_id` 做持久化去重，重复通知不重复发货或充值。
2. 在数据库事务中保存事件，按 `order_version` 更新订单，旧版本不能覆盖新状态。同一版本内容冲突时进入核查；可参考 [DemoStore](../examples/node-client/store.mjs) 的事件与版本处理。
3. 仅在可信的 `CONFIRMED` 状态及业务规则允许时，持久化一条唯一的履约任务，再提交事务并发送 ACK。实际发货或充值由任务执行器按业务订单幂等完成，失败可恢复重试。
4. `UNPAID` 不履约，`DISPUTED` 进入业务核查；兼容旧 `REFUND_UPDATED`，并单独处理外部退款。管理员退款标记不会自动同步为业务通知。

通知迟迟不到时，查看 PerPay 的投递记录，并由业务后端用同一套签名接口补查订单。补查结果也要经过相同的订单版本和履约幂等保护。示例只记录订单和通知，不实际发货、充值或退款。

先在 `examples/node-client` 目录运行 `npm test` 验证合成数据，再按示例 README 配置隔离接收端；真实小额付款由操作人明确确认后进行。完整协议和运行边界继续查阅 [USAGE](../USAGE.md)。
