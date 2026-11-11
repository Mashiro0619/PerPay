<!-- SPDX-License-Identifier: MIT -->

<a id="支付宝-sdk-迁移与网站接入工作计划"></a>

# 支付宝 SDK 与易支付接入设计

本文说明当前代码怎样调用支付宝 SDK、兼容易支付、保存网站密钥和发送通知。业务接入步骤见[易支付指南](../epay-integration.md)，开发入口见[开发导航](README.md)。依赖版本以 [package.json](../../package.json)为准，数据库结构版本（schema）及兼容范围以 [src/version.ts](../../src/version.ts)为准。

<a id="交付目标"></a>

## 当前能力

- 支付宝通信使用官方 Node.js SDK。SDK 负责请求签名和响应验签，PerPay 负责连接、超时和取消，解析账单、保存原始响应并进行对账。
- 网站可使用原生协议、易支付 V1 或 V2，共用收款账号分配、应付金额、收银台和订单状态。
- 易支付覆盖支付宝网页收款、查单、商户统计、付款通知和返回商家。
- 接入助手可以开启或关闭协议、查看和更换密钥、复制配置并打开文档。管理 API 还可以按协议导出 Demo 配置。

## 资料依据

PerPay 支持哪些参数和行为，以应用实际代码为准；用外部 SDK 发请求、验签和解析回调，检查它们能否正常配合使用。

| 来源 | 用途 |
| --- | --- |
| [支付宝官方 Node.js SDK](https://github.com/alipay/alipay-sdk-nodejs-all)、[调用实现](https://github.com/alipay/alipay-sdk-nodejs-all/blob/master/src/alipay.ts) | 请求接口、签名、验签与 Dispatcher 适配 |
| [ezfp V1](https://www.ezfp.cn/doc_old.html)、[V2 下单](https://www.ezfp.cn/doc/pay_create.html)、[查单](https://www.ezfp.cn/doc/pay_query.html)、[通知](https://www.ezfp.cn/doc/pay_notify.html) | 路径、字段、返回码和回调格式 |
| [全日付签名说明](https://alldaypay.cn/docs/?p=rsa) | RSA、时间戳及参数规则 |
| PHP V1.3、V2.0 SDK 与 [go-epay v0.0.5](https://github.com/Calcium-Ion/go-epay/tree/v0.0.5/epay) | 独立生成请求、解析回调与验签 |
| [New API](https://github.com/QuantumNous/new-api) | 下游充值、订阅及重复通知处理 |

PHP 下载地址、文件校验值、容器摘要和 New API 固定提交集中保存在[易支付客户端兼容检查](../../scripts/validation/epay/README.md)。支付宝 SDK 适配器和参考原型使用哪些输入、应返回什么结果，见 [SDK 验证](../../scripts/validation/alipay-sdk/README.md)。

### 易支付协议规则

| 项目 | V1 | V2 |
| --- | --- | --- |
| 页面下单 | GET/POST `/submit.php` | GET/POST `/api/pay/submit` |
| API 下单 | POST `/mapi.php` | POST `/api/pay/create` |
| 单笔查询 | GET/POST `/api.php?act=order` | POST `/api/pay/query` |
| 商户信息与列表 | `/api.php?act=query`、`act=orders` | POST `/api/merchant/info`、`/api/merchant/orders` |
| 请求编码 | UTF-8 表单 | UTF-8 表单 |
| 鉴权 | 下单参数排序后追加商户密钥，计算小写 MD5；查询使用 `pid` 和 `key` | 商户私钥生成 RSA-SHA256 签名，Base64 编码 |
| 响应与回调 | 按 V1 返回格式；回调使用 V1 商户密钥签名 | 平台私钥签名，商户使用平台公钥验证 |
| 成功返回码 | 下单和查询接口 `code=1` | `code=0` |
| 支付状态 | `0` 未支付、`1` 已支付 | `0` 未支付、`1` 已支付 |
| 时间戳 | 按 V1 字段约定 | Unix 秒，允许前后 300 秒 |
| 付款通知与同步返回 | GET，`TRADE_SUCCESS` | GET，`TRADE_SUCCESS`，带时间戳及签名 |
| 通知接收成功的响应 | HTTP 2xx，正文去除首尾空白后为 `success` | 同左 |

先用收到的参数原文验签，再转换金额等业务字段。`sign`、`sign_type` 和协议约定的空值不参加签名，字符串 `"0"` 仍参加。V1 保留纯空格值；V2 排除按 PHP `trim` 规则判断为空的值，其他值仍保留原文。V2 下单与单笔查询把结果字段直接放在响应顶层；列表则放在顶层 `data` 数组中，该数组按 PHP SDK 规则不参加顶层签名。实现见 [protocol.ts](../../src/epay/protocol.ts)。

<a id="易支付兼容选择"></a>

### 易支付接口处理规则

- 页面下单可省略 `type`，进入支付宝收银台；API 下单要求 `type=alipay`。V2 API 接受 `method=web/jump`，返回 `pay_type=jump` 和 PerPay 收银台地址。
- V1 页面下单要求 `return_url`；V1 API 和 V2 下单允许省略。通知地址必填，通知与返回地址分别匹配该网站保存的 HTTPS 来源。
- `device` 等扩展字段只要是单个值，也参加验签。数组、重复参数和 GET/POST 同名参数冲突会返回参数错误。
- 签名把字段直接拼成 `key=value&key=value`，不会重新编码每个字段。参数名含 `&`、`=`，或参数值含 `&` 时，同一段文本可能有多种拆分方式，因此拒绝这些内容；规则与 go-epay v0.0.5 一致。
- 商品名先验签，再按完整字符截取至 127 个 UTF-8 字节；重试比较原始业务内容。单号保持字符串。
- 查单同时传入 `trade_no` 和 `out_trade_no` 时，优先使用 `trade_no`。V1 列表按 `page`、V2 按 `offset` 分页，`limit` 默认 20、最大 50；每个网站只能查询自己的订单和统计。
- 回调地址中已有的固定查询参数与协议参数一起签名。接受回调地址前，检查名称是否重复、是否与协议字段重名，以及 PHP 解码是否会改变参数名。
- 退款、代付、结算和其他支付方式返回不支持错误。商户信息提供网站订单统计；直收模式的余额为 `0.00`，结算关闭。

<a id="实施内容"></a>

## 实现结构

### 支付宝官方 SDK 适配验证

应用实际使用的适配器调用 SDK 的普通 `curl`。每次请求创建独立的 Dispatcher（请求转发对象），将 SDK 已签名的请求交给 PerPay 的 `NodeV3Transport`。PerPay 先保存原始响应，再交由 SDK 验签，最后解析账单。这样既使用官方的签名规则，也留下可供核对的原始响应。

| 模块 | 职责 |
| --- | --- |
| [sdk-provider.ts](../../src/infrastructure/alipay/sdk-provider.ts) | 调用 SDK，把验签结果和错误转换成 PerPay 使用的状态，再进入账务解析 |
| [sdk-dispatcher.ts](../../src/infrastructure/alipay/sdk-dispatcher.ts) | 在 SDK 与 PerPay 传输接口之间转发请求，处理取消和超时 |
| [node-transport.ts](../../src/infrastructure/alipay/node-transport.ts) | DNS、连接、读取响应，并限制正文和响应头大小 |
| [provider.ts](../../src/infrastructure/alipay/provider.ts) | 严格账单解析、金额、分页和字段校验 |
| [ledger/](../../src/ledger/) | 把流水和来源记录保存到数据库，维护正常查账与历史补查进度 |

保存的原始记录包含响应正文、响应头、HTTP 状态、trace ID 和验签状态。正文上限为 2 MiB，响应头上限为 16 KiB。请求失败、被取消或超过大小限制时，也记录当时已经收到并保留的响应信息；还没完成验签时，验签状态记为未知。

<a id="正式迁移支付宝调用"></a>

### 查账、连接检查与密钥验证

运行时，每个账号通过 SDK 适配器查账；[密钥验证](../../src/settings/provider-key-verification.ts)和账号连接检查也使用同一实现。账号配置重新加载、更换密钥或停止运行时，取消仍在进行的请求。

正常查账和历史补查分别记录进度。正常查账完成本轮开始时确定的时间范围后，才更新最近查账成功时间；历史补查成功不会刷新这个时间。账号能否接收新订单，仍取决于正常账单是否需要继续追赶、是否出现故障、首次查账是否完成，以及结果是否超过有效期。

旧签名和 Provider 实现保留在测试代码中，用来比较协议处理结果；应用实际运行时继续执行账务解析、密钥格式检查，以及响应大小和时间限制。

<a id="固定易支付协议与测试样例"></a>

<a id="协议与互操作依据"></a>

### 协议规则与客户端检查

[协议实现](../../src/epay/protocol.ts)负责处理表单参数、MD5/RSA 签名、以秒计的时间戳和回调 URL 编码。[客户端兼容检查脚本](../../scripts/validation/epay/README.md)使用固定版本的 PHP SDK、Go SDK 和 New API，实际生成请求、查询订单、接收通知并处理返回商家。编码样例包含中文、空格、`+`、值中的 `=`、字面量 `%26` 和零值。

### 网站配置、密钥与数据迁移

每个网站有固定的数字商户号 PID、V1/V2 接单开关和独立配置版本。新网站默认生成 V1 商户密钥、V2 商户密钥对及平台密钥对；启动时为尚未初始化易支付的旧网站补齐这些内容，保留已有配置和密钥。PID 与固定网站编号对应，更换公开客户端 ID 不会改变 PID；删除网站后也不再把旧 PID 分配给其他网站。

密钥按网站加密保存，查看、更换和导出接口都要检查权限并留下审计记录。易支付订单的补充表保存所用协议、数字 `trade_no`、原样传递的 `param`、用于识别原请求内容的摘要，以及商家返回地址；这些信息与核心订单在同一数据库事务中保存。

通知记录保存协议标识和密钥版本；历史原生记录按原有算法解释。数据库约束、迁移和兼容范围见 [database/](../../src/database/)与[版本声明](../../src/version.ts)。

### 下单、查单、通知与返回商家

易支付请求通过鉴权后，进入现有的网站订单服务，使用相同的账号分配、金额占用、收银台和对账流程。固定网站编号与商户订单号共同确定一笔业务订单：按原内容重试会返回原订单，修改金额、地址、透传内容或协议后重试则返回冲突。同一网站内，原生和易支付接口共用一套商户单号，不能各自创建一笔同号订单。

易支付对外 `money` 使用下单金额。例如商品原价 10.00 元、应付 10.03 元时，易支付查询和回调仍返回 10.00 元，收银台和对账使用 10.03 元。

当前收款已确认时，易支付接口返回支付成功；其他收款状态返回未支付。只有付款确认事件能生成易支付成功通知。自动发送或手动重发前，都重新检查原确认事件；确认撤销后，停止发送该事件的成功通知。后来重新确认收款时，使用新生成的确认事件。

发送通知时，按协议选择 HTTP 方法、签名和成功响应格式：原生 POST JSON 要求约定的 HTTP 200 JSON 回执，易支付 GET 接受正文为 `success` 的 2xx 响应。每次 V2 发送都重新生成时间戳和签名。队列继续记录任务由谁处理（租约）、失败后等多久再试（退避）、每次发送结果及人工重发记录。

收银台先访问 PerPay 内部的返回接口，用收银台令牌授权并读取最新收款状态。已确认付款时，在商家返回地址附加协议参数和签名后跳转；其他状态使用原商家地址。这个内部跳转支持配置允许的本机回环 HTTP 实例，商家通知地址和返回地址的来源仍须通过 HTTPS 校验。

轮换后，新请求与后续投递使用新密钥。关闭 V1/V2 接单开关只影响新订单，历史查询、返回和通知继续按网站配置处理；通知暂停由网站通知开关控制。

### 接入助手与 Demo

[网站接入助手](../../web/src/components/site-integration-assistant.tsx)展示原生、V1、V2 三种协议和所需密钥，提供查看、复制、更换密钥和文档入口，并可打开该网站的订单与通知记录。在同一网站的不同编辑分组之间切换时，保留尚未保存的协议设置。

需要整份 Demo 配置时，可调用 `POST /api/admin/v1/sites/:clientId/integration/export`。接口检查网站和易支付配置的版本、通知地址与返回地址的来源，再从同一数据库快照读取配置和密钥，避免拿到不同时间的设置；结果是带下载文件名的 `.env`。

| 配置 | 导出字段 |
| --- | --- |
| 通用 | `PAYMENT_PROTOCOL`、`DEMO_NOTIFY_URL`、`DEMO_RETURN_URL`、`DEMO_PORT`、`DEMO_DATA_DIR` |
| 原生 | `PERPAY_URL`、`PERPAY_CLIENT_ID`、`PERPAY_API_SECRET`、`PERPAY_WEBHOOK_SECRET` |
| 易支付通用 | `EPAY_URL`、`EPAY_PID` |
| V1 | `EPAY_V1_KEY` |
| V2 | `EPAY_MERCHANT_PRIVATE_KEY`、`EPAY_PLATFORM_PUBLIC_KEY` |

[Node Demo](../../examples/node-client/README.md)通过 `PAYMENT_PROTOCOL=native/epay_v1/epay_v2` 选择模式，不同实例、网站和协议使用各自的数据目录。通知入口接受原生 POST JSON 或易支付 GET，返回入口处理顾客从收银台回到商家页面的请求。联调时从业务端创建订单，再核对付款状态、通知接收结果，以及是否已完成充值或发货。

<a id="接口文档与交付验收"></a>

### 接口与维护入口

- `GET/PUT /api/admin/v1/sites/:clientId/epay` 读取和保存协议开关，写入携带配置版本。
- `POST .../secrets/epay_v1|epay_merchant|epay_platform/actions/view|rotate` 显式查看或轮换凭据。
- `POST .../integration/export` 导出当前协议的 Demo 配置；公开地址使用服务端 `public_origin`。
- 管理接口接受什么请求、返回什么字段，定义在 [OpenAPI](../../openapi.yaml)。修改后通过 `npm run api:types` 更新客户端，并同步[易支付指南](../epay-integration.md)与 Demo。

<a id="验收清单"></a>

## 验证依据

| 维护内容 | 核对入口 |
| --- | --- |
| SDK 签名、响应、取消与原始记录 | [SDK 接口用例](../../scripts/validation/alipay-sdk/README.md) |
| V1/V2 编码、查单、通知与返回 | [固定 SDK 和业务系统兼容检查](../../scripts/validation/epay/README.md) |
| 接入界面、草稿、密钥与网站切换 | [开发验证](ui-verification.md#日常手工核对) |
| 数据库升级、备份和恢复 | [Linux 专项](ui-verification.md#linux-升级与进程恢复) |
| 实际收款、发货或开通服务 | [支付宝配置](../alipay-setup.md)及[业务接入](../epay-integration.md) |

日常改动先完成相应类型检查、构建和人工核对。已有自动化在 CI 或需要检查指定功能时运行。每次记录所用源码、依赖版本、环境和实际结果，通过数量以这次输出为准。
