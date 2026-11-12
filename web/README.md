<!-- SPDX-License-Identifier: MIT -->

# 前端开发

后台和公开收银台使用 React、Vite、shadcn/ui 与 Base UI，组件采用 Nova / Neutral。正式运行时由 Hono 提供前端资源。服务端与前端的开发入口见[开发导航](../docs/development/README.md)，业务接口规则见[接入说明](../USAGE.md)，截图要求见 [README 截图](../docs/development/ui-verification.md#readme-截图)。

后台入口为 `/admin/`，路由前缀使用 Vite 的 `BASE_URL`。访问 `/admin` 时，服务端跳转到 `/admin/` 并保留查询参数；访问根路径时跳转到后台。直接打开后台内部页面的地址时，服务端也会返回单页应用入口，再由前端路由显示页面。

配置向导按“支付宝账号 → 业务网站 → 试收款”组织。收款码和应用密钥在支付宝账号中管理，订单规则、通知与业务密钥在网站中管理；系统设置集中管理查账、备份、显示和管理员安全。旧单账号设置地址会跳到对应的新入口。

## 目录

以下路径相对仓库根目录：

| 路径 | 职责 |
| --- | --- |
| `components.json`、`web/src/components/ui/` | shadcn 配置与基础组件 |
| `web/src/components/`、`web/src/pages/` | 后台业务组件与页面 |
| `web/src/lib/`、`web/src/hooks/` | 导航、数据查询、未保存内容及页面操作的共用逻辑 |
| `web/src/api/generated/` | 从 OpenAPI 生成的客户端 |
| `web/src/checkout/`、`src/shared/checkout-view.ts` | 收银台的服务端渲染、浏览器交互、状态轮询，以及允许向付款人公开的数据 |
| `src/http/web/`、`src/shared/branding.ts` | HTML、资源加载，以及系统和网站名称的安全转义 |
| `web/src/styles.css`、`web/public/theme.js` | 公共样式、主题与首屏外观 |
| `web/test/`、`test/`、`ui-tests/` | 已有组件、服务端和浏览器用例 |

## 开发与构建

使用 [package.json](../package.json) 的 Node.js 版本范围。在仓库根目录安装依赖，构建后启动可编辑预览：

```sh
npm ci
npm run build
npm run demo:preview -- --interactive
```

保留该终端，在第二个终端启动 Vite。Linux/macOS 使用：

```sh
PERPAY_DEV_API_URL=http://127.0.0.1:6192 npm run dev:admin
```

Windows PowerShell 使用：

```powershell
$env:PERPAY_DEV_API_URL = 'http://127.0.0.1:6192'
npm run dev:admin
```

打开 `http://127.0.0.1:6191/admin/`，密码为 `123456`。启动参数、怎样找到示例记录及退出后的清理方式见[本地预览](../docs/development/ui-verification.md#本地预览)。

需要真实后端时，设置独立的 `PERPAY_DATA_DIR`、`PERPAY_BACKUP_DIR`、`PERPAY_MASTER_KEY` 和 `PERPAY_PUBLIC_URL`，再运行 `npm run dev`。Vite 默认代理到 `http://localhost:6190`；真实后端会启动已配置的支付宝与通知任务。

Vite 从后端 HTML 读取是否已初始化，以及公开显示的系统和网站名称；读取失败时显示重试入口。收银台先由 Hono 生成首屏 HTML（SSR），再由浏览器接管交互（hydration）。修改后执行 `npm run build:checkout` 并重启后端。

| 开发任务 | 命令与核对方式 |
| --- | --- |
| 后台组件和页面 | `npm run typecheck:admin`、`npm run build:admin`，在预览中操作相关页面 |
| 收银台及共用的公开数据结构 | `npm run typecheck`、`npm run build:checkout`，重启后检查首屏和交互 |
| API 字段变化 | 修改 OpenAPI 后执行 `npm run api:types`、`npm run typecheck` |
| 浏览器测试环境和数据维护 | `npm run typecheck:ui`，已有检查入口见[浏览器回归](../docs/development/ui-verification.md#浏览器回归) |
| 完整产物 | `npm run build`，构建后台、收银台、私有 SSR 和服务端 |
| 调用端示例打包 | `npm run demo:package`，用法见 [Node Demo](../examples/node-client/README.md) |

日常开发按受影响流程人工核对。Node、React 与 Playwright 套件的 CI 和按需入口集中在[开发验证](../docs/development/ui-verification.md#现有-ci-与专项入口)；`npm run check` 包含这些测试中的 Node/React 部分。

构建结果位于 `dist/` 和 `web-dist/`。服务器按 `web-dist/admin/`、`web-dist/checkout/` 的资源清单提供浏览器文件；`web-dist/checkout-ssr/renderer.cjs` 只由服务端加载。源码、source map 和清单文件本身不对外提供。未选用的截图与其他工作材料保存到独立目录，避免重新构建时被清理。

## 浏览器支持

| 浏览器 | 最低版本 |
| --- | --- |
| Chrome / Chromium Edge | 111 |
| Safari / iOS Safari | 16.4 |
| Firefox | 128 |

最低版本依据 [Tailwind CSS 4 的浏览器要求](https://tailwindcss.com/docs/compatibility#browser-support)和 [Vite 8 的兼容说明](https://v8.vite.dev/guide/build#browser-compatibility)。[后台](vite.config.ts)与[收银台](vite.checkout.config.ts)使用 `build.target: "es2022"`。新增浏览器 API 或 CSS 特性时，要确认上表中的最低版本支持它；不支持时，为该功能提供兼容写法。

现有 Playwright 配置使用 Chromium。涉及 Safari、Firefox、内置浏览器或手机系统行为的改动，使用对应浏览器或实体设备核对。

## 组件维护

常规安装和构建直接使用仓库组件。组件接受哪些 props、怎样响应鼠标和键盘、使用什么样式，都以 `web/src/components/ui/` 为准。维护时对照 [components.json](../components.json) 的 `base-nova` 配置，保留 Base UI 的焦点、键盘和弹窗行为。

`web/src/vendor/shadcn-tailwind.css` 保存已固定的 shadcn 样式，来源版本、校验值和许可见 [NOTICE](../NOTICE)。更新时同步这些记录以及已有样式校验；shadcn CLI 作为组件维护工具按需使用，不加入常规运行或构建依赖。

<a id="后台交互约束"></a>

## 后台操作规则

- **网站与身份**：管理路径 `/sites/:clientId` 使用固定网站编号，服务器检查记录是否属于该网站。公开客户端 ID 可以更换；`selected_site` 只记住全局页面选了哪个网站，不能代替 API 筛选条件、写入目标或权限判断。切换网站后，旧网站的缓存、迟到的响应和待确认操作仍归旧网站，不能套用到刚选中的网站。
- **详情与焦点**：打开详情时，保留原列表的筛选、排序和翻页位置。`overlay` 保存编码后的内部详情路径，例如 `/admin/orders?payment=UNPAID&overlay=%2Forders%2Fexample-order`。新增详情类型时，登记它的路由、允许从哪些页面打开及所属网站范围，统一由 `OverlayHost` 显示。关闭后返回仍可用的原页面，把键盘焦点放回打开详情的控件；刷新后按 URL 中保留的信息恢复列表。Escape 关闭最上层窗口。
- **草稿与并发**：编辑同一条记录时，切换分组保留未保存内容。关闭、换记录、浏览器后退或离开页面前，使用同一套未保存内容检查。刷新失败时保留填写内容；发现版本冲突时，先读取并核对最新配置，再保存。服务器确认网站已删除后，清理该网站的编辑器和易支付助手草稿，返回列表并移除旧选择。取消或删除失败时保留草稿，易支付助手正在保存时继续阻止删除。
- **未知结果**：写入财务记录或配置时，保存原请求内容、版本和幂等编号，使用它们核查或重试同一次操作。请求超时、关闭或响应正文损坏，都不能说明服务端没有执行。恢复网络后可继续读取数据，写请求须由用户明确重试；登录失效后清除受保护的页面数据，并丢弃旧登录状态下迟到的响应。
- **数据展示**：列表搜索、排序和分页由服务端执行。手机布局保留网站、订单编号、字段标签、状态和必要操作，金额、编号和时间要说明来自哪里。无法确定的值继续显示为未知；刷新时暂时保留的旧数据，要同时保留它对应的查询时间范围。收款确认、通知接收结果和管理员退款登记分别显示，用词见[术语表](../docs/glossary.md)。
- **可访问操作**：使用对应的基础按钮、链接、Tabs 和表单组件，让浏览器和读屏软件能识别它们的用途；纯图标操作也要有可读取的名称。弹窗中的提交按钮关联原表单，出错时能找到对应输入项并把焦点移过去。长内容可以换行，窗口较矮时正文可以滚动，标题和按钮都能到达。
- **视觉与动效**：使用共用容器、按成功或错误等用途定义的颜色，以及基础组件样式。切换宽度、主题或布局时保留编辑器状态；同一 CSS 属性只由一种动画方式控制，并遵守系统“减少动态效果”设置。公开收银台继续使用自己的轻量依赖和现有 CSP。

用户点击查看后才向服务器读取密钥，明文不进入查询缓存；关闭查看窗口、页面切到后台或登录失效时清除。只有服务端明确返回 `initialized=false`，才进入管理员初始化流程。所有写入仍检查登录会话、CSRF、IP 白名单和业务规则。

公开收银台只读取允许向付款人公开的数据。浏览器中的付款逻辑尚未启动、或订单已经到期时，关闭付款入口。状态轮询要处理 Retry-After、断网、页面切到后台、从前进后退缓存（BFCache）恢复、请求取消及迟到的旧响应，并保留不依赖脚本的刷新入口。修改共用样式、构建方式或这部分公开数据时，一并人工核对收银台。
