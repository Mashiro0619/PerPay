<!-- SPDX-License-Identifier: MIT -->

# PerPay 使用与接口参考

本文档涵盖 PerPay 的工作机制、查账与冷却策略、原生支付 API 契约、回调通知规范及管理后台操作说明。

- 部署与基础配置：[快速部署](README.md#部署) · [支付宝配置指南](docs/alipay-setup.md)
- 易支付协议接入：[易支付 V1/V2 接入指南](docs/epay-integration.md)
- 原生 API 速览与示例：[原生 API 快速接入](docs/integration-quickstart.md) · [Node.js 示例](examples/node-client/README.md)
- 错误码与 Schema：[业务错误码与重试](docs/integration-errors.md) · [openapi.yaml](openapi.yaml)

---

## 工作机制与边界

PerPay 在服务端通过支付宝开放平台接口定时拉取账务明细，按 **收款账号 + 完整应付金额 + 付款时间** 自动匹配并确认订单，不依赖手机端监听工具。

- **应付金额分配**：创建订单时在商品原价基础上附加小额加价（例如原价 `10.00` 元分配应付金额 `10.03` 元），付款人须按完整应付金额支付。
- **异常处理**：金额不符、逾期付款、重复付款或无法唯一匹配的流水不会自动确认，均进入后台 **待处理 / 对账** 供人工核对。
- **状态分离**：订单收款状态（`payment.status`）与通知投递状态独立维护；业务端仅应以主动查单结果或验签通过的 `CONFIRMED` 通知作为履约依据。

---

## 1. 准备配置

常规初始化通过后台 `/admin/` 向导完成：创建管理员 → 配置支付宝账号与收款码 → 创建业务网站 → 在「接入与通知」获取密钥并配置来源域名。

### 界面显示与收银台

- **系统名称与图表样式**（系统设置 → 界面显示）：名称支持 1–40 字符（默认 `PerPay`），用于登录页与后台标题；图表样式全局生效。
- **单站展示设置**（网站设置 → 收银台展示）：可按网站独立配置收银台名称、商品名称显隐开关（不影响 API 与回调字段）及 HTTPS 帮助链接；修改后已有收银台外观同步更新，金额、有效期与收款码保持不变。
- **返回商家按钮**：订单传入合法 `return_url` 后，收款确认态显示「返回商家」，关闭/过期/争议态显示「返回商家处理」，由付款人主动点击跳转（待付款状态不自动跳转）。

<a id="收银台结束后查询期"></a>

- **结束后可查询时长**（系统设置 → 高级设置，`checkout_terminal_observation_seconds`）：默认 `86400` 秒（24 小时），决定收银台关闭或过期后公开链接仍可查询状态的时长，不影响付款截止时间与后台对账。

### 通过管理 API 初始化（可选）

管理写接口均需管理员会话、JSON 正文、同源及 CSRF 校验，完整定义见 [openapi.yaml](openapi.yaml)：

1. **创建管理员并登录**：`POST /api/admin/v1/setup`（`PERPAY_SETUP_TOKEN_ENABLED=true` 时须附带启动日志 `administrator_setup_required` 中的 `setup_token`）→ `POST /api/admin/v1/session/login`。
2. **配置支付宝账号与密钥**：`POST /api/admin/v1/alipay-accounts` → `POST .../application-key` 生成密钥 → `PUT .../alipay-accounts/:accountId` 保存配置与收款码 → `POST .../check` 测试连接。已上线账号换钥采用三步切换：`POST .../application-key/regenerate` → 上传公钥至支付宝 → `POST .../application-key/activate`（查账验签通过后生效；取消使用 `POST .../discard`）。
3. **创建网站与凭据**：`GET /api/admin/v1/settings/site-defaults` → `POST /api/admin/v1/sites` → `POST /api/admin/v1/sites/:clientId/secrets/api_secret/actions/rotate`、`POST /api/admin/v1/sites/:clientId/secrets/webhook_secret/actions/rotate`（查看使用 `POST /api/admin/v1/sites/:clientId/secrets/webhook_secret/actions/view`）→ `PUT /api/admin/v1/sites/:clientId` 开启通知并配置 `notification_origin` / `return_origin`。

当前最新数据库结构版本（schema）为 51，升级与回滚规则见 [维护、升级与恢复](docs/maintenance.md#固定版本与回滚)。

---

<a id="账本采集节奏"></a>

## 查账节奏

在 **系统设置 → 查账设置**（管理接口 `PUT /api/admin/v1/settings/collection-policy`）配置查账策略，各账号独立计时，保存后立即生效：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| 常规间隔（`scan_interval_seconds`） | `60` 秒 | 无待付款订单且已过订单收尾期时的查账间隔 |
| 活跃间隔（`active_scan_interval_seconds`） | `8` 秒 | 存在开放中未付款订单，或刚结束未付款订单仍处于收尾期时的查账间隔 |
| 最小间隔（`minimum_scan_interval_seconds`） | `8` 秒 | 收银台「查询付款状态」触发提前查账时须满足的最小间隔（后台「手动查账」不受此限） |
| 查账延迟（`safety_lag_seconds`） | — | 暂缓采集最近数秒流水，等待支付宝账单数据稳定 |
| 成功有效时限（`maximum_success_age_seconds`） | `120` 秒 | 超过此时限未完成有效正常查账（或持续报错）时，暂停该账号接收新订单 |

- 三个间隔参数取值范围均为 `5–3600` 秒，须满足 `最小间隔 ≤ 活跃间隔 ≤ 常规间隔`；成功有效时限不得小于常规间隔的 2 倍。
- 订单过期或关闭时若仍未付款，自动维持 `max(60 秒, 查账延迟 + 活跃间隔)` 的收尾期，确保覆盖临近截止时间的付款。
- 更换某账号 App ID 前，须等待该账号旧未付款订单完成收尾复核查账。

### 金额复用冷却与付款截止

在 **网站设置 → 订单设置** 中配置 `amount_reuse_cooldown_seconds`（默认 `600` 秒，范围 `60–3600` 秒）：

- **作用**：订单结束后，该订单占用的完整应付金额（如 `10.03` 元）在冷却期内不会分配给新订单，以降低迟付错配风险。
- **计算方式**：主动关闭自关闭时间起算，自然过期自到期时间起算；已付款订单不提前释放；换码或重启不清空；冷却状态按**支付宝收款账号**共享。
- **并发容量**：冷却时长决定同标价的持续接单上限。例如存在 99 个可用加价槽位、收银台有效期 5 分钟、冷却 10 分钟时，同标价持续峰值约为 `99 ÷ (5 + 10) ≈ 6.6` 单/分钟。槽位耗尽时返回 `503 / amount_slots_exhausted` 及 `Retry-After`。
- **截止时间边界**：截止时间前完成的付款即使稍晚被查账拉取仍可自动确认；过期或关闭后才发生的付款进入异常处理（冷却期不构成付款宽限期）。

### 管理员登录限流

- 连续 5 次密码错误触发短暂锁定（同 IPv6 `/64` 共享计数，仅采信已配置的可信代理 IP）。
- 未登录认证接口共享全局令牌桶（最大突发 10 次，每 5 秒补充 1 次，跨重启持久），超限返回 `429 / auth_rate_limited`。

---

## 2. 请求签名

所有原生业务接口 `/api/v1/*` 使用 **HMAC-SHA256** 签名认证：将网站 API 密钥从 base64url 解码为 32 字节，对以下 8 行 UTF-8 文本（LF 分隔，末尾无换行）计算 HMAC-SHA256，输出 64 位小写十六进制：

```text
PERPAY-HMAC-SHA256
v1
大写 HTTP 方法
规范化 origin-form 路径与查询串
Unix 秒时间戳
32 字节随机 base64url nonce
当前网站的客户端 ID
原始请求体的小写 SHA-256
```

请求头要求：

| 请求头 | 值 |
| --- | --- |
| `X-PerPay-Client-Id` | 当前网站客户端 ID（更换后同步更新） |
| `X-PerPay-Timestamp` | Unix **秒**时间戳（允许 ±300 秒偏差） |
| `X-PerPay-Nonce` | 每次全新生成的 32 字节无填充 base64url（43 字符） |
| `X-PerPay-Signature-Version` | `v1` |
| `X-PerPay-Signature` | 64 位小写十六进制 HMAC |

`GET` 及关闭订单 `POST` 必须发送零字节空正文，其 SHA-256 固定为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。每次重试均须更换新 `nonce` 并重新签名，重复 `nonce` 返回 `409 / api_nonce_replayed`。

### 请求目标规范化规则

1. 仅包含路径与查询串（不含协议、主机名与 `#fragment`），以单个 `/` 开头，长度上限 8192 字节；非 ASCII 字符须为 NFC 规范化的 UTF-8 百分号编码。
2. 路径中不得包含空段、`.`、`..` 或百分号编码的 `/`；除根路径外不得以 `/` 结尾。
3. 百分号编码须先按 UTF-8 解码校验（拒绝非法编码、控制字符与非 NFC），再按路径/查询字符集重编码；十六进制使用大写，非保留字符 `A-Z a-z 0-9 - . _ ~` 须还原为原字符。
4. 查询参数每项为 `name=value`（名称非空、不重复、最多 128 项），按编码后的名称字典序升序排列并以 `&` 连接；空格编码为 `%20`，字面量 `+` 编码为 `%2B`；无查询参数时省略 `?`。
5. 多语言实现请对照 [签名测试向量](docs/signature-vectors.md) 核验；Node.js 可参考 [perpay.mjs](examples/node-client/perpay.mjs)。

---

## 3. 创建订单

`POST /api/v1/orders`（JSON，上限 16 KiB）。首次创建返回 `201`，相同参数重复提交返回 `200` 与原订单；包含未定义字段时拒绝请求。

```json
{
  "idempotency_key": "shop-SHOP-1001",
  "merchant_order_no": "SHOP-1001",
  "amount_cents": 1000,
  "product_name": "商品名称",
  "note": "可选的商户备注",
  "notify_url": "https://shop.example.com/webhooks/perpay",
  "return_url": "https://shop.example.com/orders/result"
}
```

### 请求字段

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `idempotency_key` | 是 | 1–256 UTF-8 字节，无首尾空白与控制字符；同单重试保持不变 |
| `merchant_order_no` | 是 | 1–64 位 ASCII（字母/数字开头，可含 `._-`），单站内唯一 |
| `amount_cents` | 是 | `1–9,999,999,998` 整数分（`1000` = `10.00` 元） |
| `product_name` | 是 | 去除首尾空白后 1–200 字符，不含控制字符 |
| `note` | 否 | 最多 500 字符，空白或 `null` 存为 `null` |
| `notify_url` | 否 | ≤4096 字节完整 HTTPS 地址，须开启本站通知且匹配 `notification_origin` |
| `return_url` | 否 | ≤4096 字节完整 HTTPS 地址，须匹配 `return_origin` |

### 响应字段与状态

响应主体位于 `data`：

- **标识与版本**：`order_id`（PerPay UUID）、`merchant_order_no`、`version`（用于防止旧状态覆盖新状态）。
- **金额字段**（单位均为整数分，币种 `CNY`）：
  - `requested_amount_cents`：下单原价（业务端商品金额核对依据）
  - `payable_amount_cents`：含小额加价的应付金额（付款人实际支付金额）
  - `received_amount_cents`：收款确认后的实收金额（未确认时为 `null`）
- **收银台（`checkout`）**：`status`（`OPEN` / `EXPIRED` / `CLOSED`）、`checkout_url`、`state_url`、`token`、`expires_at`、`closed_at`。仅 `OPEN` 且 `UNPAID` 时引导付款人进入 `checkout_url`。
- **付款状态（`payment`）**：`status`（`UNPAID` / `CONFIRMED` / `DISPUTED`）与 `basis`（`NONE` / `INFERRED` 自动推断 / `MANUAL` 人工确认）。

<a id="幂等与结果未知时恢复"></a>

> **超时与幂等恢复**：下单超时或结果不确定时，先按原 `merchant_order_no` 查单；确认未创建再以原单号、原 `idempotency_key` 与原载荷重新签名提交。若旧收银台已结束且未付款，重新发起支付应使用新的商户单号与 `idempotency_key`。详见 [业务错误码与重试](docs/integration-errors.md)。

---

## 4. 查询订单

以下接口均使用相同 HMAC 认证、零字节空正文，并按网站隔离（跨站返回 `404`）：

| 接口 | 用途 |
| --- | --- |
| `GET /api/v1/orders/{order_id}` | 按 PerPay 内部订单 ID 查询订单 |
| `GET /api/v1/orders/by-merchant-no/{merchant_order_no}` | 按商户订单号查询订单（用于下单超时恢复） |
| `POST /api/v1/orders/{order_id}/actions/close` | 关闭开放中的收银台（空正文，不传 `{}`；不影响迟到流水处理） |
| `GET /api/v1/events/{event_id}` | 查询历史通知事件发生时的订单快照 |
| `GET /api/v1/system/status` | 查询本站接单就绪状态（`status: ready/not_ready`、`site_id`、`client_id`） |

---

## 5. 回调通知

PerPay 向订单的 `notify_url` 发送带签名的 `POST` JSON 请求。回调可能出现重复、延迟或乱序，接收端须实现验签、幂等去重与版本校验。

### 签名头与验签

请求头：`X-PerPay-Webhook-Version`（`1`）、`X-PerPay-Webhook-Key-Id`、`X-PerPay-Webhook-Timestamp`（Unix **毫秒**）、`X-PerPay-Webhook-Delivery-Id`、`X-PerPay-Webhook-Event-Id`、`X-PerPay-Webhook-Attempt`、`X-PerPay-Webhook-Signature`（`v1=<64位小写hex>`）。

将通知密钥从 base64url 解码，对以下 7 行文本（LF 连接，末尾无换行）计算 HMAC-SHA256，并与签名做恒定时间比对（必须使用未经改动的原始请求体计算 SHA-256）：

```text
perpay:webhook:v1
key-id
Unix 毫秒时间戳
delivery-id
event-id
attempt
原始通知正文的小写 SHA-256
```

### 事件载荷示例（`perpay:outbox-event:v2`）

当前事件类型为 `PAYMENT_CONFIRMED` 与 `PAYMENT_DISPUTED`（历史 `REFUND_UPDATED` 继续兼容，新的退款标记不发送通知；解析时应忽略未知扩展字段）：

```json
{
  "schema": "perpay:outbox-event:v2",
  "event_id": "11111111-1111-4111-8111-111111111111",
  "event_type": "PAYMENT_CONFIRMED",
  "financial_operation_id": "55555555-5555-4555-8555-555555555555",
  "order_id": "22222222-2222-4222-8222-222222222222",
  "merchant_order_no": "SHOP-1001",
  "product_name": "商品名称",
  "note": null,
  "requested_amount_cents": 1000,
  "payable_amount_cents": 1003,
  "received_amount_cents": 1003,
  "currency": "CNY",
  "payment_status": "CONFIRMED",
  "payment_basis": "INFERRED",
  "refund_status": "NONE",
  "event_details": {
    "payment_match_id": "44444444-4444-4444-8444-444444444444",
    "ledger_entry_id": "66666666-6666-4666-8666-666666666666"
  },
  "order_version": 2,
  "occurred_at": 1794394320000
}
```

`occurred_at` 为 PerPay 记录该事件的 Unix 毫秒时间戳，并非支付宝交易时间。

<a id="持久化与-ack"></a>

### 持久化与 ACK 回执

在同一数据库事务内完成「订单核对 → `event_id` 去重 → `order_version` 单调更新 → 对 `CONFIRMED` 创建唯一履约任务」，事务提交后返回 **HTTP `200`**、`Content-Type: application/json` 及 4 字段 JSON 回执：

```json
{
  "schema": "perpay:webhook-ack:v1",
  "ack": true,
  "event_id": "11111111-1111-4111-8111-111111111111",
  "delivery_id": "33333333-3333-4333-8333-333333333333"
}
```

### 重试策略与后台重发

| 接收端响应 | PerPay 处理 |
| --- | --- |
| 合规的 `200` + 4 字段原生 ACK（或易支付 `2xx` + `success`） | 标记为「通知已确认」 |
| 网络/TLS 错误、`201–204`、`3xx`、`5xx`、`401/403/404/408/409/419/422/425/429` 或 `200` 但 ACK 无效 | 按网站策略退避重试（不跟随重定向，重试仍校验 TLS） |
| `410`、目标地址违规、不支持的响应压缩等永久错误 | 停止自动重试并记录失败 |

重试次数与退避间隔在网站设置中调整；自动重试停止后，可在后台对最新已结束投递任务点击 **重新发送**（生成新 `delivery_id`，`event_id` 保持不变）。易支付订单若撤销原收款确认，对应旧成功通知立即终止且禁止重发。

---

## 6. 后台操作与外观

### 支付宝流水与人工对账

- **流水查询**：进入 **全局管理 → 对账 → 支付宝流水**，默认筛选收入流水，可切换「支出 / 全部收支」，支持按账号、处理状态、交易日期（北京时间）与精确金额筛选；详情页展示多源核对凭据与关联订单。来源异常的记录归入 **账本冲突**。
- **人工关联与争议处理**：
  - 未付款订单可人工关联一笔未占用的收入流水（原因可选）；争议订单重新确认须填写核对理由。
  - 同一支付宝账号下的一笔付款最多确认一张订单；若关联错误，先撤销原关联再重新关联。
  - 更换账号 App ID 后，同一支付宝环境下新应用采集的流水仍可人工关联至旧订单。

### 待处理提醒与批量忽略

- **待处理**汇总三类事项：**账务异常**、**账本冲突**与**通知失败**（普通支出流水不再生成收入异常提醒）。
- 支持勾选或按分类执行 **全部忽略**（覆盖当前筛选下的全部分页）。忽略仅隐藏提醒，不删除原始记录、不修改订单状态、不停止通知重试；可在「已忽略」中恢复尚未完结的提醒。

### 管理员退款标记

- 在支付宝完成实际退款后，可在 **订单详情 → 更多 → 标记已退款** 登记备注（支持撤销）。
- 仅对存在实收金额的 `CONFIRMED` / `DISPUTED` 订单可用；该标记仅作后台声明，不修改收款状态、不递增业务订单版本、不发送业务通知。

<a id="外观"></a>

### 外观、安全与订单导出

- **主题切换**：顶栏右上角（移动端位于「页面操作」菜单）可切换 **浅色 / 深色 / 跟随系统**，偏好保存于浏览器并跨标签页同步，后台与公开收银台共享。
- **密码与会话**：修改管理员密码须校验旧密码，提交后注销全部登录会话；可在 **登录会话 → 更多** 一键注销全部会话。编辑页面支持离开未保存提醒与配置版本冲突检测。
- **订单 CSV 导出**：导出当前筛选条件下最多 **10,000 条、时间跨度 ≤ 366 天** 的订单明细（UTF-8 BOM 编码并做公式注入防护，不含密钥、订单备注与收银台令牌）。

### 相关管理接口与公开核实接口

完整请求与响应 Schema 见 [openapi.yaml](openapi.yaml)：

| 接口 | 用途 |
| --- | --- |
| `GET /api/admin/v1/ledger/entries[/:id]` | 查询支付宝流水列表与详情（`occurred_from/to`、`min/max_amount_cents`） |
| `POST /api/admin/v1/reconciliation/settlements/manual` | 人工关联流水与订单（幂等键 `financial_operation_id`） |
| `PUT /api/admin/v1/orders/{orderId}/refund-mark` | 标记或撤销外部退款声明（须传 `operation_id`、`version`） |
| `GET /api/admin/v1/work-items`、`POST .../actions/ignore-all`、`POST .../{type}/{id}/actions/restore` | 查询、按分类忽略与恢复待处理提醒 |
| `POST /api/admin/v1/orders/export` | 导出订单 CSV（`created_from/to` 必填） |
| `POST /api/public/v1/checkouts/{token}/check` | 公开收银台同源手动申请核实（返回 `202` 排队 / `200` 无需等待 / `429` 限流 / `503` 不可用；付款结果仍以 `payment.status` 为准） |

旧退款记账接口 `POST /api/admin/v1/reconciliation/refunds` 已下线，返回 `410 / refund_recording_retired`。

---

## 7. 上线检查清单

正式对外收款前，建议逐项核对：

- API 密钥、通知签名密钥与易支付商户私钥仅保存在业务后端，不暴露给前端。
- 公网 HTTPS 回调路由能够读取未经修改的原始请求体与全部签名头。
- 业务端正确区分下单原价、应付金额与实收金额，仅按原价核对商品价格。
- 下单超时时先按原商户订单号查单，重试不会产生重复订单。
- 回调处理按「验签 → 事务内去重与 `order_version` 校验 → 提交后回复 ACK」执行，重复或乱序通知不会重复履约。
- 已配置并验证 [自动备份与主密钥异地保存](docs/maintenance.md#启用与验证备份)。
