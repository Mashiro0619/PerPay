# PerPay 前端与文档全面审查报告（基于 `main@87518ed` 修订版）

本报告汇总了对 PerPay 当前代码（`main@87518ed`）**前端视觉与排版设计（UI/UX）**、**前端工程架构与代码质量**以及**项目文档一致性**的审查意见。

第一至三节保留 `87518ed` 时的审查记录，修复进度和待跟进建议见第四节。

- 管理后台总览页参考截图：[dashboard-light.png](./screenshots/dashboard-light.png)
- 单网站工作区订单列表参考截图：[workspace-site.png](./screenshots/workspace-site.png)

---

## 一、 前端视觉审美、排版设计与交互体验（UI/UX）

### 1.1 亮点肯定：克制干净的后台基底
- **表面层次与边框质感**：基于 shadcn `base-nova` 风格，页面背景 `--console-page` 与卡片表面 `--card` 保持了细腻的明度梯度（见 [`web/src/styles.css`](../web/src/styles.css#L921-L930)），配合 `1px` 极细边框 `--console-hairline`，整体干净利落。
- **数字排版与状态语义**：全局金额、单号、时间戳严格启用 `tabular-nums` 等宽数字对齐（见 [`web/src/styles.css`](../web/src/styles.css#L112-L135)）；列表状态徽章（浅绿「收款已确认」、浅红「收款有争议」、弱化灰「已过期·未付款」）对比度克制、易读性好。

### 1.2 色彩与数据可视化设计建议
1. **默认图表与主色调偏纯黑白灰（Monochrome），可考虑适度引入强调色**
   - **定位**：[`web/src/styles/theme.css`](../web/src/styles/theme.css#L59-L83)、[`web/src/components/chart-area-interactive.tsx`](../web/src/components/chart-area-interactive.tsx#L61-L70)
   - **现状分析**：`--primary` 与 `--chart-1` 均设置为近乎纯黑的 `oklch(0.205 0 0)`。虽然 `ChartAreaInteractive` 右上角已提供「面积图 (`AREA`) / 柱状图 (`BAR`) / 折线图 (`LINE`)」三种切换能力，但默认展示的阶梯面积图配合 2px 纯黑描线、纯黑站点占比条与纯黑选中态，整体观感偏冷硬。
   - **设计建议**：保持整体中性克制的同时，可考虑为 `--chart-1` 及数据占比条引入低饱和度的品牌/金融强调色（如深海蓝或青色），或评估将「柱状图 / 平滑曲线」作为按日汇总趋势的默认视图。
2. **极小金额在站点对比横条中接近“单像素黑点”**
   - **定位**：[`web/src/components/site-overview-list.tsx`](../web/src/components/site-overview-list.tsx#L129-L146)、[`web/src/components/site-amount-bar.tsx`](../web/src/components/site-amount-bar.tsx#L2-L15)
   - **现状分析**：「各网站概览」卡片底部的横条比较的是 **`本站金额 / 全站本期最高实收`**（包含暂停接单网站、不受分页影响，并非占全站总额的百分比）。当某站点金额相对全站最高实收极小时（如截图中的 `¥129.01`、`¥39.01`），浅灰轨道最左侧仅渲染出极窄的小黑点，视觉上容易被误认为渲染噪点。
   - **设计建议**：由于横条由 SVG `<rect>` 绘制（`viewBox="0 0 100 4"`），建议在 `SiteAmountBar` 的 SVG 宽度计算中为非零金额设置可见下限；若需展示比例文字，必须明确标注参照基准为“全站本期最高实收”。

### 1.3 导航与信息架构问题（侧边栏 & 顶栏）
1. **顶栏面包屑与正文可视 `<h1>` 标题上下重复**
   - **定位**：[`web/src/App.tsx`](../web/src/App.tsx#L199-L206)、[`web/src/components/site-header.tsx`](../web/src/components/site-header.tsx#L49-L55)
   - **问题**：顶栏面包屑末项（如 `总览`、`本站订单`）正下方紧接着渲染了同名的 `<h1>` 大标题；而页面级操作按钮（如「刷新」「测试收款」）被放在顶部的 `SiteHeader` 中，导致 `<h1>` 行右侧空置，消耗了首屏约 `48px` 的垂直高度。
   - **建议**：将页面主操作按钮放回 `<h1>` 同行右侧；若在无副标题/页头动作时精简可视标题区，应保留页面唯一的一级标题（`<h1>`）语义（例如将 `<h1>` 语义合入顶栏当前页标题或保留 `sr-only` 标题）。
2. **侧边栏存在两个同名同图标的「业务网站」，易产生概念混淆**
   - **定位**：[`web/src/components/app-sidebar.tsx`](../web/src/components/app-sidebar.tsx#L55-L60)、[`web/src/components/app-sidebar.tsx`](../web/src/components/app-sidebar.tsx#L131-L154)、[`web/src/components/site-header.tsx`](../web/src/components/site-header.tsx#L81)
   - **问题**：桌面端单站页面在**侧栏中部**和**顶栏面包屑**提供两处工作区切换入口；而侧栏中部的切换器标题叫 `<Globe /> 业务网站`，下方「全局管理」分组的第一项也叫 `<Globe /> 业务网站`（进入站点管理列表页）。同一侧栏内两个同名同图标入口容易让新用户混淆“切换当前查看的网站”与“管理所有网站”。
   - **建议**：将侧栏的工作区切换器提炼到侧栏顶部（品牌栏下方）作为明确的「当前工作区」选择器，或将「全局管理」中的菜单项改名为「站点管理」。
3. **单站模式下的「设置」在视觉上紧贴「全局管理」分组底部**
   - **定位**：[`web/src/components/app-sidebar.tsx`](../web/src/components/app-sidebar.tsx#L145-L162)
   - **问题**：代码中「设置」虽是跟在「全局管理」`SidebarGroup` 之后的独立 `SidebarMenu`，但视觉上紧贴在「全局管理 -> 审计日志」正下方且无分割线或分组标题。当处于某个具体网站（如 `示例网站 A`）时，点击该「设置」实际进入的是**本站的网站设置（`/sites/site-a/settings`）**，而非全局系统设置。
   - **建议**：选中单站时，将该站点的「网站设置」归入上方单站工作区菜单组（紧跟在 `通知` 下方），或在视觉上与「全局管理」明确分隔并重命名为「网站设置」。

### 1.4 列表筛选栏与表格列宽排布
1. **筛选栏控件标签节奏不一，`北京时间` 视觉悬空**
   - **定位**：[`web/src/components/list-query-toolbar.tsx`](../web/src/components/list-query-toolbar.tsx#L288-L355)、[`web/src/pages/Orders.tsx`](../web/src/pages/Orders.tsx#L96-L131)
   - **问题**：「创建日期」带有前置明文标签和后置灰字 `北京时间`，而右侧紧邻的 `[全部付款状态 v]` 采用无外置标签设计（直接以选项文案作为触发器内容，仅设 `aria-label`），导致 `北京时间` 夹在两个下拉框之间，视觉归属感偏弱。
   - **建议**：将日期下拉框整合为紧凑的自解释触发器（如 `[创建日期：全部 (北京时间) v]`）。
2. **搜索框 Placeholder 文本在部分桌面宽度下易被截断**
   - **定位**：[`web/src/styles.css`](../web/src/styles.css#L1413)
   - **问题**：整个搜索表单区域（`form[role="search"]`）基础宽度设为 `flex: 1 1 15rem`（最大 `26rem`），内部同时包含关键词选择器（`关键词 v`）、输入框与 `搜索` 按钮，导致输入框可用宽度偏紧，在部分桌面视口（见 [workspace-site.png](./screenshots/workspace-site.png)）下，`"输入关键词，按 Enter 搜索"` 被截断为 `"输入关键词，按 Enter 搜"`。
3. **筛选条件与数据导出按钮混排**
   - **定位**：[`web/src/components/list-query-toolbar.tsx`](../web/src/components/list-query-toolbar.tsx#L305-L350)
   - **问题**：数据导出按钮 `[导出 CSV]` 被夹在筛选条件 `[全部付款状态 v]` 与筛选展开按钮 `[高级筛选 v]` 之间。应将筛选类控件（含 `[高级筛选 v]`）全部归左，将 `[导出 CSV]` 与 `[显示]` 推至工具栏最右侧。
4. **四列表格列间距余宽过大，右对齐金额列与左对齐状态列脱节**
   - **定位**：[`web/src/styles.css`](../web/src/styles.css#L1429-L1445)
   - **问题**：`col[data-column-layout="identity"]` 宽度固定为 `16rem`，`amount` 固定为 `8.5rem`（且右对齐）。当表格仅有 4 列时，剩余水平空间被分摊到各列，导致右对齐的 `应付金额` 与左对齐的 `状态` 之间出现较大空白带，横向扫读易串行。
   - **建议**：让主信息列（`订单 / 商品`）自适应填充剩余空间，使右侧的金额、状态、时间紧凑对齐。

### 1.5 总览页 KPI 卡片与公开收银台细节
- **KPI 卡片交互提示与长数字滚动焦点优化**（[`web/src/components/section-cards.tsx`](../web/src/components/section-cards.tsx#L24-L65)、[`web/src/styles.css`](../web/src/styles.css#L770-L804)）：
  - **可点击提示不足**：前两张卡片是纯静态文本，后两张卡片（`当前待付款`、`待处理`）将数字包在 `<Link>` 中，但 4 张卡片外观完全一致，缺少右上角跳转图标或整卡点击/Hover 反馈；
  - **口径说明可发现性**：关键统计口径（如 `按 PerPay 的确认时间汇总，不是支付宝账单合计`）仅写在原生 `title` 属性上，触屏设备无法查看，建议改用与「收款趋势」一致的 `<Info />` 弹窗；
  - **长金额适配与键盘焦点**：现有 `[data-value-length]` 规则负责超长金额字号缩放，`tabIndex={0}`（第 53 行）用于极端超长出现横向滚动条时提供键盘滚动入口。建议保留字号缩放与溢出可访问性能力，但可优化实现（如仅在发生横向溢出时才暴露滚动焦点）。
- **公开收银台（Checkout）桌面端跨列绝对定位与动线割裂**（[`web/src/checkout/CheckoutApp.tsx`](../web/src/checkout/CheckoutApp.tsx#L243-L504)）：
  - 桌面端双栏布局中，DOM 位于左栏 `<CardHeader>` 内的状态徽章（`待付款 · 04:59`）通过 `lg:absolute lg:top-8 lg:right-6`（第 268 行）跨列绝对定位到右栏「订单信息」右上角，右栏标题则用 `lg:pr-36`（第 462 行）预留防碰撞宽度；建议直接将该徽章在桌面端纳入右栏头部 Flex 布局；
  - 用户在左栏扫码，但「查询付款状态」主按钮在右栏底部，「放大二维码 / 保存二维码」在左栏底部，操作视线左右分散。

---

## 二、 前端工程架构与代码维护建议

| 维度 | 位置 | 现状与问题描述 | 改进建议 |
| :--- | :--- | :--- | :--- |
| **未鉴权时提前解析图表依赖** | [`web/src/App.tsx`](../web/src/App.tsx#L239-L263) | 路由已对 `Dashboard` 配置 `lazy()` 按需加载，但 `<AuthBoundary>` 位于父级 `<Route element={...}>` 内。当未登录或未初始化用户打开 `/admin/` 时，React Router 在渲染登录/初始化界面前仍会并行触发子路由 `index` 的 `lazy()`，提前下载并解析 `Dashboard` 与 `recharts` 图表依赖。 | 将路由树拆分为鉴权前/鉴权后，或在未通过鉴权前阻止子路由 `Dashboard` 及其图表依赖的加载。 |
| **前端构建期依赖归类** | [`package.json`](../package.json#L35-L48) | `vite`、`typescript`、`react`、`@tailwindcss/vite` 等已位于 `devDependencies`，但 `dependencies` 中仍保留了仅前端打包使用的 `@base-ui/react`、`class-variance-authority`、`cn`、`motion`、`recharts`、`tw-animate-css`。 | 将上述纯前端 UI 依赖一并归入 `devDependencies`，使 `dependencies` 仅保留服务端运行时所需的 `@hono/node-server`、`alipay-sdk`、`hono`、`uqr`、`urllib`、`zod`。 |
| **大页面组件模块化拆分** | [`web/src/pages/AlipayAccounts.tsx`](../web/src/pages/AlipayAccounts.tsx)<br>[`web/src/pages/Sites.tsx`](../web/src/pages/Sites.tsx) | `AlipayAccounts.tsx`（1,157 行）和 `Sites.tsx`（1,012 行）单文件体量较大，集中了列表展示、多步骤密钥/配置弹窗与版本冲突处理逻辑。 | 作为后续维护改进，可按子领域拆分为独立 Dialog 子组件与表单状态 Hooks。 |

---

## 三、 项目文档一致性与准确性审查

### 3.1 `PERPAY_SETUP_TOKEN_ENABLED` 默认值：文档落后于当前代码
- **代码现状**：[`src/config.ts`](../src/config.ts#L40) 中 `PERPAY_SETUP_TOKEN_ENABLED` 默认值已改为 **`"true"`（默认开启）**，[`docs/releases/unreleased.md`](./releases/unreleased.md#待发布改动)（第 16 行）也已记录*“首次创建管理员默认要求初始化令牌……显式配置 `PERPAY_SETUP_TOKEN_ENABLED=false` 仍然有效”*。
- **文档滞后位置**：
  - [`USAGE.md`](../USAGE.md#1-准备配置)（第 38 行）：仍写着*“初始化令牌默认关闭”*；
  - [`openapi.yaml`](../openapi.yaml#L952)：第 952 行仍写着 `When PERPAY_SETUP_TOKEN_ENABLED=true (default: false)`。
- **修正建议**：将 `USAGE.md` 与 `openapi.yaml` 中的默认值说明统一更新为**默认开启（`true`）**。

### 3.2 `USAGE.md`「外观」章节与当前前端实现脱节
- **文档位置**：[`USAGE.md`](../USAGE.md#外观)（第 415–419 行）
- **不一致表现**：
  - 文档描述：*“后台侧栏‘外观’提供经典蓝、青竹、暖砂、柔紫和石墨配色，每种均支持浅色、深色或跟随系统。”*
  - 代码实际（[`web/src/theme.tsx`](../web/src/theme.tsx#L27-L31)、[`web/src/components/site-header.tsx`](../web/src/components/site-header.tsx#L57)）：5 套主题配色已移除；「外观」切换按钮已从**左侧边栏**移至**顶栏右上角**（移动端在更多菜单中），目前提供 `浅色`、`深色`、`跟随系统` 三种模式。

---

## 四、 修复进度

### 4.1 已落实

- [x] **初始化令牌与外观文档**（`d9ece8e`、`0f78d63`）：[`USAGE.md`](../USAGE.md#1-准备配置) 与 [`openapi.yaml`](../openapi.yaml#L952) 已统一为初始化令牌默认开启；「外观」说明已更新为顶栏入口和浅色、深色、跟随系统三种模式，手机入口名称与实际「页面操作」菜单一致。
- [x] **侧栏设置归属**（`633b0ce`）：[`app-sidebar.tsx`](../web/src/components/app-sidebar.tsx) 为「设置导航」添加分隔线，单站模式显示「当前网站」，区分网站设置与全局管理。
- [x] **列表筛选顺序与列宽**（`604bc21`、`0f78d63`）：高级筛选移到导出操作之前，导出和显示靠右；搜索表单基础宽度调整为 `19rem`、最大 `28rem`，保留 `min(100%, 14rem)` 的收缩下限。表格仅在显示 1–4 列时让主信息列自动分配宽度，更多列时保留 `16rem` 基准。
- [x] **前端依赖分类**（`1b81bfc`）：[`package.json`](../package.json) 中剩余的前端 UI 包已移入 `devDependencies`。
- [x] **小额横条与 KPI 点击提示**（`7645c1a`、`d231a96`、`0f78d63`）：非零网站金额横条设有 `3%` 可见下限；可跳转 KPI 卡片支持整卡点击、悬停反馈和右上角指示图标，加载前后保留图标位置。

### 4.2 本轮复核修正

- [x] **搜索提示缩短**（`d1e7643`）：[`list-query-toolbar.tsx`](../web/src/components/list-query-toolbar.tsx) 的桌面搜索提示改为「输入关键词，回车搜索」，窄屏使用「关键词」，适应关键词类型选择器和搜索按钮占用后的输入宽度。
- [x] **图表冷加载布局修正**（`aa0cdfa`）：`d019c66` 将整个 `ChartAreaInteractive` 懒加载后，首次加载的占位卡片与完整卡片高度不同。本轮保留标题、统计、工具栏和底部说明，仅按需加载单指标和混合图的绘图区。混合图的图例、滚动容器和滚动提示也保留在加载边界外，未登录时仍不下载 Recharts。

后台构建和前端类型检查通过。浏览器核查使用本地演示数据和本轮构建产物，图表资源延迟返回时的结果如下：

| 模式 | 视口宽度与字号 | 加载前后高度差 |
| :--- | :--- | :--- |
| 单指标图 | 1440px / 100%、390px / 100%、320px / 200% | 均为 `0px` |
| 混合图 | 1440px / 100%、390px / 100%、320px / 200%、390px / 150% | 均为 `0px` |

1280px 下，全局订单和本站订单的搜索输入区为 160px，新提示约占 140px；320px、200% 字号下，窄屏提示约占 96px，输入区为 118px，均可完整显示。登录前没有请求图表分包；加载期间切到「每日数据」后，迟到的图表不会插回当前面板。混合图的键盘查看日期、金额与笔数提示、横向滚动均已核查。

### 4.3 逐页视觉复查后的修复

2026-11-14 跟进逐页视觉审查中的 21 项问题和优化建议：

| 界面 | 已落实的调整 |
| :--- | :--- |
| 总览 | 首笔收款引导按本站接单状态和账号分配给出下一步；手机先展示待处理和最近订单，网站概览默认四项，每日数据可独立滚动。趋势金额完整显示，今日指标的口径说明可点击查看。 |
| 导航与页头 | 范围选择改为「查看范围」，管理入口改为「网站管理」。保留唯一页面标题，桌面操作移到标题旁；未知地址的正文和标签页标题一致。 |
| 记录与网站弹窗 | 投递历史显示当次失败类型，日期触发器集中显示范围和北京时间，显示列按单列排列。关闭按钮只占标题行空间，窄屏分类使用选择器，核对选项纵向排列，单行密钥窗口随内容收缩。 |
| 系统设置 | 已有收款码显示摘要和更换入口，最近连接检查集中到使用情况。尚未启用且无历史文件的备份摘要集中显示任务和策略，已有文件及异常继续展示；窄屏向导显示当前步骤，设置卡片标题与操作分行。 |
| 收银台 | 桌面查询操作归入扫码栏，状态纳入订单资料标题区；放大二维码重排文字区域，在大字号和短横屏下保留更大的码图。 |

### 4.4 待跟进建议

- [ ] **KPI 长金额的键盘滚动焦点**：保留字号适配和溢出访问能力，评估只在实际溢出时提供额外滚动焦点。
- [ ] **图表视觉方案**：评估品牌强调色及默认图表类型。
- [ ] **大页面拆分**：逐步拆分 `AlipayAccounts.tsx`、`Sites.tsx` 中的弹窗和表单逻辑。

## 五、 旧单测说明更正

此前将 `onboarding.test.tsx` 的失败归因于「仍断言旧的 `/settings/onboarding/<step>` 路径」不准确。[`AccountOnboarding.tsx`](../web/src/pages/AccountOnboarding.tsx) 当前仍使用 `/settings/onboarding/accounts`、`/settings/onboarding/sites`、`/settings/onboarding/check`，其中 `/accounts` 断言与现行路径一致，应予保留。

其余历史单测应根据实际失败输出逐项定位，核对读取的样式文件、异步内容等待、测试数据和当前界面文案，再决定具体调整。
