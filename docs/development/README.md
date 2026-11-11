<!-- SPDX-License-Identifier: MIT -->

# 开发导航

PerPay 在一个 Node.js 进程内提供管理 API、原生支付 API、易支付兼容接口和前端资源，SQLite 保存业务状态。查账、对账和通知由进程内任务调度，自动备份由独立进程运行。本文用于定位源码和选择验证范围；部署见[项目说明](../../README.md)，接入契约见[USAGE](../../USAGE.md)。

## 开始开发

Node.js 版本以 [package.json](../../package.json) 的 `engines.node` 为准。以下命令在仓库根目录执行：

```sh
npm ci
npm run build
npm run demo:preview -- --interactive
```

访问 `http://127.0.0.1:6192/admin/`，密码为 `123456`。预览使用临时库和合成数据，允许修改后台配置；支付宝和业务通知使用离线实现。前端热更新见[前端开发](../../web/README.md#开发与构建)，浏览器及 Linux 验证见[开发验证](ui-verification.md)。

直接运行源码或 `node dist/main.js` 时，默认监听 `127.0.0.1:6190`。需要其他监听地址时显式设置 `PERPAY_HOST`。Docker 镜像设置 `PERPAY_HOST=0.0.0.0`，标准 Compose 将宿主端口绑定到 `127.0.0.1`，供宿主反向代理或本机访问。

测试夹具和预览通过系统临时目录创建数据库。需要指定磁盘时，在启动 Node 前设置 `TMPDIR`（Linux/macOS）或 `TEMP`、`TMP`（Windows），并确保目录已经存在。构建输出为 `dist/`、`web-dist/`。

## 从问题定位源码

| 要改什么 | 入口 | 配套验证 |
| --- | --- | --- |
| 启动、运行配置、任务启停 | [`src/main.ts`](../../src/main.ts)、[`src/config.ts`](../../src/config.ts)、[`src/runtime/`](../../src/runtime/) | `config`、`runtime-controller`、`multi-account-runtime` |
| HTTP 路由、管理会话、公开接口 | [`src/http/app.ts`](../../src/http/app.ts)、[`src/http/`](../../src/http/)、[`src/identity/`](../../src/identity/)、[`src/security/`](../../src/security/) | 对应 `*-http` 用例及 `http` |
| 下单、应付金额分配、付款截止 | [`src/orders/`](../../src/orders/)、[`src/database/order-store.ts`](../../src/database/order-store.ts) | `order-model`、`order-store`、`order-service` |
| 支付宝请求与账单采集 | [`src/infrastructure/alipay/`](../../src/infrastructure/alipay/)、[`src/ledger/`](../../src/ledger/)、[`src/alipay-accounts/`](../../src/alipay-accounts/) | `alipay-provider`、`ledger-service`、`ledger-scheduler` |
| 自动确认、异常、人工关联 | [`src/reconciliation/`](../../src/reconciliation/) | `reconciliation-*`、`manual-settlement-*` |
| 通知签名、重试和送达状态 | [`src/notifications/`](../../src/notifications/) | `notifications-*`、`webhook-*` |
| 网站、配置和易支付 | [`src/sites/`](../../src/sites/)、[`src/settings/`](../../src/settings/)、[`src/epay/`](../../src/epay/) | `site-*`、`settings-*`、`epay-*` |
| 数据库、升级、备份与恢复 | [`src/database/`](../../src/database/)、[`src/backup/`](../../src/backup/) | `database-*`、`backup-*`、`restore-*` |
| 审计查询与活动记录 | [`src/audit/`](../../src/audit/)、[`src/http/audit-routes.ts`](../../src/http/audit-routes.ts) | `audit-*`、`activity-*` |
| 后台页面、收银台和交互 | [`web/src/`](../../web/src/)、[`src/shared/checkout-view.ts`](../../src/shared/checkout-view.ts) | [`web/test/`](../../web/test/)、[`ui-tests/`](../../ui-tests/)；见[前端开发](../../web/README.md) |

上表验证名称对应 `test/<名称>.test.ts`，`*` 表示同类用例。先用 `rg --files test web/test ui-tests` 找到相关测试，再阅读已有夹具；HTTP 测试常用 [`test/http-fixture.ts`](../../test/http-fixture.ts)，界面预览由 [`scripts/preview-demo.ts`](../../scripts/preview-demo.ts) 建立。

## 业务数据流

1. 原生或易支付接口创建订单，由订单服务选取收款账号、分配应付金额并生成收银台入口。
2. 查账服务取得支付宝账单，写入流水和来源证据；调度器维护各账号的查账进度。
3. 对账服务将符合条件的流水关联到订单，记录收款状态变化；需要人工核对的情况进入待处理。
4. 通知任务根据业务事件发送对应网站的签名回调，记录接收方确认、重试或失败。

收款状态和通知状态分别保存。排查“付了款但网站没到账”时，先看订单是否已确认，再看通知投递记录；界面的统一术语见[文案术语表](../glossary.md)。

## 修改与验证

| 改动 | 执行方式 |
| --- | --- |
| 单个服务或领域逻辑 | `node --experimental-strip-types --test test/order-service.test.ts`，替换为相关文件 |
| 单个组件或交互 | `npm run test:admin -- test/format.test.ts`，文件路径相对 `web/` |
| API 字段、请求或错误码 | 修改 [`openapi.yaml`](../../openapi.yaml)，执行 `npm run api:types`、对应 HTTP 测试及 `npm run typecheck` |
| 文档、命令和本地链接 | `node --experimental-strip-types --test test/documentation.test.ts`；维护命令变化还运行 `test/maintenance-docs.test.ts` |
| 前端布局或浏览器行为 | 构建后运行对应 Playwright 用例，步骤见[浏览器回归](ui-verification.md#浏览器回归) |
| 一批改动完成 | `npm run check`：版本、生成接口、类型、Node/React 测试和服务端构建 |

`npm test` 会先构建后台与收银台。Node 测试最多同时运行 4 个文件，控制数据库夹具和密码校验的内存占用。直接运行 `npm run test:node` 或单个 HTTP 测试时，应先完成所需前端构建。浏览器验收与重建前端按顺序执行，避免用例读取正在替换的构建文件。

新增回归应复现具体缺陷并检查可观察结果。纯文案或间距修改通常沿用现有验证；不为锁定一句解释、一组 CSS 类或私有函数拆分新增测试。签名向量、数据库升级、恢复及财务写入用例保留其业务断言。

## 契约与文档入口

- API 客户端来自 OpenAPI，生成目录为 `web/src/api/generated/`；通过 `npm run api:types` 更新。
- 数据库升级入口为 [`migrations.ts`](../../src/database/migrations.ts)，版本和兼容范围在 [`src/version.ts`](../../src/version.ts)；已有迁移有校验和。结构变化需新增迁移并同步版本及升级说明，运行 `npm run check:version`。
- 部署和恢复规则集中在[维护说明](../maintenance.md)，数据保存规则集中在[数据与隐私](../privacy.md)。使用者操作变化应更新对应指南，待发布功能写入[待发布说明](../releases/unreleased.md)。
- 易支付实现的协议选择和联调结果见[SDK 与网站接入记录](integration-epay-plan.md)，现行接入步骤见[易支付指南](../epay-integration.md)。
