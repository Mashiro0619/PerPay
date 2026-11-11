<!-- SPDX-License-Identifier: MIT -->

# PerPay 使用方法

本文是 PerPay 的配置、原生 API、通知和管理操作参考。首次接入按[快速指南](docs/integration-quickstart.md)完成流程；使用现成支付插件时阅读[易支付接入](docs/epay-integration.md)。

| 需要做什么 | 文档 |
| --- | --- |
| 配置支付宝账号 | [支付宝接入](docs/alipay-setup.md) |
| 管理多个网站与账号分配 | [多业务网站接入](docs/multi-site.md) |
| 跑通下单与通知 | [Node.js 调用端示例](examples/node-client/README.md) |
| 核对签名或排查请求 | [签名向量](docs/signature-vectors.md)、[错误码与重试](docs/integration-errors.md) |
| 查看接口字段、类型和响应格式 | [OpenAPI](openapi.yaml) |
| 备份、升级和恢复 | [维护指南](docs/maintenance.md) |

## 收款方式与适用范围

PerPay 在服务器上持续查询支付宝账单，根据收款账号、金额和付款时间匹配订单，无需手机监听软件。付款人可以使用收款码，也可以向订单对应的支付宝账号转账；实际金额必须与收银台一致，入账流水须能被该账号配置的开放平台应用查询。经营码是可选形式。

静态收款码通过金额和时间推断订单归属，不提供支付宝官方的逐单支付凭证。错付金额、迟付、重复付款或无法唯一匹配的流水需要人工核查。PerPay 分别记录收款状态和通知是否送达。业务后端根据主动查单结果或已验证签名的通知中的付款状态，决定是否发货、充值或开通服务。

### 查看支付宝流水

从“全局管理 → 对账 → 支付宝流水”（`/admin/reconciliation`）查看各账号已查到并整理完成的流水记录。默认显示全部日期的收入流水，可按账号、关键词、收支方向、处理状态、北京时间交易日期和金额筛选；查看支出时，将“收支方向”切换为“支出”或“全部收支”。界面金额以元填写、最多两位小数，管理 API 使用整数分。

点击流水可查看不同应用配置查到的记录、收款关联和订单。同一笔流水被不同来源重复查到时合并展示；内容不一致，或同时关联了多个订单时，显示异常。撤销关联后仍可查看历史。格式错误、无法整理为正常流水的记录从“账本冲突”查看。刷新页面会读取本地保存的流水，并显示最近查账时间。

管理接口为 `GET /api/admin/v1/ledger/entries` 和 `GET /api/admin/v1/ledger/entries/:ledgerEntryId`，需管理员登录。日期参数为 `occurred_from/occurred_to`，金额参数为 `min_amount_cents/max_amount_cents`；默认每页 20 条，最多 100 条，更换筛选后重新分页。

## 1. 准备配置

打开 `/admin` 创建管理员，按配置向导接入支付宝账号、收款码和业务网站。在网站的“接入与通知”中取得客户端 ID 和所选协议的凭据。API 密钥、通知密钥和商户私钥都保存在业务后端的环境变量或密钥管理器。

原生 API 与通知密钥按网站独立生成。已有密钥可直接查看和使用，重新进入向导无需轮换。通知可在接收端准备完成后启用；未使用通知的网站由后端主动查单。管理员测试收款会创建真实订单，但不会自动生成或启用业务 API 密钥。

通过管理 API 配置时，按以下顺序操作。写请求需携带已登录的管理员会话，使用 JSON 正文，并通过同源和 CSRF 校验：

1. `POST /api/admin/v1/setup` 提交 `password` 创建管理员，再用 `POST /api/admin/v1/session/login` 登录。启用 `PERPAY_SETUP_TOKEN_ENABLED=true` 时，还需提交最近一次启动日志 `administrator_setup_required` 事件中的 `setup_token`；Docker 部署可用 `docker compose logs --tail=100 app` 查看。初始化令牌默认关闭，启用时随未初始化服务重启而更新，管理员创建后失效。
2. `POST /api/admin/v1/alipay-accounts` 创建账号，再用 `POST /api/admin/v1/alipay-accounts/:accountId/application-key` 生成应用密钥，最后通过 `PUT /api/admin/v1/alipay-accounts/:accountId` 保存应用和收款码。`POST /api/admin/v1/alipay-accounts/:accountId/check` 检查已保存配置。创建时可携带 UUID v4 `operation_id`；相同编号和内容返回原账号，内容不同返回 `409 / alipay_account_creation_conflict`，原账号已删除返回 `404`。省略编号会创建新账号。
3. `POST /api/admin/v1/sites` 提交 UUID `operation_id`、完整 `configuration` 和可选 `client_id`。先用 `GET /api/admin/v1/settings/site-defaults` 取得策略模板；`configuration.collection` 指定账号和分配方式，初始通知关闭。创建结果中的 `client_id` 是管理路径使用的稳定网站编号，`api_client_id` 是业务认证使用的当前客户端 ID。占用冲突返回 `409 / site_client_id_conflict`，字段错误在 `error.fields.client_id`。重试保持原操作编号、客户端 ID 和配置。
4. `POST /api/admin/v1/sites/:clientId/secrets/api_secret/actions/rotate` 生成网站 API 密钥；通知密钥使用 `POST /api/admin/v1/sites/:clientId/secrets/webhook_secret/actions/rotate`。每次提交最新网站 `revision`，后一次操作使用前次响应的版本。已有通知密钥可通过 `POST /api/admin/v1/sites/:clientId/secrets/webhook_secret/actions/view` 和正文 `{}` 查看。
5. `PUT /api/admin/v1/sites/:clientId` 提交最新 `revision` 与完整 `configuration`。启用通知时设置 `notifications_enabled: true` 和精确的 `notification_origin`，如 `https://shop.example.com`。需要浏览器返回链接时，另外配置 `return_origin`。
6. 创建业务订单时，`notify_url` 填完整回调地址，如 `https://shop.example.com/webhooks/perpay`。地址如何填写、暂停网站或修改配置后如何处理旧订单，见[多网站指南](docs/multi-site.md)。

### 界面显示

“系统设置 → 界面显示”中的支付系统名称用于后台、登录页和无法定位网站时的公开页面。长度为 1–40 个字符，默认 PerPay，保存时去掉首尾空白。各网站的收银台名称、商品名开关和帮助链接在网站设置中分别配置。

图表样式用于整套后台。修改网站的展示设置也会更新旧收银台的外观；订单金额、有效期和收款码仍使用创建时的记录。商品名开关控制页面是否显示商品名，API 与通知始终包含该字段。

帮助链接接受 HTTPS 公网域名地址，配置后在收银台底部显示“商家帮助”，留空可清除。它与付款通知和返回地址分别配置。

已配置合法 `return_url` 的订单，在确认收款后显示“返回商家”；关闭、过期、争议及仍有订单信息的暂不可用页面显示“返回商家处理”。付款人点击后返回，待付款时不自动跳转。原生订单打开原返回地址；易支付订单在当前已确认付款时附加签名成功参数，规则见[易支付通知与返回](docs/epay-integration.md#付款通知与返回)。

<a id="收银台结束后查询期"></a>

### 结束后可查询时长

“系统设置 → 高级设置”的“结束后可查询时长（秒）”控制收银台结束后公开链接继续提供状态的时长，默认 86400 秒。字段为 `checkout_terminal_observation_seconds`，在创建订单时保存，修改只影响新订单。

这个期限控制公开链接的有效性。它不延长付款截止时间；到期后订单、后台记录、迟到账单查账和人工处理继续保留。

### 应用公钥变更

首次生成应用密钥使用 `POST /api/admin/v1/alipay-accounts/:accountId/application-key`，提交账号 `revision`；已有密钥不会被替换。更换已接入应用的密钥时：

1. `POST /api/admin/v1/alipay-accounts/:accountId/application-key/regenerate` 提交当前 `revision`、`base_fingerprint` 和新 UUID `change_id`。系统保存待启用密钥，同一请求重试保持原正文。尚未首次接入时，该操作直接替换初始密钥对。
2. 把响应中 `pending_application_key.public_key` 上传到同一个支付宝应用。`application_public_key` 仍表示 PerPay 当前使用的公钥。
3. `POST /api/admin/v1/alipay-accounts/:accountId/application-key/activate` 提交最新 `revision`、待启用 `change_id`，以及上传后从同一应用重新获取的 `platform_public_key`。此公钥必填。PerPay 使用待启用私钥查询账单并验签，成功才切换密钥和递增配置版本，失败保留当前密钥；历史订单来源关联不变。
4. 放弃变更使用 `POST /api/admin/v1/alipay-accounts/:accountId/application-key/discard`，提交最新 `revision` 和 `change_id`。如果已向支付宝上传新公钥，应先在那里恢复当前应用公钥，并将恢复后取得的支付宝公钥同步回 PerPay。

待启用密钥跨刷新和重启保存，生成、启用和放弃均有审计。存在待启用变更时，先完成或放弃，再切换应用。

当前最新数据库结构版本（schema）为 44，哪些版本可以升级、如何回退，见[固定版本与回滚](docs/maintenance.md#固定版本与回滚)。

<a id="账本采集节奏"></a>

## 查账节奏

在“系统设置 → 查账设置”配置以下间隔，决定 PerPay 多久查一次账，各账号独立执行：

| 设置 | 新配置默认值 | 使用时机 |
| --- | --- | --- |
| 常规间隔 `scan_interval_seconds` | 60 秒 | 没有有效待付款订单，且收尾期已结束。 |
| 活跃间隔 `active_scan_interval_seconds` | 8 秒 | 有未过期的 `OPEN / UNPAID` 订单，或未付款订单仍在收尾期。 |
| 最小间隔 `minimum_scan_interval_seconds` | 8 秒 | 手动核实可提前申请下一轮，但须等待上一轮完成后的最小间隔。 |

三个间隔均为 5–3600 秒的整数，满足 **最小间隔 ≤ 活跃间隔 ≤ 常规间隔**。查账成功有效时限 `maximum_success_age_seconds` 至少是常规间隔的两倍，新配置默认 120 秒；查账延迟 `safety_lag_seconds` 不超过该有效时限。

查账延迟用于等待支付宝记录稳定，每轮只查询指定秒数之前的流水。最近应查的时间段已经查完后，可以一边补查更早的流水，一边继续接单。最近的流水还没查完、查账出错，或上次正常查账成功记录已超过有效时限时，该账号暂停接新单。

订单关闭或过期后，仍未支付的订单保留 `max(60 秒, 查账延迟 + 活跃间隔)` 的收尾期。收尾期结束后继续常规查账和历史补扫；已确认到账的订单无需收尾。

更换账号 App ID 前，已结束的未付款订单须完成最后复核：正常查账覆盖到付款截止或主动关闭时刻，并完成此轮后的对账。例如查账延迟 10 秒，到期后 1 秒的查账还未覆盖最后约 9 秒，需要继续等待。

保存间隔后无需重启，原有最小等待、限流和失败后的重试等待继续生效。间隔从上一轮完成计算到下一轮开始。例如活跃 8 秒、最小 5 秒时，完成后第 4 秒请求核实，最早第 5 秒启动。同账号的网站请求会合并。实际确认收款还需要等待支付宝提供流水，并加上查账延迟和请求耗时，不能直接用查账间隔估算。

管理接口 `PUT /api/admin/v1/settings/collection-policy` 提交全局设置的 `revision` 和完整策略：`timeout_milliseconds`、`scan_interval_seconds`、`active_scan_interval_seconds`、`minimum_scan_interval_seconds`、`safety_lag_seconds`、`maximum_success_age_seconds`。日志中的 `scan_mode`（`normal/active/tail`）和 `scan_interval_milliseconds` 可用于核对当前采用的查账频率。

升级会保留已有查账频率，以及数据库中保存的查账进度和等待记录。较早版本首次增加活跃间隔、最小间隔时，分别沿用当时的常规间隔、活跃间隔，保持原有查账频率。

### 金额复用冷却与付款截止

在“网站设置 → 订单设置”配置 `amount_reuse_cooldown_seconds`，决定上笔订单结束后，同一应付金额要等多久才能再次分配。默认 600 秒，范围 60–3600 秒。订单创建时保存自己的等待时间，之后修改设置也会按原值处理这笔订单。

- 主动关闭从关闭时刻计算冷却，自然过期从原定到期时刻计算；后台处理较晚不会重新计时。已付款订单也不会提前释放金额。
- 分配时从小到大选择可用应付金额，已经展示的金额保持不变。金额占用按收款账号共享，换码或重启不会清空冷却。
- 截止前实际付款、稍后才查到账单的订单仍可自动确认。关闭或过期后才付款的流水进入异常处理，冷却不是补付宽限期。
- 冷却用于降低迟付串单概率。金额再次分配后发生的极晚付款仍可能混淆，需结合付款证据核查。

可分配的应付金额全部被占用时，返回 `503 / amount_slots_exhausted` 和 `Retry-After`。业务后端按该间隔有限重试，保留业务参数和幂等键，每次重新签名；下单请求不会在 PerPay 自动排队。

冷却越长，同一标价的持续接单容量越小。例如假设有 99 种可用应付金额，有效期 5 分钟、冷却 10 分钟，则理想持续容量约为 `99 ÷ 15 = 6.6` 单／分钟。不同标价可分配到的金额也可能重叠。

### 管理员登录限流

同一 IPv6 `/64` 网段共享失败计数，IPv4-mapped IPv6 与对应 IPv4 合并计数。连续失败五次后，需要等待一段时间才能再次尝试；未受信任的 `X-Forwarded-For` 不能改变用于限流的来源地址。

整套服务还共同限制未登录用户的密码验证次数：最多可连续尝试 10 次，每 5 秒补回一次额度。记录保存在数据库，登录成功或重启服务都不会清零。额度不足返回 `429 / auth_rate_limited` 和 `Retry-After`；已登录后的操作不消耗这部分额度。对公网开放管理员入口时，可同时使用长随机密码和反向代理来源限制。

## 2. 请求签名

原生业务接口使用 HMAC-SHA256。将网站 API 密钥从 base64url 解码为 32 字节；对以下八行 UTF-8 文本计算 HMAC，行间使用 LF，末尾没有换行，输出小写十六进制：

```text
PERPAY-HMAC-SHA256
v1
大写 HTTP 方法
规范化 origin-form 路径和查询字符串
Unix 秒时间戳
32 字节随机 base64url nonce
当前网站的客户端 ID
原始请求体的小写 SHA-256
```

对应请求头：

| 请求头 | 值 |
| --- | --- |
| `X-PerPay-Client-Id` | 当前用于业务接入的客户端 ID；更换 ID 后同步更新。 |
| `X-PerPay-Timestamp` | 当前 Unix 秒时间戳，允许前后 300 秒偏差。 |
| `X-PerPay-Nonce` | 每次请求新生成的 32 字节随机值，以无填充 base64url 表示，共 43 个字符。 |
| `X-PerPay-Signature-Version` | `v1`。 |
| `X-PerPay-Signature` | 64 位小写十六进制 HMAC。 |

签名和发送使用同一份原始正文。JSON 请求带 `Content-Type: application/json`；GET 和关闭订单 POST 使用零字节正文，摘要为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。

### 请求目标规范化

签名目标仅包含路径和查询字符串，不含域名，例如 `/api/v1/orders`。规则如下：

- 目标以单个 `/` 开始，最多 8192 字节，不含片段 `#...`；非 ASCII 字符使用 NFC 形式的 UTF-8 百分号编码。
- 路径不含空段、`.`、`..` 或编码后的路径分隔符；除根路径外，不以 `/` 结尾。ASCII 保留字符按允许的原字符形式表示，不接受其百分号编码形式。
- 百分号编码先按 UTF-8 解码，拒绝无效编码、控制字符和非 NFC 文本，再按对应路径／查询字符集编码。十六进制使用大写，无需编码的字符还原，例如 `%41` 还原为 `A`。
- 查询项写成 `name=value`，名称非空，每项只有一个字面量 `=`；最多 128 项，规范化后的名称不能重复。名称和值仅直接使用非保留字符 `A-Z a-z 0-9 - . _ ~`，其余字符百分号编码。
- 查询参数按编码后的名称排序，再用 `&` 连接。空格使用 `%20`，字面量 `+` 使用 `%2B`，不使用表单式 `+` 空格编码；无查询时省略 `?`。

固定向量包含中文路径、查询排序和正文转义，可用来核对实现：[签名测试向量](docs/signature-vectors.md)。Node.js 接入可复用[示例客户端](examples/node-client/perpay.mjs)；它提供固定 ASCII 路径的下单和查询，扩展通用客户端时需实现上述完整规则。

服务端在处理业务前就将 nonce 记为已使用。每次重试都使用新 nonce、当前时间戳和新签名，业务单号、幂等键和请求参数保持不变。认证失败返回 `401 / api_authentication_failed`，nonce 重复返回 `409 / api_nonce_replayed`。

## 3. 创建订单

调用 `POST /api/v1/orders`，正文为 JSON，最多 16 KiB。首次创建返回 `201`，重复提交相同请求返回原订单和 `200`。响应位于 `data`，`Location` 指向订单查询路径。

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

| 字段 | 规则 |
| --- | --- |
| `idempotency_key` | 必填，1–256 个 UTF-8 字节，无首尾空白和控制字符。同一业务订单重试保持不变。 |
| `merchant_order_no` | 必填，1–64 个 ASCII 字符，以字母或数字开头，后续可含字母、数字、`.`、`_`、`-`。同一网站内唯一。 |
| `amount_cents` | 必填，1–9,999,999,998 的整数，单位人民币分；`1000` 为 10.00 元。 |
| `product_name` | 必填，去除首尾空白后 1–200 个 Unicode 字符，不含控制字符。 |
| `note` | 可选，最多 500 个 Unicode 字符，不含控制字符；去除首尾空白，空白内容或 `null` 保存为 `null`。 |
| `notify_url` | 可选，最多 4096 个 UTF-8 字节的完整 HTTPS 通知地址。须已启用本站通知并匹配 `notification_origin`。 |
| `return_url` | 可选，最多 4096 个 UTF-8 字节的完整 HTTPS 返回地址，匹配独立的 `return_origin`。 |

未知字段会被拒绝。API 凭据决定网站归属，请求不接受网站 ID 作为选择参数。

`notify_url` 用来接收 PerPay POST 发送的签名 JSON，`return_url` 由付款人浏览器打开。两个地址分别使用自己的来源配置；缺少对应来源时，新订单不能提交该 URL。修改返回来源不改变旧订单地址；修改通知来源后，再次发送旧订单通知时，会检查原地址是否仍符合当前设置。收银台帮助链接 `checkout_help_url` 在网站展示设置中配置。

### 响应字段与金额

| `data` 字段 | 含义 |
| --- | --- |
| `order_id`、`merchant_order_no` | PerPay UUID 订单 ID、原商户订单号。 |
| `requested_amount_cents` | 业务下单金额。 |
| `payable_amount_cents` | 分配后的准确应付金额，含识别尾数。 |
| `received_amount_cents` | 已记录实收金额，未记录时为 `null`。 |
| `currency` | `CNY`。 |
| `product_name`、`note`、`return_url` | 保存后的商品名、备注和返回地址。 |
| `checkout` | `status`、`token`、`checkout_url`、`state_url`、`expires_at`、`closed_at`。 |
| `payment` | `status`、`basis` 和 `received_amount_cents`。 |
| `refund.status` | 历史退款状态 `NONE/PARTIAL/FULL`。 |
| `notification.notify_url` | 订单通知地址，未设置时为 `null`。 |
| `created_at`、`updated_at` | ISO 8601 时间字符串。 |
| `version` | 订单版本，用于防止旧状态覆盖新状态。 |

业务后端保存响应中的订单 ID。只有 `checkout.status=OPEN` 且 `payment.status=UNPAID` 时，才引导付款人进入 `checkout.checkout_url`，可使用 `303` 跳转。收银台链接和令牌用于授权访问该笔订单，应仅交给相应付款人。

下单金额、应付金额和实收金额分别记录。例如下单 10.00 元，分配后应付 10.03 元，付款人须支付 10.03 元。接入端核对商品价格时使用下单金额，判断实际付款时结合付款状态和实收金额。

| `payment.status` | 含义与业务处理 |
| --- | --- |
| `UNPAID` | 尚未确认付款，保持等待或继续查单。 |
| `CONFIRMED` | 已自动匹配或人工确认，可按业务规则发货或充值，同一笔业务订单只处理一次。 |
| `DISPUTED` | 原付款关联已撤销，交给管理员核对。 |

`payment.basis` 为 `NONE/INFERRED/MANUAL`，分别表示无关联、自动推断、人工确认。收银台状态 `OPEN/EXPIRED/CLOSED` 与付款状态独立：截止前付款可能在收银台结束后才被发现。新的管理员退款标记只在后台记录外部退款声明，不改变 `refund.status`，也不发送业务通知；外部退款和权益回收由业务系统处理。

<a id="幂等与结果未知时恢复"></a>

### 重复请求与下单超时处理

发送前保存商户订单号、幂等键和完整参数。幂等键用来识别同一次下单，相同请求重试会返回同一订单。同一幂等键对应不同参数返回 `idempotency_conflict`，同一商户单号已经存在则返回 `merchant_order_no_conflict`。

网络超时、连接断开或服务端错误时，先按原商户单号查询。重试保持原请求，每次重新签名并遵守 `Retry-After`；不要用新单号掩盖未知结果。确认旧收银台结束且仍未付款后，新的付款尝试使用新单号和新幂等键，旧订单及其后续通知仍需保留。[错误处理详解](docs/integration-errors.md)

## 4. 查询订单

以下接口使用相同的网站 HMAC 认证，正文均为空：

| 方法与路径 | 返回 |
| --- | --- |
| `GET /api/v1/orders/{order_id}` | `data` 为完整订单。 |
| `GET /api/v1/orders/by-merchant-no/{merchant_order_no}` | 用商户订单号找回完整订单，适合下单结果未知的情况。 |
| `POST /api/v1/orders/{order_id}/actions/close` | 结束收银台并返回当前订单。 |
| `GET /api/v1/events/{event_id}` | 返回本站历史通知事件，以及事件发生时的订单数据。 |
| `GET /api/v1/system/status` | 返回本站当前是否能接新订单，以及原因。 |

订单和事件只在所属网站可见，不存在、格式无效或属于其他网站的资源返回 `404`。付款人返回业务网站后，后端主动查单，再更新页面并决定是否安排发货、充值等任务。

关闭接口对仍开放且未到期的收银台置为 `CLOSED`，已到期时置为 `EXPIRED`，已经结束时返回当前状态。关闭不修改付款状态；旧单查询和迟到流水处理继续进行。关闭请求是零字节正文，不发送 `{}`。

事件查询返回 `event_id`、`event_type`、`order_id`、`order_version`、`payload`、`payload_fingerprint` 和 ISO `created_at`。`payload` 保存事件发生时的订单数据；需要了解最新状态时，调用订单查询接口。

状态接口返回 `status=ready/not_ready`、`code`、稳定网站编号 `site_id`、当前客户端 ID `client_id`、`accepting_orders` 和 `notifications_enabled`。HTTP `200` 仍可能表示 `not_ready`；能否创建订单以实际下单响应为准。

## 5. 回调通知

PerPay 向订单的 `notify_url` POST 签名 JSON。通知可能重复、延迟或乱序。业务后端应记录已经处理的事件、检查订单版本，并防止同一笔业务订单重复发货或充值。

### 通知签名

| 请求头 | 内容 |
| --- | --- |
| `X-PerPay-Webhook-Version` | `1`。 |
| `X-PerPay-Webhook-Key-Id` | 本次使用的通知密钥 UUID。 |
| `X-PerPay-Webhook-Timestamp` | 本次发送的 Unix **毫秒**时间戳。 |
| `X-PerPay-Webhook-Delivery-Id` | 通知发送任务的 UUID。 |
| `X-PerPay-Webhook-Event-Id` | 事件 UUID，与正文 `event_id` 一致。 |
| `X-PerPay-Webhook-Attempt` | 当前发送任务的尝试次数，从 1 开始。 |
| `X-PerPay-Webhook-Signature` | `v1=` 加 64 位小写十六进制 HMAC。 |

将通知密钥从 base64url 解码，对以下七行 UTF-8 文本计算 HMAC-SHA256，行间 LF、末尾无换行：

```text
perpay:webhook:v1
key-id
Unix 毫秒时间戳
delivery-id
event-id
attempt
原始通知正文的小写 SHA-256
```

接收端先读取原始正文，检查头部格式、发送时间与本机时间的偏差，并验证签名，然后再解析 JSON。按 key-id 从自己保存的密钥配置中选取密钥，使用恒定时间比较签名，并核对头部与正文事件 ID。不要对解析后的 JSON 重新序列化来验签。

示例接收端允许发送时间与本机时间相差不超过五分钟，限制正文大小，并在数据库事务中保存结果。实现方式见 [verifyWebhook](examples/node-client/perpay.mjs) 与 [HTTP 接收器](examples/node-client/server.mjs)，更换密钥时的配置见[示例说明](examples/node-client/README.md#通知密钥轮换与可重试错误)。

### 事件正文

当前事件格式为 `perpay:outbox-event:v2`，付款确认示例：

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

| 字段 | 含义 |
| --- | --- |
| `schema`、`event_id`、`event_type` | 格式版本、去重标识、事件类型。 |
| `financial_operation_id` | 产生事件的财务操作编号。 |
| `order_id`、`merchant_order_no` | PerPay 订单 ID 和业务网站原单号。 |
| `product_name`、`note` | 创建订单时保存的商品名和备注。 |
| 三个 `*_amount_cents`、`currency` | 该事件时的下单、应付、实收金额及币种。 |
| `payment_status`、`payment_basis`、`refund_status` | 该事件时的收款状态、确认方式和历史退款状态。 |
| `event_details` | 随事件类型变化的收款操作证据。 |
| `order_version` | 该事件对应的订单版本。 |
| `occurred_at` | 事件发生时的 Unix 毫秒时间，不是支付宝交易时间或本次发送时间。 |

新事件包括 `PAYMENT_CONFIRMED` 和 `PAYMENT_DISPUTED`。历史 `REFUND_UPDATED` 仍会按原流程发送和重试，客户端继续兼容；管理员标记或撤销外部退款不会生成新通知。根据 `schema` 识别格式版本并读取所需字段，同时允许通知将来增加字段。

<a id="持久化与-ack"></a>

### 保存通知并回复成功

接收端在同一个数据库事务中核对本站订单、金额和币种，用 `event_id` 识别重复事件，再按 `order_version` 更新订单数据。付款状态为 `CONFIRMED` 时，才为该业务订单创建唯一的发货或充值任务。旧版本不得覆盖新版本，同一版本内容冲突时交给管理员核对。事务提交成功后才回复成功回执（ACK）。后台任务完成实际发货或充值，并保存执行进度，以便失败后继续。

原生 ACK 必须满足：HTTP `200`、`Content-Type: application/json`（可带 `charset=utf-8`）、未压缩或 `Content-Encoding: identity`，正文只能包含以下四个字段：

```json
{
  "schema": "perpay:webhook-ack:v1",
  "ack": true,
  "event_id": "11111111-1111-4111-8111-111111111111",
  "delivery_id": "33333333-3333-4333-8333-333333333333"
}
```

ID 取自本次已验签请求。自动重试保持事件编号和发送任务编号（`delivery_id`），尝试次数递增；人工重发会创建新的发送任务编号，事件编号保持不变。重复事件也要验签，并用本次 `delivery_id` 回执。`204` 和纯文本 `success` 不是原生 ACK；易支付使用自身的文本 ACK。

### 重试与人工重发

| 结果 | PerPay 处理 |
| --- | --- |
| 符合上述要求的原生 `200` ACK | 标记已送达。 |
| 网络、TLS 错误，HTTP `201–204`、`3xx`、`5xx` | 按配置等待后重试；重试仍校验证书，不跟随重定向。 |
| HTTP `401/403/404/408/409/419/422/425/429` | 按配置等待后重试。 |
| HTTP `200`，ACK 缺失、格式错误或 ID 不匹配 | 按配置等待后重试。 |
| HTTP `410`、目标地址策略违规、不支持的响应压缩等永久错误 | 终止自动尝试，保留失败记录。 |

其他未列入重试范围的响应会终止当前发送任务。网站的 `maximum_attempts` 限制总尝试次数，`timeout_milliseconds` 控制单次请求超时。重试间隔从 `retry_base_seconds` 开始逐次增加，并加入随机变化，最长受 `retry_maximum_seconds` 限制。达到次数上限后停止自动重试，管理员查明原因并修复后，可重新发送。

后台为最新且已结束的发送任务提供“重新发送”；正在自动重试，或已有后续重发任务的旧记录，不提供该操作。重发原生通知时，仍发送原事件发生时的订单数据，接收端继续检查事件编号和订单版本。易支付原付款确认已撤销时，对应成功通知停止发送，新的重发请求返回 `409 / webhook_payment_confirmation_revoked`。重新确认付款会创建新的事件和通知。

## 6. 后台操作与外观

### 在订单页查看与处理收款

订单详情展示收款流水、确认方式、人工关联理由和最新通知结果。“匹配依据”可查看时间窗口，“技术详情”可查看原始字段、编号和指纹，记录旁的“单独打开”用于定位完整证据。

- 未付款订单可以人工关联收入，理由可选；争议订单重新确认时必须填写核对理由。
- 重新确认产生新的关联、收款事件和通知，保留原关联及撤销历史。已被其他订单占用的流水、已有退款记录的订单不能重新确认。
- 原流水属于其他订单时，先撤销原关联，再关联正确订单。使用另一笔流水确认后，原流水仍未归属的会继续显示为待处理收入。
- 收款状态、异常处理和通知回执分别查看。候选流水不等于已经收款，HTTP 成功也不等于收到有效 ACK。
- 已忽略或已处理的异常可在“异常历史”中查看。忽略提醒后，相关记录和订单状态继续保留。

### 按分类全部忽略提醒

“待处理”的每个分类提供“全部忽略”，作用于当前网站、分类和关键词范围内的所有分页：

| 分类 | 范围 |
| --- | --- |
| 全部提醒 | 全部未忽略的账务异常、账本冲突和通知失败。 |
| 账务异常 | 仅账务异常。 |
| 账本冲突 | 仅账本冲突。 |
| 通知失败 | 仅通知失败。 |

忽略后，记录从默认待处理列表和首页提醒隐藏。同一通知发送任务继续失败时，仍保持忽略；新提醒和人工重发产生的新记录正常提示。忽略提醒会保留相关记录和账务状态，通知重试也会继续。

切换到“已忽略”可逐条恢复尚未结束的提醒。已解决的异常、发送成功或已有后续重发任务的通知显示“已结束”，不能恢复。运行状态中的 `work_items` 统计所有未忽略的提醒，不受列表分页或关键词筛选影响。网站页面只统计能确定属于本站的记录，无法确定所属网站的冲突在全局页面查看。

普通支出流水继续保存和校验，不参与收款自动确认。历史 `UNMATCHED_DEBIT/UNLINKED_REFUND` 仍可按编号追溯，但不再作为待处理收入提醒；流水冲突、验签和完整性问题继续提示。

| 管理接口 | 用法 |
| --- | --- |
| `GET /api/admin/v1/work-items?type=ALL&visibility=ACTIVE` | 读取未忽略提醒；`visibility=IGNORED` 读取已忽略记录。 |
| `POST /api/admin/v1/work-items/actions/ignore-all` | 提交 `operation_id`、`type` 和当前筛选。分类可为 `ALL/FINANCIAL_EXCEPTION/LEDGER_CONFLICT/NOTIFICATION_FAILURE`。 |
| `POST /api/admin/v1/work-items/{type}/{resourceId}/actions/restore` | 提交操作 UUID，逐条恢复。 |

PerPay 在执行操作的数据库事务中确定本次要忽略哪些提醒，之后新增的提醒留待下次处理。超时重试保留同一 UUID 和参数，会返回原结果；新一批操作使用新 UUID。复用 UUID 却修改内容返回 `409 / admin_operation_conflict`。系统会记录本次处理的范围、操作人和时间。

### 管理员退款标记

先在 PerPay 之外完成退款，再从“订单详情 → 更多 → 标记已退款”记录；误标时可撤销。备注可选、最多 500 字，历史保存操作人、时间和备注。该标记是管理员对外部退款的声明，PerPay 不执行退款转账。

有实收金额的 `CONFIRMED/DISPUTED` 订单可标记，未付款订单不可标记。标记及撤销使用独立版本，只在管理端列表和详情显示；付款状态、实收金额、历史 `refund.status`、业务订单版本和记账分录保持原值，也不向业务网站发送通知。

管理接口 `PUT /api/admin/v1/orders/{orderId}/refund-mark` 提交 `operation_id`、标记 `version`、目标状态 `marked` 和可选 `note`。首次版本为 0；并发冲突返回 `409 / refund_mark_version_conflict`，重新读取后再操作。超时重试保留 UUID、版本和内容。

旧 `POST /api/admin/v1/reconciliation/refunds` 在通过认证和旧格式校验后返回 `410 / refund_recording_retired`。旧退款记录、部分／全额退款状态和既有通知继续保留，不自动转换成新标记。

人工关联收入使用 `POST /api/admin/v1/reconciliation/settlements/manual`。未付款订单的 `reason` 可省略、为 `null` 或空白，统一保存为 `null`；争议订单重新确认必须填写理由。重试保持原 `financial_operation_id` 和内容，更换理由或关联对象使用新操作编号。

同一收款账号更换 App ID 后，管理员仍可将新应用查到的流水关联到旧订单，前提是两者使用同一支付宝环境。管理员需核对付款人、金额和时间；系统还会检查币种、收入方向，以及这笔付款是否已经被使用。自动确认继续按订单原来的应用配置匹配流水。

同一收款账号、同一环境的一笔支付宝付款，最多确认一个订单。不同应用配置查到的重复记录都会保存，已经使用的付款不能再确认另一订单。需要修改归属时，先撤销原关联，再用新操作编号建立关联；两个操作都会保存操作记录和事件。

以上写接口需携带管理员会话，使用 JSON 正文，并通过同源和 CSRF 校验。涉及多个网站的订单或流水时，在全局对账页面处理，具体规则见[多网站指南](docs/multi-site.md#管理接口的网站范围)。

### 外观

后台侧栏“外观”提供经典蓝、青竹、暖砂、柔紫和石墨配色，每种均支持浅色、深色或跟随系统。选择后立即生效；点击外部、关闭按钮或 Escape 收起，手机先打开导航菜单。

偏好保存在当前浏览器，并同步到同源标签页。登录和初始化页面共用该外观，公开收银台按网站展示配置显示。

### 设置与安全

普通设置在所属分组保存，校验失败会定位字段并保留草稿；离开未保存表单时可选择继续编辑或放弃。配置向导可以保存默认值并继续。

管理员安全在系统设置中管理；支付宝应用密钥在账号内管理，网站 API／通知密钥在各网站“接入与通知”管理。密钥查看弹窗关闭或离开编辑页后清除明文。

更换 API 密钥后，旧密钥立即失效。更换通知密钥后，后续发送使用新密钥，已经发出的请求可能仍使用旧签名；接收端应及时更新配置，按需要短暂接受新旧两把通知密钥。更换结果未知时，先刷新并查看当前版本，避免重复操作。已结束的发送任务不会因更换密钥自动重发。

退出登录和撤销会话需要服务端确认。离线时操作不会提交，恢复连接后重新操作。修改密码需输入两次，以“修改并重新登录”提交；“登录会话”的“更多”可注销全部会话。

## 7. 上线检查

上线前确认以下接入行为：

- 凭据保存在业务后端，公网 HTTPS 回调接收到原始正文和签名头。
- 创建、查询和浏览器返回显示同一业务订单，并区分下单金额、应付金额和实收金额。
- 下单响应丢失时能按原商户单号找回订单，重试不会创建第二笔。
- 通知保存到数据库后才回复成功；重复或乱序通知不会造成重复发货、充值，也不会让旧状态覆盖新状态。
- 主动查单结果或已验签通知显示 `CONFIRMED` 后，才发货或开通服务；争议、外部退款和旧单迟到通知有明确处理方式。
- 接收端暂时不可用后，能从通知发送记录定位原因并完成重试或人工重发。

完整字段与状态见 [OpenAPI](openapi.yaml)，部署和备份验收见[维护指南](docs/maintenance.md)。

## 管理查询与订单导出

概览确认金额按 PerPay 确认事件的发生日期和当次实收金额统计。撤销后重新确认会在新日期增加一次确认，原日期记录保留；确认次数包含自动和人工确认，不等于当前已确认订单数，也不是支付宝账单合计。

订单与通知列表按创建日期筛选，使用北京时间；通知日期指发送任务的创建日期。管理 GET 接口可传成对的 `created_from/created_to`（`YYYY-MM-DD`），包含起止两天。更改网站、账号、日期或其他筛选后重新分页。

列表中的 PerPay 确认时间取最近一次 `PAYMENT_CONFIRMED` 事件，争议订单仍保留此历史时间；支付宝实际交易时间在对应流水中查看。

“导出 CSV”导出当前网站、账号、关键词、状态、日期和排序条件下的全部订单，最多 10,000 条、日期跨度最多 366 天，超限时缩小范围。管理接口为 `POST /api/admin/v1/orders/export`：

| 字段 | 要求 |
| --- | --- |
| `created_from`、`created_to` | 必填，起止创建日期。 |
| `api_client_id` | 可选，稳定网站编号；网站路径中由路径确定。 |
| `alipay_account_id` | 可选，收款账号编号。 |
| `q` | 可选，订单关键词。 |
| `payment_status`、`checkout_status` | 可选，收款和收银台状态。 |
| `sort_by`、`sort_order` | 可选，排序字段与 `asc/desc`。 |

导出使用管理员会话、同源和 CSRF 校验。CSV 包含网站、收款账号、商户与内部订单号、商品、三类金额、币种、当前状态和创建／确认时间。金额保留两位小数，未实收为空；文件采用 UTF-8 BOM、CSV 转义和公式注入防护。备注、通知正文、密钥和收银台令牌不导出。

文件中的所有行使用同一时刻的数据，适合核对订单明细。统计到账情况时应同时查看流水和收款确认记录，通知是否送达则看发送记录。

界面中的请求和通知超时以秒输入，通知支持 0.001 秒精度，例如 5.123 秒保存为 5123 毫秒。备份间隔可按秒、小时或天显示，API 沿用对应毫秒／秒字段。查账“采用推荐值”只更新草稿，保存后生效；备份执行与恢复检查见[启用与验证备份](docs/maintenance.md#启用与验证备份)。

### 收银台手动核实接口

公开收银台 GET 读取当前状态。收银台可同源 POST `/api/public/v1/checkouts/{token}/check`，携带有效令牌和 JSON `{}`，申请一次核实：

| HTTP | 含义 |
| --- | --- |
| `202` | 正在等待或执行，按 `Retry-After` 等待。 |
| `200` | 无需继续等待或本轮已结束，读取订单和核实状态。 |
| `429` | 来源限流，稍后重试。 |
| `503` | 当前不可用，检查服务状态。 |

后续 GET 可返回 `verification.state`：`WAITING/SCANNING/RECONCILING/COMPLETED/FAILED`。核实进度属于该笔订单，服务重启后可失效；收款结果仍以 `payment.status` 为准，核实完成不等于付款成功。只读演示服务不接受核实操作。
