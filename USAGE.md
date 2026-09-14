<!-- SPDX-License-Identifier: MIT -->

# PerPay 使用方法

本文面向需要把网站接入 PerPay 的开发者。所有 API 密钥和通知密钥只能保存在网站后端，不能放进浏览器 JavaScript、移动端安装包或公开仓库。

## 1. 准备配置

首次配置见 [图文教程](docs/alipay-setup.md)，创建订单与回调通知接入可试用 [调用端 Demo](examples/node-client/README.md)。

推荐先访问 `/admin`：完成管理员初始化并登录，跟随六步首次配置向导完成支付宝接入、经营码、网站 API 密钥、可选的业务通知与备份，并检查收款就绪。向导会区分上传至支付宝的应用公钥与从平台取回的支付宝公钥；请先确认应用具备账务明细查询接口权限。已有实例仍可使用“实例设置”的分类表单，也可从该页重新打开向导。

启用业务通知时填写业务网站的 HTTPS Origin；跳过通知则由业务后端主动查询订单状态。备份策略保存并不代表已经验证可恢复，需同时保管主密钥卷。控制台的“测试收款”会创建真实小额订单，不是模拟支付，也不是完成配置的必选项。也可直接调用以下管理 API：

1. 通过 `POST /api/admin/v1/setup` 设置管理员密码，再通过 `POST /api/admin/v1/session/login` 创建管理员会话。
2. 使用 `POST /api/admin/v1/settings/provider/application-key/actions/generate` 生成支付宝应用密钥，再配置支付宝接入与经营码；`POST /api/admin/v1/settings/api-key/actions/rotate` 生成或轮换的是业务端 `default` 客户端 API 密钥，两者不能混用。
3. 使用 `PUT /api/admin/v1/settings/notifications` 启用通知并填写网站的 HTTPS Origin，例如 `https://shop.example.com`。这里只填写来源，不填写路径。
4. 使用密钥 reveal 管理接口查看通知密钥，并只保存到网站后端的环境变量或密钥管理器。
5. 创建订单时，将 `notify_url` 填成已允许来源下的完整地址，例如 `https://shop.example.com/webhooks/perpay`。

### 账本采集节奏

在 **实例设置 → 支付宝接入** 中配置两个间隔，首次向导中位于高级设置：

| 设置 | 新配置默认值 | 使用时机 |
| --- | --- | --- |
| 常规采集间隔（`scan_interval_seconds`） | 30 秒 | 没有有效待支付订单，且收尾期已结束。 |
| 活跃采集间隔（`active_scan_interval_seconds`） | 5 秒 | 当前采集账户仍有未过期的 `OPEN / UNPAID` 订单，或有尚在收尾期的未支付订单。 |

两个间隔均为 5～3600 秒的整数，活跃间隔不能大于常规间隔；两者相同即保持固定频率。采集有效时限须至少为常规间隔的两倍，安全延迟也不能超过该有效时限。保存后由运行时热更新，无须重启进程。

订单关闭或过期后，仍未支付的订单会保留 `max(60 秒, 安全延迟 + 活跃间隔)` 的自动收尾期，以减少临近结束付款的发现延迟；已确认到账的订单不再需要收尾。所有订单共享同一个采集任务，重启后从数据库重新判断当前模式。收尾期结束不代表停止查账，常规采集与既有补扫仍会处理迟到流水。

**升级不会自动改变已有采集频率：** 原间隔会同时成为常规和活跃间隔，例如原来的 10 秒会保留为 10／10 秒。希望启用 30／5 秒时，请主动调整后台设置。管理 API 更新支付宝配置时，若省略 `active_scan_interval_seconds`，两档均使用请求中的 `scan_interval_seconds`，以兼容旧客户端。

间隔指上一轮采集完成后的正常等待时间，不是到账确认时限或严格的请求频率上限。5 秒采集仍受安全延迟、支付宝流水可见时间与请求耗时影响；限流、失败退避和补扫续跑规则继续生效，新订单不会绕过冷却。采集日志中的 `scan_mode`（`normal / active / tail`）和 `scan_interval_milliseconds` 可用于核对当前模式与基础间隔。

### 金额复用冷却与付款截止

在 **实例设置 → 经营码** 的高级设置中配置“金额复用冷却（秒）”，默认 600 秒（10 分钟），范围 60～3600 秒。管理 API 字段为 `amount_reuse_cooldown_seconds`；旧客户端省略该字段时保留当前值。

- 每笔订单在创建时固定其冷却参数。修改设置不改变已有订单；升级时已有订单采用 600 秒快照，但不会重置历史结束时间、扩展付款窗口或重新确认历史付款。
- 主动关闭从关闭时刻计算冷却，自然过期从原定到期时刻计算，不因后台较晚处理过期而重新开始计时。已到账订单也不会提前复用金额。
- 优先分配未使用的应付金额，再选择已冷却且最久未使用的金额；已展示的应付金额不会改变。换码或重启不会清空冷却。
- **冷却不是补付宽限期。** 在订单有效期内实际付款、但较晚采集到流水，仍可正常自动确认；关闭或过期后才实际付款，不自动补认原订单，入账仍保留并按现有异常流程处理。
- 冷却与上面的采集收尾期是不同机制，不新增独立查账任务，也不以反复查询替代归属证据。

金额池不足时，下单返回 `503 / amount_slots_exhausted` 和 `Retry-After`。业务后端可按该间隔退避重试，保持请求体及幂等键不变，但每次重新生成时间戳、nonce 和签名；应设置业务侧最大等待时间，不无限重试。PerPay 不会自动把失败的下单请求排入后台队列。

冷却越长，同一标价的可用金额越少。例如 99 个金额槽、5 分钟订单有效期加 10 分钟冷却，在忽略其他开销的理想情况下，持续容量约为 6.6 单/分钟；不同标价的候选金额也可能重叠。

**静态经营码仍只按金额和时间推断归属，不是订单级支付凭证。** 冷却只能降低迟付串单概率；金额再次使用后发生的极晚付款仍可能混淆，不能把 10 分钟冷却当成完全可靠的订单绑定。

### 管理员登录限流

同一 IPv6 /64 网段共享失败次数；IPv4-mapped IPv6 与对应 IPv4 使用同一限流来源。现有的 5 次失败后退避规则保持不变，未受信任的 `X-Forwarded-For` 不能改变来源。

匿名密码验证（包括初始化）另有持久化实例预算：突发 10 次，每 5 秒恢复 1 次额度，成功登录和重启不会重置额度。额度不足返回 `429 / auth_rate_limited` 与 `Retry-After`；已登录会话和已认证操作不使用该匿名预算。多来源攻击期间，新登录可能持续受限；公网部署应使用长随机密码，并考虑在反向代理限制管理员入口的访问来源，不要仅依赖应用限流。

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

只有 `CONFIRMED` 才能为用户发货或充值，并需结合订单关闭、过期及业务自身的退款处理规则。`data.refund` 仅保留旧版退款登记状态（`NONE / PARTIAL / FULL`）；新的管理员退款标记不会改变它，也不会通过业务 API 或通知同步给网站。外部退款及对应的发货、权益回收由开发者自行处理。

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

注意通知的 `X-PerPay-Webhook-Timestamp` 使用 **Unix 毫秒**，与 API 请求签名的 Unix 秒不同。接收端应检查投递时间偏差、正文与请求头的事件 ID 一致性，并在数据库中按事件 ID 去重、按 `order_version` 防止乱序回退。

下面演示 Node.js Fetch 风格的核心验签与 ACK；它不是可直接用于生产的完整接收器。可运行、包含时间校验、持久化去重和订单版本检查的版本见 [调用端示例](examples/node-client/README.md)：

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

网络错误、`5xx`、`429` 或错误 ACK 会触发重试；`401`、`403` 等鉴权错误可能直接进入失败或死信。新事件为 `PAYMENT_CONFIRMED` 和 `PAYMENT_DISPUTED`；旧版已生成的 `REFUND_UPDATED` 仍保留原语义并按原流程投递、重试，客户端需要继续兼容。管理员标记／撤销退款不会生成事件或补发通知。客户端应根据 `schema` 分派并容忍未来增加的字段。

## 6. 后台提醒与退款标记

### 按分类全部忽略提醒

后台 **待处理** 的四个标签分别提供“全部忽略”，确认一次即覆盖该分类的**所有分页**：

| 标签 | 忽略范围 |
| --- | --- |
| 全部事项 | 账务异常、账本冲突和通知失败的全部未忽略提醒 |
| 账务异常 | 仅账务异常 |
| 账本冲突 | 仅账本冲突 |
| 通知失败 | 仅通知失败 |

忽略后，同一事项不再出现在“全部事项”、首页“需要你关注”，以及“账本与对账”的默认待处理异常／冲突列表中。它**只关闭提醒**：不删除证据、不修改订单或账务状态、不解决冲突，也不停止通知自动重试。运行状态与真实失败／待投递计数仍可能显示问题，不能把“没有提醒”理解为“系统运行正常”。

- 点击“查看已忽略”可查看原始详情，并逐条“恢复提醒”，不提供批量恢复。“账本与对账”也提供此入口；恢复后，未结束事项会重新出现在默认待处理列表中。冲突的“全部记录（含已忽略）”、已处理／已隔离列表与详情仍保留真实状态。
- 同一个通知投递记录继续失败或最终进入死信，仍保持忽略。新事项或人工重投递产生的新记录会按原规则提醒。
- 已解决的账务异常／冲突、已成功或被重投递记录替代的通知显示“已结束”，不能恢复为待处理问题。
- 普通支出流水继续保存、校验，但不参与自动收款匹配。历史 `UNMATCHED_DEBIT / UNLINKED_REFUND` 不再进入待处理、默认开放异常列表及开放异常计数；仍可按原记录编号追溯，其原始状态不会被伪造为“已解决”。真实流水冲突、验签与完整性问题不受影响。

管理接口（不是业务签名 API）：

| 接口 | 用途 |
| --- | --- |
| `GET /api/admin/v1/work-items?type=ALL&visibility=ACTIVE` | 查看未忽略提醒；`visibility=IGNORED` 查看已忽略；游标绑定分类和可见性 |
| `POST /api/admin/v1/work-items/actions/ignore-all` | 提交 `{ "operation_id": "UUID v4", "type": "ALL" }`；分类也可为 `FINANCIAL_EXCEPTION / LEDGER_CONFLICT / NOTIFICATION_FAILURE` |
| `POST /api/admin/v1/work-items/{type}/{resourceId}/actions/restore` | 提交操作 UUID，逐条恢复未结束事项的提醒 |

批量范围以请求进入数据库写事务时仍符合条件的事项为准；事务之后新增的事项不受影响。网络超时后复用同一个操作 UUID 和相同参数，会返回原结果，不会顺便忽略后来新增的事项。一次新的批量操作必须使用新的 UUID；复用 UUID 却改变分类或内容会返回 `409 / admin_operation_conflict`。批次成员、操作人、时间和审计记录会一并提交。

### 管理员退款标记

先在 PerPay 之外自行完成退款，再到 **订单详情 → 管理员退款标记 → 标记已退款**；误标时可以“撤销退款标记”。备注可选，最多 500 字，修改历史记录操作人、时间和备注。

> 仅记录管理员已在外部完成退款，PerPay 不执行转账，也未验证退款。

只有有实收金额的 `CONFIRMED / DISPUTED` 订单可以标记；未付款订单不能标记。撤销仅撤销这条管理员声明。标记与撤销都不修改付款状态、实收金额、历史退款状态、对外订单版本或记账分录，也不通知业务网站。标记和备注只在管理端订单列表与详情中返回，不出现在业务 API、公开收银台或通知中。

管理 API 为 `PUT /api/admin/v1/orders/{orderId}/refund-mark`，请求字段为 `operation_id`、独立标记 `version`、目标状态 `marked` 与可选 `note`。尚无标记时版本为 0；并发修改返回 `409 / refund_mark_version_conflict`，需要重新读取，不能静默覆盖。超时重试保留 UUID、版本和内容。

旧 `POST /api/admin/v1/reconciliation/refunds` 写接口已退役：通过鉴权和旧请求格式校验后返回 `410 / refund_recording_retired`。旧退款记录、部分／全额退款状态和已生成通知保留只读兼容，不自动转换成新标记。人工关联收入功能仍保留。

所有上述写接口均要求管理员会话、同源 JSON 和 CSRF 校验，不能使用业务 API 密钥替代。

## 7. 上线检查

- API 密钥和通知密钥只保存在网站服务端环境变量或密钥管理器。
- 生产环境使用 HTTPS，`notify_url` 必须位于管理 API 配置的允许来源下，不能依赖重定向。
- 创建订单遇到网络超时，使用相同幂等键重试，不要重复生成业务订单号。
- 通知和查询都可能重复或乱序，业务状态更新必须幂等并单向推进。
- 只有服务端查询或验签通知显示 `CONFIRMED` 时，才执行发货、充值或余额增加。

完整字段、错误码和接口契约见 [`openapi.yaml`](openapi.yaml)。
