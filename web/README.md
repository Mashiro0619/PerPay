<!-- SPDX-License-Identifier: MIT -->

# 前端开发

后台和公开收银台使用 React、Vite、shadcn/ui、Base UI，组件采用 Nova / Neutral。生产环境由 Hono 提供前端资源，不需要独立前端服务。部署见[项目说明](../README.md)，业务契约见[接入说明](../USAGE.md)，本地预览和验收见[验证指南](../docs/development/ui-verification.md)。

后台入口为 `/admin/`，路由基址使用 Vite 的 `BASE_URL`。服务端将 `/admin` 规范化为 `/admin/` 并保留查询参数；根路径跳转到后台，深层路径返回对应的单页应用入口。

## 目录

以下路径相对仓库根目录：

| 路径 | 职责 |
| --- | --- |
| `components.json`、`web/src/components/ui/` | shadcn 配置与基础组件源码 |
| `web/src/components/`、`web/src/pages/` | 后台业务组合与页面 |
| `web/src/lib/`、`web/src/hooks/` | 导航、查询、草稿与交互工具 |
| `web/src/api/generated/` | 从 OpenAPI 生成的客户端，不手工编辑 |
| `web/src/checkout/`、`src/shared/checkout-view.ts` | 收银台 SSR、hydration、轮询及共用公开投影 |
| `src/http/web/`、`src/shared/branding.ts` | HTML 输出、资源加载与公开名称转义 |
| `web/src/styles.css`、`web/public/theme.js` | 公共样式、主题及首屏外观 |
| `web/test/`、`test/`、`ui-tests/` | 组件、服务端及浏览器回归 |

## 开发与构建

使用 [package.json](../package.json) 的 `engines.node` 指定范围：Node.js 24.15.0 及以上的 24.x。在仓库根目录安装依赖并构建，再启动隔离后端和 Vite：

```sh
npm ci
npm run build
npm run dev:admin
```

后台开发入口为 `http://127.0.0.1:6191/admin/`，默认代理到 `http://localhost:6190`。可用 `PERPAY_DEV_API_URL` 指向[临时预览后端](../docs/development/ui-verification.md#本地预览)。自行运行 `npm run dev` 时，先设置独立的 `PERPAY_DATA_DIR`、`PERPAY_BACKUP_DIR`、`PERPAY_MASTER_KEY` 和 `PERPAY_PUBLIC_URL`，核对 Origin；真实支付宝或通知配置会启动真实后台任务。

Vite 从后端 HTML 读取初始化标记及公开名称，后端不可用或标记未知时提供重试，不推断为首次部署。收银台始终由 Hono 提供 SSR；修改后执行 `npm run build:checkout` 并重启后端，Vite 代理不代替构建。

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 构建后台、收银台、私有 SSR 与服务端 |
| `npm run build:admin` / `npm run build:checkout` | 单独构建后台 / 收银台 |
| `npm run api:types` | 修改 OpenAPI 后重新生成客户端 |
| `npm run test:admin` / `npm run test:node` | 前端 / 服务端回归；服务端测试前需构建前端 |
| `npm test` | 先构建前端，再运行 Node 与 React 测试 |
| `npm run check` | 版本、接口、类型、测试与服务端构建检查 |
| `npm run demo:package` | 打包[业务调用端 Demo](../examples/node-client/README.md) |

公开资源仅来自 `web-dist/admin/` 和 `web-dist/checkout/` 的资源清单。`web-dist/checkout-ssr/renderer.cjs`、源码、source map 与清单本身不得作为公开资源；服务端产物在 `dist/`。业务数据、文档和发布材料的唯一副本必须放在构建目录外。

## 浏览器支持

| 浏览器 | 最低版本 |
| --- | --- |
| Chrome / Chromium Edge | 111 |
| Safari / iOS Safari | 16.4 |
| Firefox | 128 |

基线依据 [Tailwind CSS 4 的浏览器要求](https://tailwindcss.com/docs/compatibility#browser-support)及 [Vite 8 的兼容说明](https://v8.vite.dev/guide/build#browser-compatibility)。[后台](vite.config.ts)与[收银台](vite.checkout.config.ts)配置使用 `build.target: "es2022"`，仅转换 JavaScript 语法，不补齐运行时 API 或 CSS 能力。新增 API 应符合基线或提供局部回退。

IE、EdgeHTML 及更旧内核不在支持范围。基线不等于逐版本实测；当前 Playwright 使用 Chromium，不能代替 Safari、Firefox、内置浏览器或实体设备验收。

## 组件维护

常规安装和构建直接使用仓库组件，不依赖 shadcn CLI。`web/src/vendor/shadcn-tailwind.css` 是 `shadcn@4.21.4/dist/tailwind.css` 的原样副本，SHA-256 为 `4c371f7a1ff5d219ae2f7ff28bd256b4346fd546fe46fbae22092e57db2f0fae`；许可见 [NOTICE](../NOTICE)。

CLI 仅在维护组件时按需使用，先核对版本、依赖安全和变更 diff，保留 Base UI 语义及已有适配。更新 vendored 样式时同步来源版本、哈希、NOTICE 和 `web/test/motion.test.tsx` 的校验；不要恢复 CLI 包的 CSS 导入或无意加入整套 CLI 构建依赖。修改后执行构建、相关回归及依赖审计。

## 后台交互约束

- **网站范围**：网站业务使用 `/sites/:clientId` 对应的 API，服务器核对资源归属。`selected_site` 仅记忆全局页面中的导航选择，不是 API 筛选、写入身份或权限；网站工作区也不新增管理员角色。跨站切换不能串用旧响应、缓存或未确认操作。
- **详情地址**：父页保留筛选、排序和游标，`overlay` 保存经过编码、不含 `/admin` 的已注册内部路径，如 `/admin/orders?payment=UNPAID&overlay=%2Forders%2Fexample-order`。新增类型登记 `overlayRouteDefinitions`、合法父页和资源范围，统一使用 `OverlayHost`；详情目标不改写父页范围。直达、刷新和旧链接必须有安全父页，不能依赖未知浏览器历史。
- **历史与焦点**：关闭详情恢复来源和可用的触发焦点；重新加载后不能承诺恢复已销毁的 DOM、滚动位置或游标链。关联对象、内部步骤与技术信息弹窗沿用统一历史和焦点管理。技术信息为独立只读弹窗，保留父详情的 DOM、滚动和地址，Escape 只关闭最上层。
- **草稿与并发**：同一对象切换分组保留一份草稿；关闭、换对象、离开与后退使用同一导航保护。刷新失败保留草稿，首次读取成功才建立编辑基线；版本冲突须核对全部修改后显式保存。创建、删除和保存以服务器成功结果为准，完成后的后台读取不继续占用写操作锁。
- **未知结果**：财务与配置写入保留原请求、版本和幂等编号，显式重试原操作；HTTP 成功但正文损坏不算已确认。关闭或超时不等于取消已发送命令，恢复网络只恢复读取。会话失效清除受保护缓存、草稿与操作状态，并丢弃旧会话晚到响应。
- **数据展示**：列表搜索、排序和游标由服务端执行；详情返回保留列表条件。移动摘要保留必要身份、字段标签、状态和操作，不按固定数量截断，也不继承桌面隐藏列。错误或未知值不当作零，旧周期数据不冒充新区间；收款确认与通知送达分别表达。退款标记不代表执行或核实退款。
- **可访问操作**：使用基础组件的按钮、链接、Tabs 和表单语义，图标操作有可访问名称。`OverlayActions` 中的提交按钮关联原表单；字段错误可定位、可聚焦。长值自然换行，放大文字和短视口下正文可滚动、标题和操作可达，不能留下两套同时可操作的表单。
- **视觉与动效**：复用公共容器、语义颜色和基础变体，切换宽度、主题或布局不重挂载草稿。每个属性只由一种动画机制控制，保留 Base UI 焦点与卸载行为，响应系统减少动态效果偏好；不为动效放宽 CSP，也不把后台 Motion 引入公开收银台或 SSR。

密钥只在显式查看时读取，不进入查询缓存；关闭、隐藏或会话失效后清除明文，不能恢复晚到密钥。管理员初始化只接受明确的 `initialized=false`。所有写入继续执行服务器会话、CSRF、IP 白名单和业务校验，不能用界面状态代替。

公开收银台只消费公开投影。付款控制器未启动或订单到期时关闭付款入口；轮询处理 Retry-After、离线／隐藏暂停、BFCache、取消和旧响应，保留无脚本刷新入口。后台布局、共享样式与构建调整均需覆盖收银台回归。
