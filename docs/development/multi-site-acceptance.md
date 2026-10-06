<!-- SPDX-License-Identifier: MIT -->

# PerPay 1.0.0 多网站验收记录

核对日期：2026-10-06。开发分支：`feat/1.0.0`，基线：`v0.3.2`。应用版本 1.0.0，schema 34，兼容范围 24—34。

本文对照已确认工作计划记录实现与自动化证据，不替代[接入指南](../multi-site.md)或[升级说明](../releases/v1.0.0.md)，也不表示已经发布。

两级后台的追加验收、真实浏览器截图和当前验证结果见[一级汇总与二级网站后台](admin-workspaces.md)。下文保留多网站模型交付时的历史记录。

## 逐项验收

下表中的路径均相对仓库根目录。相关测试已纳入全量测试命令；“集成”指本地真实 Hono／SQLite／运行时组件，外部支付宝和通知网络由测试替身控制。

| 原计划验收项 | 已核对行为 | 主要证据 |
| --- | --- | --- |
| 1. 权限隔离 | 验签决定网站身份；跨站查询、关闭和事件读取不泄露资源；相同订单号、幂等键和 nonce 分站使用；正文不能指定归属。 | `test/site-http.test.ts`、`test/site-admission-concurrency.test.ts`、`test/site-notification-view.test.ts` |
| 2. 配置隔离 | 完整网站配置与模板独立版本；模板变化不改已有网站；网站配置和密钥变化不替换共享引擎，删除迁移网站也无默认回退。 | `test/site-model.test.ts`、`test/site-store.test.ts`、`test/split-settings.test.ts`、`test/site-checkout-runtime.test.ts`、`web/test/sites.test.tsx` |
| 3. 设置拆分 | 应用、经营码、采集策略各自保存；实例响应不再携带网站配置或业务密钥；旧混合字段拒绝，旧业务入口返回迁移错误；向导创建网站后正确刷新状态。 | `test/split-settings.test.ts`、`test/site-http.test.ts`、`test/settings-http.test.ts`、`web/test/instance-settings.test.tsx`、`test/maintenance-docs.test.ts` |
| 4. 生命周期 | 暂停仅限制新订单，旧单仍可核实；通知关闭保留事件、恢复继续处理；删除与创建订单串行化，保留墓碑；审计失败整体回滚。 | `test/site-orders.test.ts`、`test/site-admission-concurrency.test.ts`、`test/site-store.test.ts`、`test/site-notifications.test.ts`、`test/site-checkout-runtime.test.ts` |
| 5. 财务安全 | 两站共享完整应付金额池；遵守上一订单的冷却快照；较短网站冷却不能提前复用；精确边界优先复用最小金额。 | `test/site-orders.test.ts`、`test/site-admission-concurrency.test.ts`、`test/order-store.test.ts` |
| 6. 幂等与容量 | 并发签名下单不超各站额度；重复创建先重放后检查暂停和额度；来源变更不重解释历史请求；到期但尚为 OPEN 的订单不占额度；轮换期间复核旧凭据。 | `test/site-admission-concurrency.test.ts`、`test/site-orders.test.ts` |
| 7. 通知隔离 | 按站密钥验签、站间轮转、各站重试预算、在途签名快照及下一次轮换密钥正确；关闭恢复和来源变化不串站；保留租约、ACK 和人工重投保护。 | `test/site-notifications.test.ts`、`test/site-notification-view.test.ts`、`test/notifications-store.test.ts`、`test/webhook-service.test.ts` |
| 8. 迁移后读取侧 | 从真实 schema 33 夹具启动迁移，创建第二网站；两站分别对账、投递并验证 ACK，轮换两类业务密钥；连续两次关闭／重新打开数据库后，再分别投递验签并检查完整性。 | `test/site-startup.test.ts` 中 `upgrades an old instance, delivers and rotates both websites, then repeats delivery across two consecutive restarts` |
| 9. 历史不变 | 逐行比较历史订单、槽位、会话、二维码、事件、nonce、密钥标识及通知证据；轮换不改旧尝试内部引用；重启不重写历史。 | `test/site-startup.test.ts`、`test/site-migration.test.ts`、历史迁移及 `test/database-recovery.test.ts` |
| 10. 错误关联 | 网站／用途／版本／实例密文替换无法解密；跨站通知密钥插入被数据库约束拒绝；人为绕过更新防护后的错误归属被严格完整性检查识别。 | `test/site-crypto.test.ts`、`test/site-store.test.ts`、`test/site-notifications.test.ts` |
| 11. 迁移恢复 | 新装无隐藏网站；旧网站无密钥时不补发；错误／缺少主密钥和第二把密钥重加密中途失败完整回滚，可重试；备份恢复及原有维护、租约、文件安全回归通过。 | `test/site-startup.test.ts`、`test/site-migration.test.ts`、`test/database-recovery.test.ts`、`test/database-maintenance.test.ts`、`test/database-startup-lease.test.ts`、`test/database-backup-lifecycle.test.ts`、`test/backup-*.test.ts` |
| 12. 公开与业务接口 | 按订单归属读取收银台展示；跨站核实合并成一轮采集，受 8 秒活跃／5 秒最小间隔保护并等待对账；进度不串单；业务状态只含本站五个字段，站点配额不使共享 readyz 失效。 | `test/site-http.test.ts`、`test/site-checkout-runtime.test.ts`、`test/site-admission-concurrency.test.ts`、`test/checkout-check-http.test.ts`、`test/checkout-verification.test.ts`、`web/test/checkout-lifecycle.test.ts` |
| 13. 完整交付验证 | 版本、OpenAPI 生成类型、契约测试、前后端类型检查、全量测试及前后端构建通过；演示和示例显式使用网站身份。 | `npm run check`、`npm run build`；`test/openapi-error-contract.test.ts`、`test/preview-demo.test.ts`、示例相关回归 |

### 管理界面与查询补充

- 网站列表搜索、创建、编辑、暂停、密钥生成／查看／轮换、删除及默认模板编辑：`web/test/sites.test.tsx`。失败保留草稿，不在网络恢复时自动重放。
- 网站名称、来源、待付款上限及收银台字段均显示字段级错误；保存和轮换后回访读取最新配置版本，删除后移除编辑缓存；明文密钥不进入查询缓存。
- 隐藏密钥后，晚到的查看／轮换响应不再显示明文；隐藏不撤销已提交轮换，操作结束前保持忙碌并保留完成后的新版本：`web/test/site-secret-lifecycle.test.tsx`。
- 通知列表、独立详情和订单内通知记录显示网站名称与客户端 ID：`web/test/notification-sites.test.tsx`、`test/site-notification-view.test.ts`。名称变化只改变管理员展示，不改历史通知正文和签名证据。
- 分站订单、导出、统计、通知和可归属待办：`test/site-http.test.ts`、`test/site-notifications.test.ts`、`test/admin-work-items.test.ts`、`test/admin-reminder-notifications.test.ts` 及前端待办回归。未归属或全局冲突不伪造为本站零值。
- 首页统计卡片也保持网站范围，待办总数由独立的只读汇总接口按完整 ACTIVE 视图统计，不按四条预览计数；失败显示未知，卡片跳转保留网站筛选：`web/test/dashboard-sites.test.tsx`、`test/admin-work-items.test.ts`。管理员系统状态仍使用原有全局口径及缓存。
- 管理员测试收款明确选择网站，未决操作保留原网站、请求及操作 ID：`test/test-payment-http.test.ts`、`web/test/test-payment*.test.tsx`。

## 自动化结果

环境为 Windows、Node.js 24.15.0、npm 12.0.2。完整补充回归后：

| 检查 | 结果 |
| --- | --- |
| 后端 Node 测试 | 1038 项：1035 通过、0 失败、3 跳过 |
| 前端 Vitest | 87 个文件、1093 项通过、0 失败 |
| 版本一致性 | 1.0.0，通过 |
| OpenAPI 生成类型及 API 契约回归 | 通过 |
| 服务端、管理端 TypeScript | 通过 |
| 管理端、收银台客户端／SSR、服务端构建 | 通过 |
| Git 差异与提交范围检查 | 通过 |

3 项跳过是 Windows 上不适用的既有 POSIX 权限测试，不算作通过。

可复现命令：

```sh
npm run check
npm run build
git diff --check
```

`check` 包含版本、生成类型、双端类型检查、测试前管理端／收银台构建、全量双端测试与服务端构建。也分别执行过后端 `node --experimental-strip-types --test --test-isolation=process test/**/*.test.ts test/**/*.test.mjs` 和前端 `node node_modules/vitest/vitest.mjs run --config web/vite.config.ts`。

## 收尾提交

基础功能已在本开发分支原子提交；`20b446e` 完成 schema 34 的正式启用与原有回归适配。本轮补充：

| 提交 | 内容 |
| --- | --- |
| `0486aec` | 通知网站标识、网站字段错误反馈、管理员投影契约与生成类型及回归 |
| `5868909` | 网站保存／轮换后的编辑缓存一致性及删除缓存清理；不缓存明文密钥 |
| `f1fabf4` | 并发准入、删除竞争、冷却边界及跨站共享采集核实回归 |
| `63baace` | 重加密中途回滚、审计失败回滚及跨站通知密钥约束回归 |
| `0ecef65` | 旧库升级、双站投递与轮换、连续两次重启的组合回归 |

`7528fce` 清理开发记录中过时的“等待接线”描述，纠正使用指南中的旧全局通知接口、旧采集设置入口和请求形状，并补充文档契约检查。后续完整 review 通过 3 条临时回归发现密钥隐藏竞态和首页卡片范围遗漏；`db0ba9e` 修复前者，本次首页修复提交补齐后者及永久回归。完整原子提交以 `git log v0.3.2..feat/1.0.0` 为准；没有重写已有提交。

## 验证边界与升级注意事项

- 本次完成的是代码、文档和上述本地自动化验收。React/jsdom 测试不等于真实浏览器视觉验收；数据库重新打开测试不冒充容器升级演练。
- 没有发起真实支付宝支付或查询，也没有对外发送真实通知；共享调度和签名投递使用受控上游／传输替身。
- 没有执行 Linux／Docker Compose 部署验收、远程 CI 或生产环境验证。计划之外的真实环境验收应在明确授权和隔离数据下另行安排。
- 没有合并主分支、推送、创建标签、发布或部署。1.0.0 文档中的镜像名称为目标版本，不代表镜像已经存在。
- 没有修改或提交本地多网站评估记录、安全审计报告，也未改写已发布的 0.3.2 版本说明。
- 升级需先停止 app 和 backup，保存升级前备份及原主密钥；应用与维护工具必须匹配 schema 34。不能直接用旧程序打开新库；回退必须恢复升级前备份，不能覆盖或丢弃升级后产生的新交易。
