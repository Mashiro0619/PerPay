<!-- SPDX-License-Identifier: MIT -->

# PerPay 使用方法

本文面向需要把网站接入 PerPay 的开发者。多站配置边界、生命周期和接口索引见[多业务网站指南](docs/multi-site.md)。所有 API 密钥和通知签名密钥（下文简称通知密钥）只能保存在网站后端，不能放进浏览器 JavaScript、移动端安装包或公开仓库。

首次接入可先阅读[快速接入指南](docs/integration-quickstart.md)，按签名、下单、跳转、收通知、验签和履约的顺序完成接入。

排查调用问题时参阅[签名测试向量](docs/signature-vectors.md)和[业务错误码与重试建议](docs/integration-errors.md)。

## 收款方式与适用范围

PerPay 不用在手机上运行监听软件，服务器需持续运行。可以使用支付宝收款码，经营码只是可选形式；也可向订单对应的支付宝账号转账。付款金额须与订单一致，入账流水须能被该账号所配置的开放平台应用查询。后台和收银台仍以二维码展示收款信息。

**怎么判断归属：** PerPay 定时从支付宝拉取账单，这个过程称为采集（查账），下文统一称“查账”。系统按金额和付款时间推断流水属于哪个订单；管理员也可核对后人工关联。

**局限是什么：** 静态收款码不提供支付宝官方逐单支付凭证。错付金额、迟到付款和重复付款需要人工核查。收款确认与通知送达分别判断，业务系统须查单或验签通知后再履约。

### 查看支付宝流水

管理员可从“全局管理 → 支付宝流水”（`/admin/ledger`）查看各支付宝账号和环境下已采集并规范化的记录。默认查询全部日期，可按收款账号、关键词、收支方向、PerPay 处理状态、北京时间交易日期和金额区间筛选。交易金额按元输入，最多两位小数；管理 API 使用整数分。切换业务网站不改变流水范围。

点击流水查看来源版本及关联凭据，点击关联订单进入订单详情；返回时保留原筛选和分页。相同流水跨来源重复采集只展示一次；内容差异及多个生效关联显示异常，撤销关联保留历史。无规范化记录的采集异常可从“账本冲突”查看。刷新只读取本地账本，页面显示最近查账时间，不代表支付宝全部历史或实时到账。

只读管理接口为 `GET /api/admin/v1/ledger/entries` 和 `GET /api/admin/v1/ledger/entries/:ledgerEntryId`，要求管理员登录。日期参数为 `occurred_from/occurred_to`，金额为 `min_amount_cents/max_amount_cents`，默认每页 20 条、最多 100 条；更换筛选应清除原分页游标。完整契约见 [openapi.yaml](openapi.yaml)。

## 1. 准备配置

首次配置见 [图文教程](docs/alipay-setup.md)，创建订单与回调通知接入可试用 [调用端 Demo](examples/node-client/README.md)。

先访问 `/admin` 初始化管理员并登录，再按三步完成收款配置：

1. 打开“系统设置 → 支付宝账号”，新增账号并保存收款码、App ID 和支付宝公钥；在同一页面生成应用密钥或导入已有私钥，把应用公钥上传到对应支付宝应用，点击“保存并检查”。检查失败仍保留保存内容，可修正后重试。
2. 创建业务网站并选择收款账号：指定一个、多个等概率随机或按权重分配。只有一个可用账号时自动预选；多个账号时需明确选择。网站策略采用默认模板，API／通知密钥需在网站设置中另行生成。
3. 等待所选账号查账和自动确认收款就绪，在该网站下试收款并核对实际收款账号。通知和备份在各自设置中配置，备份仍需验证恢复。

**PerPay API 密钥由 PerPay 生成并保管，只用于业务系统调用 PerPay。** 将该网站的客户端 ID 和密钥保存到业务系统后端的 PerPay 接入配置，用于签名请求；PerPay 使用同一密钥验签。客户端 ID 也由 PerPay 生成，升级保留的旧业务网站仍为 `default`。已有密钥可继续使用，重新进入向导无需轮换。

向导完成后，业务 API 仍须通过签名鉴权。未生成密钥时，管理员可在收款就绪后创建真实测试订单；此操作不会自动生成或启用 API 密钥。

**能做什么：** 启用通知时填写业务网站的 HTTPS Origin；跳过通知则由业务后端主动查单。管理员可创建真实小额测试订单：全局后台需要选择业务网站，本站后台固定当前网站，顶部切换器可切换范围。

**哪些事还需确认：** 测试收款不是模拟支付，也不是完成配置的必选项。保存备份策略后仍需验证恢复，并同时保管主密钥卷。

也可直接调用以下管理 API：

1. 从当前服务启动日志的 `administrator_setup_required` 事件读取 `setup_token`（Docker 部署执行 `docker compose logs --tail=100 app`），通过 `POST /api/admin/v1/setup` 在 JSON 正文中同时提交 `setup_token` 和 `password`。令牌只在本次未初始化的进程中有效，管理员创建成功后失效，重启未初始化服务会换新令牌。初始化不会创建会话，再通过 `POST /api/admin/v1/session/login` 提交密码登录；不要把令牌写进 URL 或保存到业务网站配置。
2. 使用 `POST /api/admin/v1/alipay-accounts` 新增账号，在 `POST /api/admin/v1/alipay-accounts/:accountId/application-key` 生成应用密钥，再用 `PUT /api/admin/v1/alipay-accounts/:accountId` 保存应用与收款码。`POST .../:accountId/check` 检查已保存内容。应用私钥按账号加密保存，网站 API 密钥仍通过各网站的密钥接口生成。
3. 使用 `POST /api/admin/v1/sites` 创建网站，提交 UUID `operation_id` 和完整 `configuration`，初始 `notifications_enabled` 为 `false`，`configuration.collection` 指定收款账号与分配方式。可先通过 `GET /api/admin/v1/settings/site-defaults` 取得策略模板；客户端 ID 由服务端生成，不能自行指定。
4. 在该网站下调用 `POST /api/admin/v1/sites/:clientId/secrets/api_secret/actions/rotate` 生成 API 密钥；需要通知时，再调用 `POST /api/admin/v1/sites/:clientId/secrets/webhook_secret/actions/rotate` 生成通知密钥。每次携带最新的网站 `revision`，后一次操作使用前一次响应中的版本。密钥只保存到对应网站后端的环境变量或密钥管理器；已有通知密钥可通过 `POST /api/admin/v1/sites/:clientId/secrets/webhook_secret/actions/view` 显式查看，无需轮换。
5. 使用 `PUT /api/admin/v1/sites/:clientId` 提交最新 `revision` 与完整 `configuration`，设置 `notifications_enabled: true` 和精确 `notification_origin`，例如 `https://shop.example.com`（只填写来源，不填写路径）。需要返回链接时另行填写 `return_origin`；二者相互独立。全局通知写接口已退役，不再代表某个默认网站。
6. 创建订单时，将 `notify_url` 填成已允许通知来源下的完整地址，例如 `https://shop.example.com/webhooks/perpay`。完整配置字段及并发控制见[多业务网站指南](docs/multi-site.md#管理接口与查询)。

### 界面显示

在 **系统设置 → 界面显示** 中，可修改支付系统名称（1–40 个字符，默认 PerPay，保存时去掉首尾空白），用于后台、登录页及无法定位网站时的公开页面。每站收银台名称在“业务网站 → 收银台展示”配置，不随后台名称变化。名称为公开信息，不应填写密码或其他秘密；不修改 API 路径、Cookie、签名标识、订单数据和项目文档链接。保存后当前后台立即更新，其他已打开页面刷新后显示新名称。

首页面积图、柱状图或折线图为实例外观；收银台商品名称开关和帮助链接在各网站分别设置。展示变更可影响已有收银台，不改写财务快照、收款码历史关联或统计口径。

商品名称开关只控制收银台显示，不修改订单 API 和通知内容，也不作为数据保密开关。

商家帮助链接为可选项，配置后在收银台底部显示小字“商家帮助”，未配置则不显示入口，仅接受 HTTPS 公网域名链接，不由服务器访问。留空并保存可清除；返回商家不代表付款成功，业务系统仍应查单或验签通知。

订单配置合法 `return_url` 后，收款确认显示“返回商家”；关闭、过期、争议及保留订单信息的暂不可用页面显示“返回商家处理”。正常待付款不显示返回按钮，无订单数据时不猜测返回地址。返回操作不追加成功参数，也不会自动跳转。

<a id="收银台结束后查询期"></a>

### 结束后可查询时长

在 **系统设置 → 高级设置** 中，“结束后可查询时长（秒）”控制收银台结束后公开链接继续提供状态查询的时长，默认 86400 秒。它不延长付款截止时间，也不控制后台迟到账单的查账、确认或人工处理期限；到期只使公开链接失效，不删除订单或后台记录。

对应 API 字段仍为 `checkout_terminal_observation_seconds`。该值在创建订单时保存，修改设置仅影响新订单，不重写已有订单的查询期限。

### 应用公钥变更

首次生成接口为 `POST /api/admin/v1/alipay-accounts/:accountId/application-key`，提交当前账号的 `revision`；已有密钥不会被此操作替换。明确更换时使用以下管理员接口（均要求管理员会话、同源与 CSRF 校验）：

1. `POST /api/admin/v1/alipay-accounts/:accountId/application-key/regenerate`：提交当前 `revision`、当前 `base_fingerprint` 和新的 UUID `change_id`。首次接入前替换原密钥对；已经接入时只生成加密保存的待启用密钥。重复请求必须保留同一请求体，不会生成另一把密钥。
2. 从配置响应的 `pending_application_key.public_key` 取得待启用应用公钥，并上传到同一个支付宝应用。`application_public_key` 始终表示 PerPay 当前使用的公钥。
3. `POST /api/admin/v1/alipay-accounts/:accountId/application-key/activate`：提交最新 `revision`、待启用 `change_id`，以及上传新应用公钥后从同一支付宝应用重新获取的 `platform_public_key`（必填，不允许省略或留空，也不会沿用已保存的旧公钥）。服务端使用待启用私钥做一次有超时上限的只读账单查询并验签，成功后才原子切换密钥；失败不更换当前密钥。该账号的配置版本会在成功启用时递增，内部查账来源代次和历史业务关联不变。
4. 不再更换时，可调用 `POST /api/admin/v1/alipay-accounts/:accountId/application-key/discard`，提交最新 `revision` 与 `change_id`。这不会撤回支付宝侧的上传；若已上传新公钥，应先在支付宝恢复当前应用公钥，并在 PerPay 的支付宝设置中同步恢复后获取的支付宝公钥。

待启用密钥不会因刷新或重启丢失；生成、启用和放弃都有审计记录，私钥不出现在这些响应中。存在待启用变更时不能切换支付宝应用或再生成另一把公钥。数据库迁移 28 增加密钥变更表，不改写原密钥、配置或业务数据；当前最新 schema 为 37（多账号改动尚未发布，部署前请核对目标构建；v0.3.2 镜像最高支持 33）：迁移 29 将 API 客户端身份与凭证分离，30 增加自定义支付系统名称，31 增加可选商家帮助链接，32 增加默认关闭的管理员 IP 白名单，33 增加最小查账间隔与持久化调度保护，34 将网站策略和业务密钥无损迁移到独立网站模型，35 增加只读流水归组与证据查询索引，36 增加管理员会话的登录 IP 与设备信息并保留旧会话，37 将支付宝配置迁为独立账号并按账号隔离金额空间。升级与回滚请按[维护与恢复](docs/maintenance.md#固定版本与回滚)核对构建兼容范围，并保留数据库备份和主密钥。

<a id="账本采集节奏"></a>

## 查账节奏

在 **系统设置 → 查账设置** 中配置三个间隔，与支付宝应用配置独立保存；这些是 PerPay 自定义策略，不是支付宝官方参数：

| 设置 | 新配置默认值 | 使用时机 |
| --- | --- | --- |
| 常规查账间隔（`scan_interval_seconds`） | 60 秒 | 没有有效待支付订单，且收尾期已结束。 |
| 活跃查账间隔（`active_scan_interval_seconds`） | 8 秒 | 当前共享查账来源仍有未过期的 `OPEN / UNPAID` 订单，或有尚在收尾期的未支付订单。 |
| 查账最小间隔（`minimum_scan_interval_seconds`） | 8 秒 | 收银台手动核实可以提前请求下一轮，但不得早于上一轮完成后的最小等待时间。 |

三个间隔均为 5～3600 秒的整数，必须满足 **最小间隔 ≤ 活跃间隔 ≤ 常规间隔**：

- 最小查账间隔不能大于活跃查账间隔。
- 活跃查账间隔不能大于常规查账间隔；两者相同时保持固定基础频率。
- 查账有效时限至少要是常规查账间隔的两倍，新配置默认 120 秒。
- 查账延迟不能超过查账有效时限。

查账延迟用于等待支付宝记录稳定，只查询 N 秒前的账单。超过查账有效时限仍未成功查账时，所有业务网站暂停新订单，未付款收银台暂不可用。保存后热更新，无须重启；已有最小等待、限流和失败退避继续生效。

订单关闭或过期后，仍未支付的订单会保留 `max(60 秒, 查账延迟 + 活跃间隔)` 的自动收尾期，以减少临近结束付款的发现延迟；已确认到账的订单不再需要收尾。所有订单共享同一个查账任务，重启后从数据库重新判断当前模式。收尾期结束不代表停止查账，常规查账与既有补扫仍会处理迟到流水。

**升级不会自动改变已有查账频率：** 从 0.3.2 升级保留三个间隔及持久化调度保护；更早的迁移分别用原常规值初始化活跃间隔、用原活跃值初始化最小间隔，不自动提高请求频率。1.0.0 使用 `PUT /api/admin/v1/settings/collection-policy`，须提交当前实例 `revision` 和完整策略：`timeout_milliseconds`、`scan_interval_seconds`、`active_scan_interval_seconds`、`minimum_scan_interval_seconds`、`safety_lag_seconds`、`maximum_success_age_seconds`。不再通过支付宝接入接口提交查账字段；缺失字段或约束冲突明确报错，不静默调整其他间隔。

间隔按上一轮完成到下一轮开始计算，不是分页请求之间的间隔或到账确认时限。活跃 8 秒、最小 5 秒时，完成后第 4 秒点击核实，最早第 5 秒启动；完成后再按活跃间隔等待 8 秒。已有查账任务时复用，多个网站的核实请求合并；最小间隔不抢占补采、分页续采或覆盖限流和失败退避。5 秒查账仍受查账延迟、支付宝流水可见时间与请求耗时影响，新订单不会绕过冷却。查账日志中的 `scan_mode`（`normal / active / tail`）和 `scan_interval_milliseconds` 可用于核对当前模式与基础间隔。

### 金额复用冷却与付款截止

在 **业务网站 → 选择网站 → 订单设置** 中直接配置“金额复用冷却（秒）”，默认 600 秒（10 分钟），范围 60～3600 秒。管理 API 字段为 `amount_reuse_cooldown_seconds`；网站配置按完整对象及网站版本保存，修改不追溯改变历史订单。

- 每笔订单在创建时固定其冷却参数。修改设置及升级 1.0.0 均保留已有快照，不重置历史结束时间、扩展付款窗口或重新确认历史付款。只有早期引入冷却字段的迁移对原本没有该字段的订单初始化 600 秒快照。
- 主动关闭从关闭时刻计算冷却，自然过期从原定到期时刻计算，不因后台较晚处理过期而重新开始计时。已到账订单也不会提前复用金额。
- 从小到大选择未占用且满足冷却条件的应付金额；已冷却的较小加价金额优先于从未使用过的较大加价金额。已展示的应付金额不会改变。换码或重启不会清空冷却。
- **冷却不是补付宽限期。** 在收银台有效期内实际付款、但较晚查账到流水，仍可正常自动确认；关闭或过期后才实际付款，不自动补认原订单，入账仍保留并按现有异常流程处理。
- 冷却与上面的查账收尾期是不同机制，不新增独立查账任务，也不以反复查询替代归属证据。

金额池不足时，下单返回 `503 / amount_slots_exhausted` 和 `Retry-After`。业务后端可按该间隔退避重试，保持请求体及幂等键不变，但每次重新生成时间戳、nonce 和签名；应设置业务侧最大等待时间，不无限重试。PerPay 不会自动把失败的下单请求排入后台队列。

冷却越长，同一标价的可用金额越少。例如有 99 种可用应付金额、5 分钟收银台有效期加 10 分钟冷却，在忽略其他开销的理想情况下，持续容量约为 6.6 单/分钟；不同标价的可能分配的金额也可能重叠。

**静态收款码仍只按金额和时间推断归属，不是订单级支付凭证。** 冷却只能降低迟付串单概率；金额再次使用后发生的极晚付款仍可能混淆，不能把 10 分钟冷却当成完全可靠的订单绑定。

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
客户端 ID（当前网站的不可变 ID）
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
const clientId = process.env.PERPAY_CLIENT_ID;
if (!clientId) throw new Error("请设置业务网站的客户端 ID");
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
  return_url: "https://shop.example.com/orders/result",
});

// 返回给浏览器，或由网站服务端直接 303 跳转。
return Response.redirect(order.checkout.checkout_url, 303);
```

三个链接用途独立，不能互相代替：

| 字段 | 用途 |
| --- | --- |
| `notify_url` | 订单可选的服务端通知接收地址。PerPay 向它 POST 签名 JSON，接收端验签、幂等处理并返回 ACK。 |
| `return_url` | 订单可选的浏览器返回页面。用户点击后打开，PerPay 不向它投递通知；返回不代表付款成功，业务网站仍须服务端查单或验签通知。 |
| `checkout_help_url` | 显示设置中的可选商家帮助页面，不参与收款确认或通知投递。 |

`notify_url` 与 `return_url` 分别按网站的 `notification_origin`、`return_origin` 校验，不互相回退。未配置相应 origin 时，拒绝携带该 URL 的新订单。修改返回 origin 不改变旧订单地址；通知 origin 修改后，旧目标须重新通过当前策略校验，不会自动改发到新地址。帮助链接不要求与这两个地址同域。

订单响应中的 `data.payment.status` 有以下值：

| 状态 | 含义 |
| --- | --- |
| `UNPAID` | 尚未付款或尚未查账到唯一流水。 |
| `CONFIRMED` | 已自动确认或已由管理员认领。 |
| `DISPUTED` | 已撤销付款关联，进入争议处理。 |

只有 `CONFIRMED` 才能为用户发货或充值，并需结合订单关闭、过期及业务自身的退款处理规则。`data.refund` 仅保留旧版退款登记状态（`NONE / PARTIAL / FULL`）；新的管理员退款标记不会改变它，也不会通过业务 API 或通知同步给网站。外部退款及对应的发货、权益回收由开发者自行处理。

## 4. 查询订单

使用同一套签名工具调用：

```text
GET /api/v1/orders/{order_id}
```

网站服务端应在用户从收银台返回业务网站后主动查询一次，并以 PerPay 服务端的最终状态为准。浏览器跳转结果不能直接视为支付成功。

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

通知字段的来源如下；这里的时间和状态均有明确主语：

| 字段 | 含义 | 来源 |
| --- | --- | --- |
| `schema` | 通知格式版本 | PerPay |
| `event_id`、`event_type` | 事件编号与事件类型 | PerPay |
| `order_id` | 内部订单编号 | PerPay |
| `merchant_order_no` | 创建订单时传入的商户订单号 | 业务网站 |
| `product_name`、`note` | 商品名称与订单备注 | 业务网站 |
| `payment_status`、`payment_basis` | PerPay 的收款状态与收款关联方式 | PerPay |
| `refund_status` | 历史退款状态 | PerPay |
| `order_version` | 对外订单版本 | PerPay |
| `occurred_at` | PerPay 事件时间，不是支付宝交易时间 | PerPay |

接收成功必须返回 HTTP `200`、`application/json`，响应体只能包含以下四个字段：

```json
{
  "schema": "perpay:webhook-ack:v1",
  "ack": true,
  "event_id": "evt_...",
  "delivery_id": "delivery_..."
}
```

网络和 TLS 证书错误、`201`–`204`、所有 `3xx`、`401`、`403`、`404`、`408`、`409`、`419`、`422`、`425`、`429`、`5xx`，以及 HTTP `200` 下的错误 ACK（不含不支持的压缩编码）都会按配置的退避策略重试。重试仍严格校验证书，不跟随重定向；只有符合上文要求的 HTTP `200` ACK 才算成功。`410` 表示接收端明确拒收，不再重试；来源策略违规（如 `target_address_forbidden`、`webhook_target_not_allowed`）仍是永久失败。达到尝试次数上限后进入死信，不能将自动重试理解为保证送达。

新事件为 `PAYMENT_CONFIRMED` 和 `PAYMENT_DISPUTED`；旧版已生成的 `REFUND_UPDATED` 仍保留原语义并按原流程投递、重试，客户端需要继续兼容。管理员标记／撤销退款不会生成事件或重新发送通知。客户端应根据 `schema` 分派并容忍未来增加的字段。

## 6. 后台操作与外观

### 在订单页查看与处理收款

订单详情直接展示收款流水、付款确认方式、人工关联的操作人和理由，以及最新通知结果。精确匹配窗口在“匹配依据”中展开；记录旁的“更多 → 单独打开”仍可定位或分享具体记录。

- 收款、异常、通知默认给出可读摘要；原始字段、内部编号和指纹放在“技术详情”。金额推断不是支付平台按商户订单号确认，可能匹配的记录也不等于订单当前已付款。
- 关联撤销只在实际撤销后展示“撤销时间”。人工关联可在当前页面执行，操作理由为可选项；金额不同时仍提示核对，不要求解释。已有订单及流水自动带入，确认前读取最新证据。撤销关联、退款标记和通知重新发送位于对应记录的“更多”中，其他操作的确认与理由规则不变。
- 已忽略和已处理异常归入可展开的“异常历史”。忽略只关闭提醒，不能据此认定原异常已解决。
- 通知的 HTTP 成功不等于业务已确认，需看 ACK 结果。只有最新且已结束的投递提供重新发送入口；正在自动重试或已有后续投递的旧记录不提供此操作。
- 未配置通知时仅显示简短说明；未付款且无历史标记的订单不显示退款入口。退款标记只记录外部已完成退款的管理员声明。


### 按分类全部忽略提醒

后台 **待处理** 的四个标签分别提供“全部忽略”，确认一次即覆盖当前网站筛选范围内该分类的**所有分页**：

| 标签 | 忽略范围 |
| --- | --- |
| 全部提醒 | 账务异常、账本冲突和通知失败的全部未忽略提醒 |
| 账务异常 | 仅账务异常 |
| 账本冲突 | 仅账本冲突 |
| 通知失败 | 仅通知失败 |

**忽略什么：** 当前分类、业务网站和关键词筛选下的全部提醒，覆盖所有分页。忽略后，它们从默认待处理列表和首页提醒中隐藏；同一通知投递后续继续失败也保持忽略。新提醒和人工重新发送产生的新记录仍按原规则提醒。

**不影响什么：** 只关闭提醒，不删除证据、不改变订单或账务状态、不解决冲突，也不停止通知自动重试。查账、自动确认收款、通知和备份的真实故障，以及实际待投递数量仍独立显示。没有提醒不能证明系统运行正常。

**怎么恢复：** 切换到“已忽略”后逐条恢复，无需重复确认，不提供批量恢复。未结束的提醒会重新出现；已解决的异常或冲突、成功或被后续投递替代的通知显示“已结束”，不能恢复。对账页的“查看已忽略”也进入同一列表。

运行状态的 `work_items` 与“全部提醒 → 待处理”采用同一全量口径，不受分页和搜索影响；筛选业务网站时只纳入能确定属于该站订单的提醒，未归属冲突保留在全局。原始冲突、异常、失败总数及接口 `status` 保留诊断含义，不随忽略而改写。统计读取失败显示不可用，不当作 0。

普通支出流水继续保存、校验，不参与自动确认收款。历史 `UNMATCHED_DEBIT / UNLINKED_REFUND` 不再进入待处理、默认开放异常列表及计数；仍可按编号追溯，原始状态保留。流水冲突、验签与完整性问题继续按原流程处理。

管理接口（不是业务签名 API）：

| 接口 | 用途 |
| --- | --- |
| `GET /api/admin/v1/work-items?type=ALL&visibility=ACTIVE` | 查看未忽略提醒；`visibility=IGNORED` 查看已忽略；游标绑定分类和可见性 |
| `POST /api/admin/v1/work-items/actions/ignore-all` | 提交 `{ "operation_id": "UUID v4", "type": "ALL" }`；分类也可为 `FINANCIAL_EXCEPTION / LEDGER_CONFLICT / NOTIFICATION_FAILURE` |
| `POST /api/admin/v1/work-items/{type}/{resourceId}/actions/restore` | 提交操作 UUID，逐条恢复尚未结束的提醒 |

批量范围以请求进入数据库写事务时仍符合条件的提醒为准；事务之后新增的提醒不受影响。网络超时后复用同一个操作 UUID 和相同参数，会返回原结果，不会顺便忽略后来新增的提醒。一次新的批量操作必须使用新的 UUID；复用 UUID 却改变分类或内容会返回 `409 / admin_operation_conflict`。批次成员、操作人、时间和审计记录会一并提交。

### 管理员退款标记

先在 PerPay 之外自行完成退款，再到 **订单详情 → 概览右上角“更多” → 标记已退款**；误标时可以“撤销退款标记”。备注可选，最多 500 字，修改历史记录操作人、时间和备注。

> 仅记录管理员已在外部完成退款，PerPay 不执行转账，也未验证退款。

只有有实收金额的 `CONFIRMED / DISPUTED` 订单可以标记；未付款订单不能标记。撤销仅撤销这条管理员声明。标记与撤销都不修改付款状态、实收金额、历史退款状态、对外订单版本或记账分录，也不通知业务网站。标记和备注只在管理端订单列表与详情中返回，不出现在业务 API、公开收银台或通知中。

管理 API 为 `PUT /api/admin/v1/orders/{orderId}/refund-mark`，请求字段为 `operation_id`、独立标记 `version`、目标状态 `marked` 与可选 `note`。尚无标记时版本为 0；并发修改返回 `409 / refund_mark_version_conflict`，需要重新读取，不能静默覆盖。超时重试保留 UUID、版本和内容。

旧 `POST /api/admin/v1/reconciliation/refunds` 写接口已退役：通过鉴权和旧请求格式校验后返回 `410 / refund_recording_retired`。旧退款记录、部分／全额退款状态和已生成通知保留只读兼容，不自动转换成新标记。人工关联收入功能仍保留。

所有上述写接口均要求管理员会话、同源 JSON 和 CSRF 校验，不能使用业务 API 密钥替代。

人工关联接口 `POST /api/admin/v1/reconciliation/settlements/manual` 的 `reason` 可省略、填 `null` 或留空；空白内容统一作为未填写保存为 `null`，不生成默认理由。首次提交和原操作重试采用相同的空值语义；更换理由或关联对象必须使用新的操作编号，不能修改已完成操作的证据。非空理由仍需符合长度及字符校验。

### 外观

点击后台侧栏的 **外观**，先选配色，再选 **浅色／深色／跟随系统**，立即生效，无需保存：

- 配色有经典蓝、青竹、暖砂、柔紫、石墨，每种都有浅色和深色。
- 点选时面板保持打开；点击外部、关闭按钮或按 Escape 收起。手机先打开导航菜单。
- 偏好仅保存在当前浏览器，会同步到同源的其他标签页。旧的浅色／深色偏好不变，默认经典蓝＋跟随系统。
- 登录和初始化页面使用同一外观，不影响公开收银台、表单草稿或任何账务数据。

### 设置与安全

配置字段在所属分组中直接展示，查账间隔、订单规则、超时、重试及向导备份策略不再放入“高级设置”折叠；通知参数在启用业务通知后直接展示。校验失败会定位对应字段。普通设置未修改时不能重复保存，配置向导仍可保存默认值并继续。离开未保存表单时会确认是否放弃。

实例安全设置保留管理员安全和支付宝应用密钥管理；各网站 API／通知密钥在“业务网站”中分别管理。密钥仅在显式查看或轮换后显示，网站页可点击“隐藏密钥”，离开网站编辑页后不保留明文；不会自动加入查询缓存。API 密钥轮换后，旧密钥不能用于新的鉴权请求。通知密钥轮换后，新发送和重试的通知使用新密钥，已经发出的请求可能仍使用旧签名；接收端应及时更新验签配置，在过渡期短暂兼容新旧密钥，密钥疑似泄露时停止信任旧密钥。轮换不会自动重发已完成的通知；结果不确定时不要重复轮换，先刷新配置并查看当前密钥。

修改密码需输入两次，以“修改并重新登录”提交；注销全部会话位于“登录会话”的“更多”中。

## 7. 上线检查

- API 密钥和通知密钥只保存在网站服务端环境变量或密钥管理器。
- 生产环境使用 HTTPS，`notify_url` 必须位于管理 API 配置的允许来源下，不能依赖重定向。
- 创建订单遇到网络超时，使用相同幂等键重试，不要重复生成业务订单号。
- 通知和查询都可能重复或乱序，业务状态更新必须幂等并单向推进。
- 只有服务端查询或验签通知显示 `CONFIRMED` 时，才执行发货、充值或余额增加。

完整字段、错误码和接口契约见 [`openapi.yaml`](openapi.yaml)。


## 管理查询与订单导出

概览中的确认金额按 PerPay 的确认时间汇总，不是支付宝账单合计；收款确认笔数统计确认次数，包含自动和人工关联，不等于当前收款已确认的订单数。

- 订单和通知列表只按**创建日期**筛选，日期统一北京时间；通知的创建日期指投递记录创建日期。支持全部、今天、昨天、近 7／30 天和自定义范围。
- GET 管理订单及通知列表增加可选 `created_from`、`created_to`（`YYYY-MM-DD`）。必须成对，包含起止两天；服务端使用左闭右开时间范围。日期参与游标绑定，切换日期后重置分页，旧链接无日期时行为不变。
- 订单列表显示 PerPay 确认时间（收款确认事件的记录时间），手机默认隐藏，可从列菜单展开。时间来自最近一次 `PAYMENT_CONFIRMED` 事件，不是支付宝交易发生时间；争议订单仍保留历史确认时间。
- 在订单列表选择网站、收款账号和创建日期后点击“导出 CSV”，导出当前网站及收款账号范围、关键词、状态、日期与排序的**全部结果**，不是当前页。最多 10,000 条、日期跨度最多 366 天，超限须缩小范围；不导出通知。
- 接口为 `POST /api/admin/v1/orders/export`，请求包含必填日期及可选 `api_client_id`、`q`、`payment_status`、`checkout_status`、`sort_by`、`sort_order`。订单、通知列表及其分页游标同样绑定网站筛选。使用管理员会话、同源及 CSRF 校验，不使用业务 API 签名；读取请求后复核会话。
- 文件包含网站名称／客户端 ID、商户订单号／内部订单编号、商品、下单／应付／实收金额、币种、当前付款／收银台状态、创建／PerPay 确认时间。金额两位小数，空实收不同于零；采用 UTF-8 BOM、CSV 转义和公式注入防护。备注、通知正文、密钥及收银台能力链接不导出。
- 导出使用单个一致的数据库读取快照，不触发订单到期处理或修改财务记录。它是订单明细，**不是到账日结或净收入报表**；收款已确认也不代表通知已送达。

配置表单的请求／通知超时以秒显示，通知超时支持 0.001 秒精度，例如 5.123 秒保存为 5123 毫秒；超过 3 位小数时提示错误并阻止保存，不舍入。备份间隔可用秒、小时或天，API 仍使用原有毫秒／秒字段。查账组“采用推荐值”只改草稿，保存后才生效，加载不覆盖旧配置。备份策略保存不表示任务已启动或恢复已验证，参见[启用与验证备份](docs/maintenance.md#启用与验证备份)。

### 收银台手动核实接口

公开收银台 GET 保持读取状态，不触发查账。浏览器可同源 POST `/api/public/v1/checkouts/{token}/check`，发送 JSON `{}`；需要有效收银台令牌。等待中返回 202 和 Retry-After，终态返回 200；来源限流返回 429，服务不可用返回 503。只读演示拒绝该操作。后续使用普通收银台 GET 获取可选的 `verification`：`WAITING`、`SCANNING`、`RECONCILING`、`COMPLETED`、`FAILED`。进度只属于该订单，重启可失效，业务网站仍以已确认订单或验签通知为支付依据，不能把核实完成当成付款成功。
