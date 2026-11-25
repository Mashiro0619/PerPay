<!-- SPDX-License-Identifier: MIT -->

# 前端开发

后台 SPA 与公开收银台基于 React、Vite、shadcn/ui 与 Base UI（样式预设 Nova / Neutral），生产环境由 Hono 托管静态产物与收银台 SSR。

配套文档：[开发导航](../docs/development/README.md) · [业务接口参考](../USAGE.md) · [术语与字段词典](../docs/glossary.md) · [README 截图规范](../docs/development/ui-verification.md#readme-截图)

- **路由基址**：后台入口为 `/admin/`（与 Vite `BASE_URL` 对齐）。`/` 重定向到 `/admin/`；`/admin` 重定向到 `/admin/` 并保留 QueryString；后台子路由直链由服务端回退至 SPA HTML，前端路由接管渲染。
- **信息架构**：配置向导按“支付宝账号 → 业务网站 → 试收款”分层；收款码与应用密钥归属支付宝账号，订单规则/通知/业务密钥归属业务网站，查账/备份/外观/管理员安全集中于系统设置；旧单账号设置路径自动重定向到新入口。

## 目录结构

以下路径均相对仓库根目录：

| 路径 | 职责 |
| --- | --- |
| `components.json`、`web/src/components/ui/` | shadcn 配置与 Base UI 封装基础组件 |
| `web/src/components/`、`web/src/pages/` | 后台业务组件与页面视图 |
| `web/src/lib/`、`web/src/hooks/` | 路由状态、数据拉取、脏表单守卫与页面通用 Hook |
| `web/src/api/generated/` | OpenAPI 生成的强类型 API 客户端（禁止手改） |
| `web/src/checkout/`、`src/shared/checkout-view.ts` | 收银台 SSR、客户端 Hydration、轮询状态机及公开字段白名单 |
| `src/http/web/`、`src/shared/branding.ts` | HTML 模板、Manifest 资产加载、品牌名安全转义 |
| `web/src/styles.css` | 后台样式入口（Tailwind v4 自动扫描后台目录） |
| `web/src/styles/theme.css`、`web/src/styles/primitives.css` | 后台与收银台共享的设计 Token、控件与弹窗样式 |
| `web/src/checkout/styles.css`、`web/src/checkout/checkout-layout.css` | 收银台独立样式入口（显式 `@source`）与布局 |
| `web/public/theme.js` | 首屏同步主题注入脚本（防闪烁） |
| `web/test/`、`test/`、`ui-tests/` | React 组件测试、服务端测试与 Playwright 回归 |

## 开发与构建

Node.js 版本见 [package.json](../package.json) 的 `engines.node`。根目录启动可编辑预览与 Vite HMR：

```sh
# 终端 1：构建并启动临时预览后端（http://127.0.0.1:6192）
npm ci
npm run build
npm run demo:preview -- --interactive
```

```sh
# 终端 2（Linux/macOS）：启动后台 Vite 开发服务器（http://127.0.0.1:6191/admin/，密码 123456）
PERPAY_DEV_API_URL=http://127.0.0.1:6192 npm run dev:admin
```

```powershell
# 终端 2（Windows PowerShell）
$env:PERPAY_DEV_API_URL = 'http://127.0.0.1:6192'
npm run dev:admin
```

- **对接真实后端**：配置独立 `PERPAY_DATA_DIR`、`PERPAY_BACKUP_DIR`、`PERPAY_MASTER_KEY`、`PERPAY_PUBLIC_URL` 后执行 `npm run dev`（Vite 默认代理 `http://localhost:6190`）。注意真实后端会激活查账与通知调度。
- **Bootstrap 与收银台 SSR**：Vite 开发期从后端 HTML 注入读取初始化状态与公开品牌名称（读取失败展示重试入口）。公开收银台由 Hono SSR 生成首屏再由客户端 Hydration 接管，改动后须执行 `npm run build:checkout` 并重启后端。

### 构建与校验命令

| 改动面 | 命令 | 备注 |
| --- | --- | --- |
| 后台组件 / 页面 | `npm run typecheck:admin && npm run build:admin` | 在可编辑预览中核对交互 |
| 收银台 / 公开 ViewModel | `npm run typecheck && npm run build:checkout` | 重启后端核对 SSR 与 Hydration |
| OpenAPI 契约变更 | `npm run api:types && npm run typecheck` | 更新 `web/src/api/generated/` |
| UI 测试夹具维护 | `npm run typecheck:ui` | 回归入口见[浏览器回归](../docs/development/ui-verification.md#浏览器回归) |
| 全量构建 | `npm run build` | 依次构建后台、收银台、私有 SSR bundle 与服务端 |
| Node Demo 打包 | `npm run demo:package` | 详见 [Node Demo](../examples/node-client/README.md) |

- **产物隔离**：产物输出至 `dist/` 与 `web-dist/`。服务端按 `web-dist/admin/` 与 `web-dist/checkout/` 的 Manifest 下发静态资源；`web-dist/checkout-ssr/renderer.cjs` 仅服务端私有加载；源码、source map 与 manifest 文件均不对外暴露。截图等过程材料请置于独立目录。
- **自动化套件**：`npm run check` 包含 Node/React 测试；完整 CI 与按需验证入口见[开发验证](../docs/development/ui-verification.md#现有-ci-与专项入口)。

## 浏览器支持

| 浏览器 | 最低支持版本 |
| --- | --- |
| Chrome / Chromium Edge | 111 |
| Safari / iOS Safari | 16.4 |
| Firefox | 128 |

基线对齐 [Tailwind CSS 4 浏览器兼容性](https://tailwindcss.com/docs/compatibility#browser-support)与 [Vite 8 构建兼容说明](https://v8.vite.dev/guide/build#browser-compatibility)。[后台](vite.config.ts)与[收银台](vite.checkout.config.ts)统一采用 `build.target: "es2022"`。引入新 Web API 或 CSS 特性时必须满足上表基线或提供降级方案；Playwright 仅覆盖 Chromium，涉及 Safari/Firefox/内置 WebView 或移动端行为的改动需在目标环境实测。

## 组件与样式维护

- **Base UI / shadcn 规范**：生产与构建直接消费仓库内组件，Props、键盘与焦点行为以 `web/src/components/ui/` 为准；维护时对齐 [components.json](../components.json) 的 `base-nova` 预设，不得破坏 Base UI 的焦点管理、键盘导航和弹窗语义。
- **Vendored 样式**：`web/src/vendor/shadcn-tailwind.css` 锁定上游样式（版本、校验和与许可记录于 [NOTICE](../NOTICE)），升级时需同步更新记录及样式校验；shadcn CLI 仅作离线维护工具，不进入运行/构建依赖。
- **收银台样式隔离**：`web/src/checkout/styles.css` 独立编译，仅扫描收银台目录及显式列出的共享组件。向收银台新增共享组件时**必须同步更新该文件中的 `@source`**；公共 Token 与基础样式改在 `web/src/styles/` 并同时回归后台与收银台。

<a id="后台交互约束"></a>

## 后台交互与安全不变量

修改后台或收银台前，以下工程约束必须全部保持成立：

### 1. 站点身份与多租户隔离
- 管理接口路径 `/sites/:clientId` 使用**不可变内部网站编号**，服务端强校验资源归属；公开客户端 ID 允许轮换。
- `selected_site` 仅用于记忆全局页面的当前选择，**严禁**作为 API 筛选条件、写入目标或权限依据。
- 切换网站后，旧站点的查询缓存、迟到响应（stale response）与待确认写操作仍绑定旧站点，严禁串写或污染新站点视图。

### 2. Overlay 详情路由与焦点栈
- 打开详情 Overlay 时保留底层列表的筛选、排序与分页状态；URL 通过 `overlay` 参数记录编码后的内部详情路径（如 `/admin/orders?payment=UNPAID&overlay=%2Forders%2Fexample-order`）。
- 新增 Overlay 类型必须登记其路由、允许的来源页与站点范围，由 `OverlayHost` 统一承载。
- 关闭 Overlay 返回仍有效的源页面，并将键盘焦点精准还原至触发控件；刷新页面按 URL 参数重建列表与 Overlay；`Escape` 仅关闭最顶层弹层。

### 3. 草稿保护、并发与乐观锁
- 编辑同一记录时，切换内部分组不得丢失未保存草稿；关闭、切记录、浏览器后退与离开页面共用同一套未保存检查守卫。
- 刷新失败保留用户输入；遇到 `config_version` 乐观锁冲突时，必须先重新拉取并核对最新配置后再保存。
- 仅在服务端明确确认网站已删除后，才清空该站点编辑器与易支付助手草稿、移除旧选择并回到列表；取消或删除失败时保留草稿；易支付助手处于保存中时阻止删除。

### 4. 不确定结果（Ambiguous Outcome）与幂等重试
- 财务写入或配置保存必须保留原始 payload、乐观锁版本与 `operation_id` 幂等键，用于后续核查或安全重试。
- 请求超时、连接中断或响应体截断**均不代表服务端未执行**；网络恢复后允许自动恢复读请求，但**写请求严禁自动重试**，必须由用户明确触发。
- 账号、网站、默认模板与管理员白名单编辑若挂起超过 `20s` 允许关闭弹窗，同时保留草稿与原版本，引导用户重新读取核对；密码修改结果不明时以重新登录验证为准；会话撤销一旦成功即结束交互，列表刷新退居后台。
- 登录态失效时立即清空所有受保护内存数据，并丢弃旧会话的迟到响应。

### 5. 密钥按需读取与权限边界
- 密钥明文仅在用户显式触发查看后按需请求，**严禁进入常规查询缓存**；关闭查看弹窗、标签页切后台（`visibilitychange`）或会话失效时立即清除内存中的明文。
- 仅当服务端明确返回 `initialized=false` 时才渲染管理员初始化流。
- 所有写接口始终受 Session、CSRF Token、IP 白名单与服务端业务规则四重保护。

### 6. 数据展示、无障碍与动效
- 列表搜索、排序、分页全部由服务端执行；移动端卡片保留网站、单号、字段标签、状态与关键操作。
- 金额、单号、时间戳须标明来源（见[术语表](../docs/glossary.md)）；缺失/不确定值保持“未知”；刷新期间暂留旧数据时同步保留其查询时间区间；**收款确认**、**通知回执**、**外部退款标记**分栏展示。
- 语义化使用按钮、链接、Tabs 与表单组件，纯图标按钮必须具备可访问名称；弹窗提交关联表单，校验失败定位并聚焦到错误字段；长文本可折行、矮视口正文可滚且标题/操作栏可达。
- 复用公共容器、语义色 Token 与基础组件样式；切断点/主题/布局时不重置编辑器状态；同一 CSS 属性只受单一动画驱动，严格尊重 `prefers-reduced-motion`。

### 7. 公开收银台契约
- 仅读取 `src/shared/checkout-view.ts` 允许向付款人暴露的公开字段。
- 客户端脚本未就绪或订单已到期时禁用付款触发入口，并保留无脚本刷新降级通道。
- 状态轮询必须正确处理 `Retry-After`、断网、页面切后台、BFCache 恢复、AbortSignal 取消及乱序迟到响应；收银台保持轻量依赖与既有 CSP 策略。
