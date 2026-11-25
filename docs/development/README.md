<!-- SPDX-License-Identifier: MIT -->

# 开发导航

单进程 Node.js（Hono + SQLite）承载管理 API、原生支付 API、易支付兼容接口与前端静态/SSR 资源；进程内调度器驱动查账、对账与通知投递，独立备份进程负责定期快照。

相关工程文档：[前端开发](../../web/README.md) · [开发验证与回归](ui-verification.md) · [支付宝 SDK 与易支付设计](integration-epay-plan.md) · [术语与字段词典](../glossary.md)

外部文档：[项目说明](../../README.md) · [接口与运维参考](../../USAGE.md)

## 开始开发

Node.js 版本须满足 [package.json](../../package.json) 中的 `engines.node`。以下命令在仓库根目录执行：

```sh
npm ci
npm run build
npm run demo:preview -- --interactive
```

- **本地可编辑预览**：访问 `http://127.0.0.1:6192/admin/`（密码 `123456`），运行于独立临时库与模拟查账/通知环境。参数、日志定位及清理见[本地预览](ui-verification.md#本地预览)；前端 HMR 见[开发与构建](../../web/README.md#开发与构建)。
- **真实后端运行**：先按[配置参考](../../README.md)配置独立 `PERPAY_DATA_DIR`、`PERPAY_BACKUP_DIR`、`PERPAY_MASTER_KEY` 等环境变量，再运行 `npm run dev` 或 `node dist/main.js`（默认监听 `127.0.0.1:6190`，通过 `PERPAY_HOST` 覆盖）。注意真实后端会立即启动已配置账号的查账与通知任务。
- **产物与临时目录**：编译输出写入 `dist/`、`web-dist/`；预览库默认落在系统临时目录（可提前创建目录并通过 Linux/macOS `TMPDIR` 或 Windows `TEMP`/`TMP` 指定）。截图、日志与复核材料应放在独立工作目录，避免被重新构建清理。

## 源码导航与关键不变量

| 变更域 | 源码入口 | 修改前必查不变量 |
| --- | --- | --- |
| 启动配置与运行时生命周期 | [main.ts](../../src/main.ts)、[config.ts](../../src/config.ts)、[runtime/](../../src/runtime/) | 配置解析、账号启停与配置重载时对在途任务（in-flight）的取消/排空处理 |
| 路由、会话与安全边界 | [http/](../../src/http/)、[identity/](../../src/identity/)、[security/](../../src/security/) | OpenAPI 契约、Session + CSRF + IP 白名单校验、站点/账号租户隔离 |
| 下单与应付金额分配 | [orders/](../../src/orders/)、[order-store.ts](../../src/database/order-store.ts) | 幂等重放（返回原订单或冲突）、应付金额占用与复用冷却、付款截止边界 |
| 支付宝 SDK 与账本采集 | [infrastructure/alipay/](../../src/infrastructure/alipay/)、[ledger/](../../src/ledger/)、[alipay-accounts/](../../src/alipay-accounts/) | SDK 验签流程、原始响应落库上限、正常查账与历史补扫的双轨游标 |
| 自动对账与人工处置 | [reconciliation/](../../src/reconciliation/) | 金额/时间窗/来源账号匹配条件、确认撤销与争议状态流转 |
| 回调通知与易支付兼容 | [notifications/](../../src/notifications/)、[epay/](../../src/epay/)、[接入设计](integration-epay-plan.md) | 触发事件类型、协议签名与验签、租约/退避重试、回执判定与同步跳转 |
| 业务网站与系统设置 | [sites/](../../src/sites/)、[settings/](../../src/settings/) | 不可变 `client_id`、乐观锁 `config_version`、密钥轮换与默认模板继承 |
| SQLite Schema、升级与备份 | [database/](../../src/database/)、[backup/](../../src/backup/) | 迁移校验和不可变性、版本兼容范围、主密钥加密与恢复一致性 |
| 审计日志与完整性 | [audit/](../../src/audit/)、[audit-routes.ts](../../src/http/audit-routes.ts) | 业务事件/活动记录模型、哈希链与 spool 落盘恢复 |
| 后台 SPA 与公开收银台 | [web/src/](../../web/src/)、[checkout-view.ts](../../src/shared/checkout-view.ts) | [后台交互约束](../../web/README.md#后台交互约束)、收银台公开数据白名单、SSR/Hydration 一致性 |

测试资产与夹具定位：运行 `rg --files test web/test ui-tests`；HTTP 集成测试夹具见 [http-fixture.ts](../../test/http-fixture.ts)，演示数据生成器见 [preview-demo.ts](../../scripts/preview-demo.ts)。

## 核心数据流

```text
[原生 / 易支付下单]
  └─> OrderService：选定收款账号 -> 分配唯一应付金额 -> 生成收银台令牌 -> 落库
        │
[账本采集调度]
  └─> Alipay SDK Adapter：拉取账单 -> 保存原始响应 -> SDK 验签 -> 写入 ledger（正常游标 / 补扫游标分离）
        │
[对账引擎]
  └─> Reconciliation：按金额 + 付款时间 + 来源账号唯一匹配 -> 确认收款（歧义/异常进入待处理队列）
        │
[通知调度]
  └─> NotificationWorker：按订单确认事件生成投递 -> 按网站协议签名发送 -> 记录回执 / 退避重试
```

排障顺序（“已付款但下游未更新”）：先查订单的**收款确认记录**（排除未入账/异常队列），再查**通知投递日志与回执**，最后核对业务侧验签与幂等履约。字段来源、单位与状态定义见[术语表](../glossary.md)。

## 修改与验证矩阵

日常开发按改动面执行对应的类型检查、构建与手工核对；重建前先停止旧预览，防止前后端产物版本混用。

| 改动范围 | 必跑命令 | 核对重点 |
| --- | --- | --- |
| 后台组件 / 页面 / 交互 | `npm run typecheck:admin && npm run build:admin` | 在可编辑预览中实操受影响流程 |
| 收银台或共享公开模型 | `npm run typecheck && npm run build:checkout` | 重启后端，验证 SSR 首屏、Hydration、无脚本降级及终态 |
| 服务端 / 业务逻辑 | `npm run typecheck:server && npm run build:server` | 跑对应单测或在独立实例复现输入/边界输出 |
| OpenAPI 字段 / 错误码 | 编辑 [openapi.yaml](../../openapi.yaml) → `npm run api:types && npm run typecheck` | 检查 `web/src/api/generated/` diff 及前后端调用方 |
| 文档 / 命令 / 链接 / 截图 | `git diff --check` | 核对命令与代码一致、相对路径/锚点有效、Markdown 渲染正常 |
| 批量功能收口 | `npm run typecheck && npm run build` | 按[日常手工核对](ui-verification.md#日常手工核对)过一遍受影响路径 |

- `npm run check`：聚合版本一致性、OpenAPI、类型检查、Node/React 测试与服务端构建。
- `npm test`：会先构建后台与收银台再执行测试。
- CI 流水线、Playwright 套件及 Linux 升级/崩溃恢复验证见[开发验证](ui-verification.md#现有-ci-与专项入口)。

<a id="契约与文档入口"></a>

## 强约束与契约维护

- **OpenAPI 单一事实来源**：修改接口后必须通过 `npm run api:types` 重新生成 `web/src/api/generated/`，不要手改生成目录。
- **数据库迁移不可变**：Schema 变更时必须在 [migrations.ts](../../src/database/migrations.ts) 追加新迁移，**严禁改写已发布迁移及其校验和**；同步更新 [src/version.ts](../../src/version.ts) 的兼容范围及升级文档，并用 `npm run check:version` 校验。
- **财务写入原子性与状态分离**：订单/账本/对账写入必须保持数据库事务、幂等键与站点/账号归属校验（防跨站越权与重复记账）。**收款确认状态**、**通知回执状态**与**管理员外部退款标记**是三条独立状态线，严禁混用；改动前先核对既有测试对成功、失败与重复重放的断言。
- **跨文档同步**：部署/备份/恢复变更同步[维护指南](../maintenance.md)；落盘与留存范围变更同步[数据与隐私](../privacy.md)；未发布变更记录到[待发布说明](../releases/unreleased.md)。
- **协议与外部 SDK 验证**：详见[接入设计](integration-epay-plan.md)、[支付宝 SDK 验证](../../scripts/validation/alipay-sdk/README.md)与[易支付客户端兼容验证](../../scripts/validation/epay/README.md)。
