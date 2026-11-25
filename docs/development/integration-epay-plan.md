<!-- SPDX-License-Identifier: MIT -->

<a id="支付宝-sdk-迁移与网站接入工作计划"></a>

# 支付宝 SDK 与易支付接入设计

本文记录当前实现中支付宝官方 SDK 适配层、易支付 V1/V2 协议兼容层、站点密钥持久化及回调/跳转状态机的工程设计。

用户侧配置见[易支付对接指南](../epay-integration.md)；源码入口见[开发导航](README.md)；依赖版本以 [package.json](../../package.json) 为准，Schema 版本及兼容窗口以 [src/version.ts](../../src/version.ts) 为准。

<a id="交付目标"></a>

## 架构职责划分

- **支付宝通道**：复用官方 Node.js SDK 完成请求签名与响应验签；PerPay 自建传输层与适配器控制连接、超时、取消、原始响应落盘及严格账单解析。
- **多协议复用**：同一业务网站可并存原生 API、易支付 V1、易支付 V2，共享底层收款账号调度、唯一应付金额分配、公开收银台、对账引擎与订单状态机。
- **易支付能力边界**：覆盖支付宝网页/跳转收款、查单、商户信息/订单列表、异步通知与同步返回；退款/代付/结算及其他通道显式返回不支持。
- **配置与联调**：后台接入助手统一管理协议开关、密钥查看/轮换与一键复制；管理 API 支持事务快照式导出各协议 `.env` Demo 配置。

## 协议参考基线

行为边界以仓库源码为准，以下外部规范与固定版本 SDK 用于互操作回归验证：

| 参考源 | 验证范围 |
| --- | --- |
| [alipay-sdk-nodejs-all](https://github.com/alipay/alipay-sdk-nodejs-all) / [alipay.ts](https://github.com/alipay/alipay-sdk-nodejs-all/blob/master/src/alipay.ts) | 签名、验签与自定义 Dispatcher 钩子 |
| [ezfp V1](https://www.ezfp.cn/doc_old.html) · [V2 下单](https://www.ezfp.cn/doc/pay_create.html) · [查单](https://www.ezfp.cn/doc/pay_query.html) · [通知](https://www.ezfp.cn/doc/pay_notify.html) | 路径、字段、状态码与回调载荷 |
| [全日付 RSA 说明](https://alldaypay.cn/docs/?p=rsa) | RSA-SHA256 签名串与时间戳校验 |
| PHP V1.3 / V2.0 SDK、[go-epay v0.0.5](https://github.com/Calcium-Ion/go-epay/tree/v0.0.5/epay) | 第三方签名、查单与回调验签互操作 |
| [New API](https://github.com/QuantumNous/new-api) | 真实下游充值/订阅与重复通知幂等处理 |

固定下载地址、文件校验和、容器镜像摘要及 New API Commit 见[易支付兼容验证](../../scripts/validation/epay/README.md)；SDK 适配器用例见[支付宝 SDK 验证](../../scripts/validation/alipay-sdk/README.md)。

### 易支付 V1 / V2 协议契约

| 维度 | 易支付 V1 | 易支付 V2 |
| --- | --- | --- |
| 页面下单 | `GET/POST /submit.php` | `GET/POST /api/pay/submit` |
| API 下单 | `POST /mapi.php` | `POST /api/pay/create` |
| 单笔查询 | `GET/POST /api.php?act=order` | `POST /api/pay/query` |
| 商户信息 / 列表 | `/api.php?act=query`、`act=orders` | `POST /api/merchant/info`、`/api/merchant/orders` |
| 请求编码 | UTF-8 表单 | UTF-8 表单 |
| 请求鉴权 | 排序拼接 + 追加商户密钥 → 小写 MD5；查询验 `pid` + `key` | 商户私钥 RSA-SHA256 → Base64 |
| 响应 / 回调签名 | 回调使用 V1 商户密钥 MD5 | 平台私钥 RSA-SHA256，下游用平台公钥验签 |
| 成功返回码 | `code=1` | `code=0` |
| 支付状态字段 | `0` 未支付 / `1` 已支付 | `0` 未支付 / `1` 已支付 |
| 时间戳窗口 | 按 V1 约定 | Unix 秒，容差 `±300s` |
| 通知与同步返回 | `GET`，`TRADE_SUCCESS` | `GET`，`TRADE_SUCCESS`，含时间戳与签名 |
| 有效通知回执 | HTTP `2xx` 且 `trim(body) === "success"` | 同左 |

<a id="易支付兼容选择"></a>

### 协议解析与边界不变量

实现位于 [src/epay/protocol.ts](../../src/epay/protocol.ts)，核心不变量如下：

- **先原文验签，再业务解码**：`sign`、`sign_type` 与协议空值不参与签名，`"0"` 参与签名。V1 保留纯空格字符串；V2 按 PHP `trim` 判定空值剔除，其余字段保留原文。V2 下单/查单结果平铺在顶层；列表结果放在顶层 `data` 数组（按 PHP SDK 约定，`data` 数组不参与顶层签名）。
- **防拼接歧义与下单白名单**：签名串直接以 `key=value&...` 拼接而不做二次 URL 编码，因此拒绝参数名含 `&`/`=`、数组参数、重复同名参数及 GET/POST 同名冲突。非 URL 参数值（如 `name`、`param`）严禁含 `&`（对齐 `go-epay v0.0.5`）；下单接口启用标准字段白名单（`EPAY_CREATE_PARAMETERS`），仅允许 `notify_url` / `return_url` 的查询串包含 `&`（路径与子查询值仍禁 `&`），并禁止回调查询参数使用协议保留字段名（防止参数拆分/合并走私）。
- **参数要求与截断**：页面下单可省 `type`（默认支付宝），API 下单强校验 `type=alipay`；V2 API 支持 `method=web|jump`，统一返回 `pay_type=jump` 与收银台 URL。V1 页面下单必填 `return_url`，V1 API 与 V2 允许省略；`notify_url` 必填；两者须匹配站点白名单 HTTPS origin。商品名验签后按完整 UTF-8 字符截断至 `127` 字节，幂等冲突对比原始业务载荷；单号始终按字符串处理。
- **查询、回调 URL 与直收限制**：查单同时给 `trade_no` 与 `out_trade_no` 时优先 `trade_no`。V1 按 `page`、V2 按 `offset` 分页（`limit` 默认 `20`，上限 `50`），严格限本站点数据。回调 URL 自带固定 query 参与签名，入库前校验无重名键、不与保留字段重名（`return_url` 例外允许携带与本单一致的 `out_trade_no` 并在回跳时去重复用），以及经 PHP 解码后键名不变。直收模式下商户余额恒为 `0.00`、结算关闭。

<a id="实施内容"></a>

## 核心子系统设计

### 支付宝官方 SDK 适配层

适配器调用官方 SDK 常规 `curl` 入口，每次请求构造独立 Dispatcher 将已签名请求交由 PerPay 的 `NodeV3Transport` 执行：**先落盘原始响应，再交 SDK 验签，最后进入账单解析**，保证异常/失败请求同样留存审计证据。

| 模块 | 职责 |
| --- | --- |
| [sdk-provider.ts](../../src/infrastructure/alipay/sdk-provider.ts) | 驱动 SDK，映射验签结果与异常至领域错误码 |
| [sdk-dispatcher.ts](../../src/infrastructure/alipay/sdk-dispatcher.ts) | 桥接 SDK 与 PerPay Transport，传递超时与 `AbortSignal` 取消 |
| [node-transport.ts](../../src/infrastructure/alipay/node-transport.ts) | DNS、连接、流式读取，强制响应头 `16 KiB` / 正文 `2 MiB` 上限 |
| [provider.ts](../../src/infrastructure/alipay/provider.ts) | 严格账单字段、金额、分页与时间解析校验 |
| [ledger/](../../src/ledger/) | 事务落库流水与原始凭证，维护正常查账与历史补扫双游标 |

原始响应快照包含：HTTP 状态码、响应头、响应体、trace ID 及验签状态。发生网络错误、取消或超限时，仍记录已收到的部分响应信息，未完成验签则状态记为 `unknown`。

<a id="正式迁移支付宝调用"></a>

### 查账调度、密钥验证与双轨游标

- 定时查账、[密钥验证](../../src/settings/provider-key-verification.ts)与连通性测试共用同一 SDK 适配器；账号配置重载、密钥轮换或停止运行时立即取消在途请求。
- **双游标隔离**：正常查账完成本轮目标窗口后才推进 `last_success_at`；历史补扫成功不刷新该时间戳。账号可接单判定取决于：首次正常查账完成、近期窗口未落后、无持续故障、且 `last_success_at` 仍在有效期内。
- 旧签名与 Provider 实现仅保留于测试套件中作协议回归对照，不进入生产运行时。

<a id="固定易支付协议与测试样例"></a>
<a id="协议与互操作依据"></a>

### 互操作编码基线

[protocol.ts](../../src/epay/protocol.ts) 与[易支付兼容验证](../../scripts/validation/epay/README.md)使用 PHP SDK、Go SDK 与 New API 覆盖关键边界编码样例：中文字符、空格、`+`、值内含 `=`、字面量 `%26` 及字符串 `"0"`。

### 站点配置、密钥与数据库事务

- **固定 PID 与独立配置版本**：每个站点分配不可变数字 `pid`、V1/V2 接单开关与独立 `config_version`。新站点自动生成 V1 密钥、V2 商户密钥对与平台密钥对；旧站点升级启动时按需补齐且保留已有配置。更换公开客户端 ID 不改变 `pid`；已删除站点的 `pid` 永不复用。
- **加密与审计**：站点密钥均由主密钥加密存储，查看、轮换与导出均需权限校验并写审计日志。
- **补充表事务一致性**：易支付扩展信息（协议类型、数字 `trade_no`、透传 `param`、请求摘要、商家 `return_url`）与核心订单在**同一 SQLite 事务**内写入。通知任务记录协议类型与密钥版本，历史原生记录沿用原验签逻辑。Schema 约束与迁移见 [src/database/](../../src/database/) 与 [src/version.ts](../../src/version.ts)。

### 下单、金额语义、通知与同步返回

- **跨协议单号唯一性**：`(内部站点编号, merchant_order_no)` 构成唯一业务键，同一站点内原生与易支付共享命名空间。同载荷重试返回原订单；修改金额、回调/返回地址、透传参数或协议则报冲突。
- **对外金额口径**：易支付 `money` 恒等于**下单金额**（不含 PerPay 随机加价）；例如原价 `10.00`、应付 `10.03` 时，易支付查单与回调仍返回 `10.00`，收银台与对账使用 `10.03`。
- **通知与撤销语义**：仅当订单处于“收款已确认”时易支付才返回已支付；仅收款确认事件可产生易支付成功通知。自动投递与人工重发前均复核原确认事件——确认撤销后立即终止该事件的成功通知，重新确认将生成新事件。每次 V2 投递重新生成时间戳与签名；队列维持租约（lease）、退避（backoff）、逐次投递日志与重发原因。
- **同步返回跳转**：收银台先携收银台令牌请求 PerPay 内部返回接口读取实时状态；已确认付款时向商家 `return_url` 附加协议参数与签名后 302/跳转，否则跳转原始商家地址。该内部跳转允许配置的本机回环 HTTP 实例，但商家 `notify_url` / `return_url` 始终强校验 HTTPS 白名单。
- **开关与轮换边界**：密钥轮换后新请求与后续投递启用新密钥；关闭 V1/V2 接单开关仅拦截新下单，历史查单、同步返回与通知继续按原协议处理（暂停通知由站点通知总开关控制）。

### 接入助手与快照式 Demo 导出

[site-integration-assistant.tsx](../../web/src/components/site-integration-assistant.tsx) 集中呈现原生/V1/V2 开关、密钥查看/轮换与一键复制，且在同一站点编辑器内切换分组时保留未保存草稿。

调用 `POST /api/admin/v1/sites/:clientId/integration/export` 时，服务端先校验站点与易支付的 `config_version` 以及通知/返回 URL 来源，再在**同一数据库快照**内读取配置与密钥生成 `.env` 下载文件（防止并发轮换导致半旧半新配置）：

| 分组 | 导出键名 |
| --- | --- |
| 通用 | `PAYMENT_PROTOCOL`、`DEMO_NOTIFY_URL`、`DEMO_RETURN_URL`、`DEMO_PORT`、`DEMO_DATA_DIR` |
| 原生 | `PERPAY_URL`、`PERPAY_CLIENT_ID`、`PERPAY_API_SECRET`、`PERPAY_WEBHOOK_SECRET` |
| 易支付通用 | `EPAY_URL`、`EPAY_PID` |
| 易支付 V1 | `EPAY_V1_KEY` |
| 易支付 V2 | `EPAY_MERCHANT_PRIVATE_KEY`、`EPAY_PLATFORM_PUBLIC_KEY` |

[Node Demo](../../examples/node-client/README.md) 通过 `PAYMENT_PROTOCOL=native|epay_v1|epay_v2` 切换运行模式，不同实例/站点/协议使用独立数据目录联调下单、查单、回调与返回。

<a id="接口文档与交付验收"></a>

### 管理端接口契约

- `GET/PUT /api/admin/v1/sites/:clientId/epay`：读写易支付协议开关（写请求带 `config_version` 乐观锁）。
- `POST /api/admin/v1/sites/:clientId/secrets/epay_v1|epay_merchant|epay_platform/actions/view|rotate`：显式查看或轮换密钥。
- `POST /api/admin/v1/sites/:clientId/integration/export`：导出指定协议的 Demo `.env`（对外基址取服务端 `public_origin`）。
- 完整契约定义于 [openapi.yaml](../../openapi.yaml)；变更后必须同步执行 `npm run api:types`，并更新[易支付对接指南](../epay-integration.md)与 Node Demo。

<a id="验收清单"></a>

## 回归与验收矩阵

| 验证维度 | 入口 |
| --- | --- |
| SDK 签名、验签、取消与原始响应落盘 | [支付宝 SDK 验证](../../scripts/validation/alipay-sdk/README.md) |
| V1/V2 编码、查单、通知与同步返回 | [易支付兼容验证](../../scripts/validation/epay/README.md) |
| 接入助手、草稿守卫、密钥查看与多站切换 | [日常手工核对](ui-verification.md#日常手工核对) |
| Schema 升级、备份与崩溃恢复 | [Linux 升级与进程恢复](ui-verification.md#linux-升级与进程恢复) |
| 真实支付宝实付与业务履约 | [支付宝配置](../alipay-setup.md) · [易支付对接指南](../epay-integration.md) |

留痕要求：每次验收记录源码 Commit、依赖版本、运行环境与实测输出，通过数以当次实际运行结果为准。
