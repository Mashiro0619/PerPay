<!-- SPDX-License-Identifier: MIT -->

# 开发导航

PerPay 在一个 Node.js 进程中提供管理 API、原生支付 API、易支付兼容接口和前端资源，用 SQLite 保存订单、流水和配置。进程内的定时任务负责查账、对账和发送通知，另一个独立进程负责自动备份。

按任务阅读：[前端开发](../../web/README.md) · [本地预览与截图](ui-verification.md) · [支付宝 SDK 与易支付设计](integration-epay-plan.md)。部署见[项目说明](../../README.md)，业务接入见 [USAGE](../../USAGE.md)。

## 开始开发

使用 [package.json](../../package.json) 中 `engines.node` 指定的 Node.js 版本范围。以下命令在仓库根目录执行。

```sh
npm ci
npm run build
npm run demo:preview -- --interactive
```

打开 `http://127.0.0.1:6192/admin/`，密码为 `123456`。可以在预览中编辑临时配置、查看生成的示例订单和通知记录。启动参数、怎样找到示例记录及退出后的清理方式见[本地预览](ui-verification.md#本地预览)；前端热更新见[开发与构建](../../web/README.md#开发与构建)。

需要运行真实后端时，先按[配置参考](../../README.md)准备独立数据目录、备份目录和主密钥，再执行 `npm run dev`。直接运行源码或 `node dist/main.js` 默认监听 `127.0.0.1:6190`，其他监听地址通过 `PERPAY_HOST` 设置。真实后端会启动已配置账号的查账和通知任务。

构建产物写入 `dist/`、`web-dist/`。预览数据库默认使用系统临时目录；需要自定义时，先创建目标目录，再在启动前设置 Linux/macOS 的 `TMPDIR`，或 Windows 的 `TEMP`、`TMP`。截图候选、日志和其他复核材料保存到独立工作目录，避免随构建产物一起清理。

## 从问题定位源码

| 开发任务 | 主要入口 | 先核对什么 |
| --- | --- | --- |
| 调整启动配置、任务启停 | [main.ts](../../src/main.ts)、[config.ts](../../src/config.ts)、[runtime/](../../src/runtime/) | 配置如何加载，账号启停或配置重载时如何处理正在执行的任务 |
| 修改路由、管理会话、鉴权 | [http/](../../src/http/)、[identity/](../../src/identity/)、[security/](../../src/security/) | OpenAPI、登录会话与 CSRF 检查，请求是否只访问所属网站的数据 |
| 修改下单与金额分配 | [orders/](../../src/orders/)、[order-store.ts](../../src/database/order-store.ts) | 重复请求是否返回原订单，应付金额是否已被占用，付款何时截止 |
| 修改支付宝请求和查账 | [infrastructure/alipay/](../../src/infrastructure/alipay/)、[ledger/](../../src/ledger/)、[alipay-accounts/](../../src/alipay-accounts/) | SDK 验签、原始响应保存、正常查账与历史补查进度 |
| 修改自动确认与人工处置 | [reconciliation/](../../src/reconciliation/) | 匹配的金额和时间，流水属于哪个账号，怎样撤销确认或处理争议 |
| 修改通知和易支付兼容 | [notifications/](../../src/notifications/)、[epay/](../../src/epay/)、[接入设计](integration-epay-plan.md) | 哪个订单事件触发通知，怎样签名、发送、接收回执和返回商家 |
| 修改网站和系统设置 | [sites/](../../src/sites/)、[settings/](../../src/settings/) | 固定网站编号、配置版本、密钥和默认设置 |
| 修改数据库、升级与备份 | [database/](../../src/database/)、[backup/](../../src/backup/) | 迁移校验和、兼容版本、密钥和恢复 |
| 修改审计查询 | [audit/](../../src/audit/)、[audit-routes.ts](../../src/http/audit-routes.ts) | 业务事件、活动记录及完整性 |
| 修改后台和收银台 | [web/src/](../../web/src/)、[checkout-view.ts](../../src/shared/checkout-view.ts) | [后台操作规则](../../web/README.md#后台交互约束)、允许向付款人公开的数据、截图效果 |

已有用例说明各类输入应得到什么结果，也包含构造测试数据的示例，可用 `rg --files test web/test ui-tests` 查找。HTTP 测试环境在 [http-fixture.ts](../../test/http-fixture.ts)，预览数据由 [preview-demo.ts](../../scripts/preview-demo.ts)生成。

## 业务数据流

1. 原生或易支付接口创建订单，订单服务选择收款账号、分配应付金额并生成收银台入口。
2. 查账服务验证支付宝响应，保存流水及其原始响应等来源记录；每个账号分别记录正常查账和历史补查进度。
3. 对账服务按金额、付款时间和来源将流水关联到订单；需要人工核对的情况进入待处理。
4. 订单事件触发通知任务，按网站所用协议发送回调，记录每次发送、重试和接收方的确认响应（回执）。

排查“付款后业务网站没有更新”时，先核对订单的收款确认，再检查通知投递和业务网站处理结果。字段来源、金额和状态用词见[术语表](../glossary.md)。

## 修改与验证

日常开发按改动选择类型检查、构建和人工核对。已有自动化套件继续在 CI 中运行，需要检查指定功能时再单独运行对应用例。

| 改动 | 日常核对 |
| --- | --- |
| 后台组件、页面或交互 | `npm run typecheck:admin`、`npm run build:admin`，在可编辑预览中核对相关操作 |
| 公开收银台或共用展示逻辑 | `npm run typecheck`、`npm run build:checkout`，重启后端后核对 SSR、交互及结束状态 |
| 服务端或业务逻辑 | `npm run typecheck:server`、`npm run build:server`，在独立实例中复现相关输入与结果 |
| API 字段、请求或错误码 | 修改 [openapi.yaml](../../openapi.yaml)，执行 `npm run api:types` 和 `npm run typecheck`，核对调用方与响应 |
| 文档、命令、链接或截图 | 对照当前实现检查命令和本地链接，执行 `git diff --check`，查看 Markdown 渲染 |
| 一批功能改动完成 | `npm run typecheck`、`npm run build`，按[手工核对项](ui-verification.md#日常手工核对)完成受影响流程 |

构建结束后再用浏览器检查。重新构建前先停止预览，完成后再启动，防止页面混用新旧构建文件。

`npm run check` 包含版本、OpenAPI、类型、Node/React 测试和服务端构建；`npm test` 会先构建后台与收银台。现有 CI、浏览器专项及容器恢复入口集中在[开发验证](ui-verification.md#现有-ci-与专项入口)。

<a id="契约与文档入口"></a>

## 接口规则与文档

- API 客户端生成到 `web/src/api/generated/`，通过 `npm run api:types` 更新。
- 数据库结构版本（schema）变化时新增一条[迁移](../../src/database/migrations.ts)，不要改写已发布迁移及其校验和。同时更新[版本兼容声明](../../src/version.ts)和升级说明，并用 `npm run check:version` 核对版本是否一致。
- 写入订单或收款记录时，保留数据库事务、幂等和网站／账号归属检查：同一操作不能重复记账，记录不能写到其他网站或账号下。收款确认、通知回执和管理员退款登记分别使用自己的状态；修改前先核对已有用例规定的成功、失败和重复请求行为。
- 部署、备份和恢复说明集中在[维护指南](../maintenance.md)，保存范围见[数据与隐私](../privacy.md)。使用者操作变化更新对应指南，待发布内容写入[待发布说明](../releases/unreleased.md)。
- 协议和 SDK 的接口规则及核对方法见[接入设计](integration-epay-plan.md)、[支付宝 SDK 接口检查](../../scripts/validation/alipay-sdk/README.md)与[易支付客户端兼容检查](../../scripts/validation/epay/README.md)。
