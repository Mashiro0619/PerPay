<!-- SPDX-License-Identifier: MIT -->

# 多业务网站接入

一套 PerPay 可以服务多个自有业务网站，并连接多个支付宝收款账号。每个网站分别管理接入凭据、订单和通知；新订单按网站配置选择收款账号，款项进入对应支付宝账户。

首次接入按[快速指南](integration-quickstart.md)操作。本页说明如何创建网站、分配收款账号，以及暂停网站或更改配置后如何处理新旧订单。

<a id="配置归属"></a>

## 哪些设置共用，哪些按网站保存

| 配置 | 归属 |
| --- | --- |
| 支付宝账号的 App ID、应用私钥、支付宝公钥、收款码及历史版本 | 每个收款账号独立保存，可供多个网站选择。 |
| 查账间隔、查账延迟、超时和成功有效时限 | 整套服务统一设置，各账号分别查账。 |
| 管理员安全、备份、后台名称、图表、收银台令牌策略 | 整套服务共用。 |
| 客户端 ID、API 密钥、通知密钥、易支付凭据 | 每站独立。 |
| 接单开关、账号分配、收银台有效期、加价金额、金额冷却、待付款上限 | 每站独立。 |
| 通知开关、通知来源、返回来源、超时和重试策略 | 每站独立。 |
| 收银台名称、帮助链接、商品名展示 | 每站独立。 |

查账和订单策略由 PerPay 管理。支付宝应用需处于“已上线”状态，并具有对应账户账务明细查询权限；账号使用正式网关。具体配置见[支付宝接入](alipay-setup.md)。

## 创建与接入

1. 在“全局管理 → 业务网站”创建网站，填写名称，选择收款账号，可选填客户端 ID；其余策略复制当前默认模板。
2. 进入该网站的“接入与通知”。原生协议生成或查看 API 密钥、通知密钥；易支付协议使用该站 PID 和对应凭据。
3. 把凭据保存到业务后端，设置精确 HTTPS 通知来源并开启通知。需要返回商家时，另行设置返回来源。
4. 账号能够正常查账并自动确认收款后，从业务网站完成下单、查询、通知验签，以及收款后的发货或服务开通流程。管理员测试收款同样创建真实订单，并遵守该站的容量与账号限制。

每个网站有一个稳定网站编号和一个当前客户端 ID。管理路径中的 `:clientId` 始终使用稳定网站编号，字段对应关系如下：

| 场景 | 稳定网站编号 | 当前客户端 ID |
| --- | --- | --- |
| 管理 API 网站对象 | `client_id` | `api_client_id` |
| 业务 `GET /api/v1/system/status` | `site_id` | `client_id` |
| 业务 API 鉴权 | 服务端根据凭据确定 | `X-PerPay-Client-Id` 和签名原文中的客户端 ID |
| 管理订单／通知归属与网站筛选 | `api_client_id` | — |

客户端 ID 为 3–64 个 ASCII 字符，以字母或数字开头，后续可包含字母、数字、`.`、`_`、`-`，区分大小写。`default`、`new`、`defaults`、`overview` 及其大小写变体为保留名称。使用过的 ID 会一直保留，更换 ID 或删除网站后也不能将旧 ID 分配给其他网站。

通过“更换客户端 ID”修改后，业务端立即同步更新认证头和签名原文。稳定网站编号和易支付 PID 不变，已有订单、通知、密钥和防止重复下单的记录仍属于原网站。系统根据接入凭据确定网站，订单正文无需再带网站 ID。

## 网站收款账号

网站的 `configuration.collection` 指定新订单可以使用哪些账号，以及如何选择：

```json
{
  "mode": "WEIGHTED",
  "accounts": [
    { "account_id": "account-a", "weight": 3 },
    { "account_id": "account-b", "weight": 1 }
  ]
}
```

| `mode` | 分配规则 |
| --- | --- |
| `FIXED` | 只配置一个账号；该账号不可用时返回失败。 |
| `RANDOM` | 在所选且可用的账号中等概率随机选择。 |
| `WEIGHTED` | 按正整数权重随机选择，默认权重为 1；两个可用账号权重为 3:1 时，被选中的概率分别为 75% 和 25%。 |

每站最多选择 100 个账号，账号不能重复；权重范围为 1–1,000,000。配置未完成、已暂停或暂时无法正常查账的账号不接新单。随机和加权分配选到的账号若已用完可分配金额，系统会尝试其他可用账号。

订单创建成功后，账号、收款码和金额就会确定；重复提交原下单请求会返回原订单。修改分配规则、换码或暂停账号影响新单，旧单继续按原记录查账。正式账号的 App ID 和收款码均不能重复，一条账号配置应对应一个实际收款账户。更换查账应用时，编辑原账号，不要为同一收款账户新建账号。

已有重复配置时，保留一个账号，在其余账号的“收款码”中清空内容并保存，再将网站分配到保留的账号。原订单和收银台记录会保留；已有重复确认需按流水和订单记录人工核对。不同收款码也可能属于同一个支付宝账户，请按实际收款账户配置。

只有未被网站、订单或历史流水使用的账号才能删除。删除后清除当前密钥并隐藏账号，已用过的账号编号、收款码、删除记录和相关操作记录继续保存。

旧数据库升级后，原支付宝配置会成为默认账号，已有网站继续固定使用它。订单、流水对应的应用配置、已占用的金额和待启用密钥都会保留。旧版单账号配置的写接口返回 `410 / alipay_settings_moved`。历史沙箱账号可以查看，但停止新接入、换钥和查账；使用正式应用时新建账号，再调整网站分配。[升级与恢复](maintenance.md#固定版本与回滚)

## 订单归属与金额

- `order_id` 是全局唯一订单 ID，`merchant_order_no` 是网站自己的业务单号。网站之间的订单、事件、幂等键和 nonce 分别隔离；另一站的资源返回 `404`。
- 金额占用和冷却按收款账号分别计算。同账号的多个网站共用可分配的应付金额，不同账号可以同时使用同一金额。网站的待付款上限限制订单数量，不会提前为该网站预留金额。
- 分配时选择最小可用加价金额。历史订单自己的冷却期限持续有效，不会被另一网站更短的设置覆盖。
- 支付宝流水通过账号、金额和时间匹配；无法唯一确认订单归属时进入核查。静态收款码不提供按商户单号确认的支付宝逐单支付凭证。
- 新订单保存订单策略和收款码关联。修改网站展示可以更新旧收银台外观，金额、有效期、冷却和二维码关联仍使用原记录。
- 认证通过后，重复提交已成功下单的原请求会优先返回原订单。即使网站已暂停接单、配置发生变化，或容量已满，也不会重新创建订单。

<a id="生命周期与通知"></a>

## 暂停网站或更改配置会怎样

| 操作 | 生效方式 |
| --- | --- |
| 暂停接单 | 停止新订单；旧单查询、关闭、付款、核实、对账和通知继续。凭据仍有效，密钥泄露应另行轮换。 |
| 关闭通知 | 停止开始新的通知发送任务，已开始的任务按开始时的配置完成。恢复后继续原任务；已停止重试的失败通知由管理员处理。 |
| 修改通知来源 | 后续尝试和重发先检查原通知地址是否符合当前设置；不符合则失败。修改来源不会自动替换订单中的通知地址。 |
| 修改返回来源 | 用于新订单校验，旧订单保留原返回地址。 |
| 轮换 API 密钥 | 旧密钥立即失效，业务端同步更新。 |
| 轮换通知密钥 | 后续发送使用当前密钥，已发出的请求可能使用旧签名。接收端可按需要短暂接受新旧两把密钥；泄露的旧密钥应停止使用。 |
| 删除网站 | 仅无历史订单、事件和通知的网站可删除；已用身份继续保留，避免重新分配。 |
| 修改默认模板 | 只影响以后创建网站的预填策略，不批量覆盖已有网站，也不包含身份、密钥或来源。 |

每个支付宝账号分别保存查到了哪里、最近查账是否成功。同账号的多个收银台核实请求会合并，并遵守最小查账间隔和失败后的等待时间，未查完的分页会继续查询。通知按网站轮流、逐条发送，所以一个网站响应超时会增加其他网站的等待时间。

## 管理接口与查询

这些接口需携带已登录的管理员会话。写操作使用 JSON 正文，并通过同源和 CSRF 校验：

| 接口 | 请求要点 |
| --- | --- |
| `GET/POST /api/admin/v1/sites` | 列表／创建；创建携带 `operation_id`、完整 `configuration` 和可选 `client_id`。 |
| `GET/PUT/DELETE /api/admin/v1/sites/:clientId` | 读取／完整更新／删除；写入携带当前网站 `revision`。 |
| `POST /api/admin/v1/sites/:clientId/actions/change-client-id` | `operation_id`、`revision`、新 `client_id`；路径使用稳定网站编号。 |
| `POST /api/admin/v1/sites/:clientId/secrets/{api_secret,webhook_secret}/actions/rotate` | 生成或轮换密钥，携带网站 `revision`。 |
| `POST /api/admin/v1/sites/:clientId/secrets/{api_secret,webhook_secret}/actions/view` | 查看密钥内容，正文 `{}`。 |
| `GET/PUT /api/admin/v1/settings/site-defaults` | 读取／保存默认策略，使用模板独立的 `revision`。 |
| `GET/POST /api/admin/v1/alipay-accounts` | 账号列表／创建；创建可用 `operation_id` 保护重试。 |
| `GET/PUT/DELETE /api/admin/v1/alipay-accounts/:accountId` | 账号读取／更新／删除，写入携带账号 `revision`。 |
| `POST /api/admin/v1/alipay-accounts/:accountId/check` | 检查已保存的连接配置。 |
| `PUT /api/admin/v1/settings/collection-policy` | 保存共用查账策略，携带全局设置的 `revision`。 |

表单校验失败会保留草稿，并显示对应字段错误。版本冲突后先重新读取当前配置，核对草稿再保存；详情见 [OpenAPI](../openapi.yaml)。

业务状态接口 `GET /api/v1/system/status` 返回当前网站的 `status`、`code`、`site_id`、`client_id`、`accepting_orders` 和 `notifications_enabled`。`/healthz` 检查服务运行情况，`/readyz` 检查收款功能是否可用。

## 从 0.3.2 升级

旧网站会迁入普通网站 `default`，已有密钥、订单、请求去重记录、nonce 和通知关联继续保留；从未生成的原生 API／通知密钥仍需主动生成。新安装的 PerPay 由管理员创建网站。

升级前，先用当前运行的版本完成备份，单独保存主密钥，再停止 `app` 和 `backup`。迁移网站数据时，需要主密钥校验并重新加密相关业务数据。回退时恢复升级前备份，再运行与该备份匹配的版本；旧版不能直接打开升级后的数据库。步骤见[维护与恢复](maintenance.md#固定版本与回滚)，首次引入多网站的变化见 [1.0.0-alpha.1 发布说明](releases/v1.0.0-alpha.1.md)。

## 管理接口的网站范围

同一管理员会话可查看全部网站，也可使用网站路径限定范围：

```http
GET /api/admin/v1/orders?api_client_id=site_xxx
GET /api/admin/v1/sites/site_xxx/orders?payment_status=UNPAID
GET /api/admin/v1/sites/site_xxx/orders/{orderId}
GET /api/admin/v1/sites/site_xxx/webhooks/deliveries/{deliveryId}/attempts
```

网站路径只从 `:clientId` 确定范围，正文和查询中不能再传 `api_client_id`。其他网站资源返回 `404`；涉及共享流水冲突或跨网站证据的新财务操作返回 `409 / site_scope_conflict`，应在全局对账中处理。

管理员按商户订单号查单必须指定网站。订单详情、导出、通知、待处理、测试收款和财务操作均有网站范围，完整路径见 OpenAPI。例如人工关联：

```http
POST /api/admin/v1/sites/site_xxx/reconciliation/settlements/manual
Content-Type: application/json

{"financial_operation_id":"原操作 UUID","order_id":"本站订单 UUID","ledger_entry_id":"流水 UUID","reason":"核实依据"}
```

`GET /api/admin/v1/sites/overview?range=30&limit=20&q=网站名称` 返回分页网站概览。`q` 匹配网站名称或当前客户端 ID；`confirmed_count`、`confirmed_amount_cents` 按选定北京时间区间统计，`pending_orders`、`work_items` 反映当前状态。翻页标记只适用于当前搜索词和时间范围，切换条件后从第一页开始。要看全部网站总数，应读取全局概览，当前分页只包含部分网站。

`GET /api/admin/v1/work-items/summary` 可用稳定网站编号 `api_client_id` 筛选，返回 `{ "data": { "total": 0 } }`。总数包括全部 `ACTIVE` 提醒，不受首页显示条数、日期或分页限制；已忽略、已处理和已有后续重发任务的旧提醒不计入。无法确定所属网站的流水及冲突在全局页面查看。读取失败时应显示不可用，不能用全局总数代替本站结果。

## 创建网站

管理页面从已加载的默认模板复制策略，创建时通知关闭、来源留空。原生 API 和通知密钥通过独立操作生成；易支付凭据由系统初始化。

直接调用 API 时，`POST /api/admin/v1/sites` 提交 UUID `operation_id`、可选 `client_id` 和完整配置：

| `configuration` 字段 | 内容 |
| --- | --- |
| `name` | 网站名称。 |
| `accepting_orders` | 是否接受新订单。 |
| `notifications_enabled` | 初始设为 `false`，接收端与密钥配置完成后启用。 |
| `notification_origin`、`return_origin` | 对应 HTTPS 来源或 `null`。 |
| `collection` | 收款账号与 `FIXED/RANDOM/WEIGHTED` 分配方式。 |
| `policy.orders` | 有效期、最大加价、金额冷却、待付款上限。 |
| `policy.display` | 收银台名称、帮助链接、商品名展示开关。 |
| `policy.notification_delivery` | 通知超时、尝试次数、基础和最大重试间隔。 |

可以从 `GET /api/admin/v1/settings/site-defaults` 取得 `policy`。创建结果未知时，保留原 `operation_id`、客户端 ID 和完整配置重试。

更换接入 ID 使用 `POST /api/admin/v1/sites/:clientId/actions/change-client-id`，提交 `operation_id`、当前 `revision` 和新 `client_id`。同一操作重试保留原请求；成功响应的 `api_client_id` 为新的接入 ID。格式错误、保留名称、历史占用及版本冲突会返回字段错误或冲突响应。

## 两级后台与设置分组

“全部网站”后台汇总整套 PerPay 的数据；进入某个网站后，概览、订单、通知、待处理和设置均显示本站内容。顶部切换器可切换网站或返回全部网站，切换后打开对应的概览。系统设置、运行状态、支付宝流水和全局对账位于“全部网站”后台。

网站设置路径为 `/admin/sites/:clientId/settings/{basic,orders,integration,display}`，分别对应基本信息、订单设置、接入与通知、收银台展示。每组保存时提交完整配置和当前版本；冲突会保留草稿，供重新读取后核对。默认模板在一级网站管理中维护。

旧全局链接中的 `?api_client_id=...` 会转为网站路径，保留筛选条件，并从第一页开始显示。网站内的详情、列表、导出及财务操作都使用当前网站；从全局按商户订单号查单或测试收款时，需要先选择网站。已经提交的操作仍作用于原网站，切换网站不会再次发送该请求。
