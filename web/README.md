# 前端开发

后台和公开收银台使用 **React · Vite · shadcn/ui · Base UI · Nova · Neutral**。生产部署不需要单独的前端服务，见[部署说明](../README.md)；接口与业务规则见[接入说明](../USAGE.md)。

## 目录

以下路径相对仓库根目录：

| 路径 | 内容 |
| --- | --- |
| `components.json` | shadcn CLI 配置 |
| `web/src/components/ui/` | 官方基础组件 |
| `web/src/components/`、`web/src/pages/` | 后台业务组合与页面 |
| `web/src/api/generated/` | OpenAPI 生成的客户端；不要手改 |
| `web/src/branding.ts`、`src/shared/branding.ts` | 公开系统名称及 HTML 转义 |
| `web/src/checkout/` | 收银台视图、SSR / hydration、轮询和下载 |
| `src/shared/checkout-view.ts` | SSR 与客户端共用的公开投影 |
| `src/http/web/` | Hono HTML 输出与构建资源加载 |
| `web/src/styles.css`、`web/public/theme.js` | 主题、CSP / 触控适配及首屏外观 |
| `web/test/`、`test/` | 前端与服务端回归测试 |

## 只读预览

需要 Node.js 24.15+（24.x）。在仓库根目录执行：

```sh
npm ci --ignore-scripts
npm run build
npm run demo:preview
```

打开 [http://127.0.0.1:6192/admin/](http://127.0.0.1:6192/admin/)，使用固定密码 `123456` 登录（仅限本地只读演示，不影响正式部署）。可加 `-- --port 6193` 更换端口。

- 使用系统临时目录中的合成订单；不读取工作区的 `data/`、`backups/` 或生产配置。
- 只允许登录、退出及读取（含订单 CSV 导出）。常驻“只读演示”标识在操作前说明限制；保存、密钥和财务写操作由前后端拒绝，不用于验证写操作。
- 不启动支付宝采集、通知发送或更新检查；健康状态明确为模拟，演示二维码不可付款。数据生成完毕后时钟正常前进，订单到期、收银台和按北京时间的统计使用同一时间源。
- Ctrl+C 正常退出会清理临时数据。重启后登录会话和演示订单重新生成，登录密码保持 `123456` 不变。
- 修改页面后重新构建并重启预览；Hono 在启动时缓存前端资源，单纯刷新浏览器不会加载刚构建的文件。

截图及其生成说明见[截图目录](../docs/screenshots/README.md)。

## 开发与构建

开发时先构建一次前端，再另行启动**隔离开发后端**。可通过 `PERPAY_DATA_DIR`、`PERPAY_BACKUP_DIR`、`PERPAY_MASTER_KEY` 和 `PERPAY_PUBLIC_URL` 指定独立实例，再运行 `npm run dev`。不要连接生产收款实例；输入真实支付宝或通知配置会触发真实后台任务。

```sh
npm run build
npm run dev:admin
```

后台开发入口：[http://127.0.0.1:6191/admin/](http://127.0.0.1:6191/admin/)，默认代理到 `http://localhost:6190`。更换后端使用 `PERPAY_DEV_API_URL`，并核对 `PERPAY_PUBLIC_URL` / Origin 配置。只查看界面也可代理到上述只读预览，但仍不能保存。

- 路由使用 Vite 的 `BASE_URL`（含尾斜杠）；旧 `/admin` 入口会规范化为 `/admin/`，保留查询、锚点及历史状态。
- Vite 每次从后端 `/admin/` HTML 读取初始化标记及公开名称。后端不可用或标记未知时提供重试，不将未知状态当作首次部署；生产 HTML 由 Hono 直接注入。
- 收银台始终由 Hono 提供 SSR。修改后执行 `npm run build:checkout` 并重启隔离后端；Vite 代理不代替构建。

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 全部前端资源、私有收银台 SSR 和服务端 |
| `npm run build:admin` / `npm run build:checkout` | 单独构建后台 / 收银台 |
| `npm run api:types` | 修改 OpenAPI 后重新生成客户端 |
| `npm run test:admin` / `npm run test:node` | 单独运行前端 / 服务端测试；服务端测试前需构建前端 |
| `npm test` | 先构建前端，再运行全部测试 |
| `npm run check` | 版本、接口、类型、测试与服务端构建检查 |
| `npm run demo:package` | 打包[业务调用端 Demo](../examples/node-client/README.md)，不是只读预览 |

公开资源在 `web-dist/admin/` 和 `web-dist/checkout/`；`web-dist/checkout-ssr/renderer.cjs` 是私有产物，打包了 SSR 所需的前端依赖。只按清单提供公开资源，不能暴露 SSR、源码、source map 或清单文件。服务端编译结果在 `dist/`；不要在构建目录存放唯一副本的文档、发布材料或业务数据。

## 组件与布局

通过官方 CLI 添加或更新组件；先查看 diff，不整批覆盖现有适配：

```sh
npx shadcn@latest add <component>
```

- 基础控件沿用默认变体和语义颜色；业务层负责布局与状态，不另建一套按钮、菜单或主题。许可见 [NOTICE](../NOTICE)。
- 设置页的配置向导／刷新、向导的图文教程／刷新、运行页的刷新统一放在顶栏外观入口左侧；按钮仍由所属页面持有状态，刷新保留草稿确认，离开页面清除对应操作。窄屏使用带可访问名称的图标入口。向导的单一刷新入口同步读取配置和实例状态，再重新检查收款就绪；完成页不重复放置刷新或常规设置出口。
- 设置分类使用 Tabs，窄屏横向滚动；“支付宝环境”使用 Select，不再使用原生下拉框。显示设置采用内部限宽单列表单，外层卡片跟随公共容器，桌面标签与控件按行对齐，手机上下排列。普通保存须有修改，离开草稿只确认一次；错误关联到字段并聚焦。
- 列表采用服务端搜索、排序和游标；响应式列按容器宽度与用户偏好决定，不能将当前页筛选冒充全量查询。返回详情来源时保留筛选和分页。
- 后台内容由公共容器统一控制：默认“收缩”（最大 1280px 居中），顶栏外观左侧可切换“全屏”（铺满侧栏右侧）。两者统一保留手机 16px、桌面 24px 水平边距；不控制侧栏、不调用浏览器全屏。手机隐藏切换入口，内容自然铺满。选择以 `perpay:content-width` 的 `compact / full` 保存到本浏览器并跨标签页同步；存储不可用时仍可切换。页面卡片不再自行限宽，短表单只限制内部字段区域；登录、收银台和弹窗不受影响。切换不得重挂载页面、清除草稿或重新发起业务请求。
- 收款概览的趋势只显示当前指标的区间累计，最近订单使用摘要列表，完整时间与生命周期保留在订单页。每日数据与图表同属趋势区，通过标签切换并共用统计周期；切回图表再返回时保留日表页码，切换周期回到第一页。
- 图表使用真实聚合数据；切换周期时不能把旧数据标成新区间。保留键盘访问、统计口径和加载 / 失败状态。
- 收银台桌面双栏、手机同一份 DOM 单栏。二维码保留完整留白；放大、下载与主图一致。矮屏自然滚动，不以固定定位裁切内容。
- 图标从 `web/src/assets/favicon.svg` 构建为同源、带指纹的外部 SVG；不要恢复固定 `/admin/favicon.svg` 或内联 data URL。

详情页保留正文返回入口，刷新统一通过 `PageHeaderActions` 放入顶栏。`RefreshButton` 只负责加载、禁用及 Tooltip，各页保留原刷新范围和草稿确认。后台复制显式启用 Tooltip，更多操作沿用菜单状态；公开收银台复制不变。

### 后台弹窗规格

后台通过 `admin-dialog` 复用基础弹窗：确认最大 512px、表单 576px、技术详情 768px，窗口边缘至少 16px。正文独立滚动，标题与操作区保留；手机按钮纵排（主操作在上），桌面右对齐横排。纯确认默认聚焦取消，危险操作使用 destructive；结果未知时强调“留在此页”。密钥轮换的确认与结果展示共用原操作状态和密钥有效期，不因外观切换重新请求。登录和公开收银台继续使用原基础组件。

### 反馈与内容规格

成功提示由 `useFeedback` 单独管理 4 秒时限，同样文案再次成功重新计时，`SuccessMessage` 只渲染。操作完成的业务锁与提示寿命分离，错误、密钥提醒和未知结果不受成功计时器影响。`admin-empty` 区分页面/列表、筛选无结果、局部无明细；筛选重置和上一页操作保留。`DetailFields` 普通与紧凑两档按自身容器宽度分栏，空值为“—”，零值保留，长值自然换行；交易对照、密钥和 JSON 继续使用专用展示。

## 数据与安全边界

- 系统名称是公开信息：由服务端安全注入登录页和收银台，后台保存后同步更新。显示设置不改变付款版本、订单或通知；隐藏商品名称也不是保密功能。数据库兼容范围以 [src/version.ts](../src/version.ts) 和[维护文档](../docs/maintenance.md#固定版本与回滚)为准。
- 管理员初始化只依据明确的 `initialized=false`；配置向导不等于再次创建管理员。密钥仅显式查看时读取，不进入查询缓存；关闭、标签页隐藏或 60 秒超时后清除页面明文。
- 收银台不加载管理 API 或秘密。付款控制器未启动时不展示二维码和静止倒计时；保留无脚本刷新入口。轮询须处理 Retry-After、离线 / 隐藏暂停、BFCache、取消与旧响应；到期关闭付款入口并取消下载。
- 财务写入使用 CSRF、版本与幂等编号。结果未知时保留原请求和固定证据，只能明确重试原操作；HTTP 2xx 正文损坏不算成功。超时或离开页面不等于撤销服务端命令，也不自动重发。
- 固定证据操作与草稿共用一个路由 blocker；状态冲突不能继续提交旧命令。会话失效清除本会话状态，晚到响应不得触发成功。
- 退款标记只是管理员声明，不执行或验证退款，不改变资金、付款状态或通知。标记版本与操作编号需保持，未知结果必须核查；不能把历史幂等回执说成最新状态。
- 忽略提醒不消除异常，也不停止重试。连续恢复由列表按条持有请求；保留当前分类、游标和最后一次操作的焦点，读取失败不能被当成空页。
- 明暗主题仅保存 `perpay:theme` 的 light / dark / system；切换外观不能重挂载表单或触发业务写入。

## 验证与性能

除 `npm run check` 外，布局修改要在生产 CSP 下验证桌面 / 手机、明暗、长文本、键盘焦点与滚动可达性；收银台额外检查禁用脚本及 hydration。所有写操作使用隔离合成库，不以真实订单作测试。

以下脚本在临时数据库构造查询投影，不连接支付宝或发送通知；只衡量列表查询，不作为财务写入正确性的证据。参数范围为 100–20000，默认 10000：

```sh
node --experimental-strip-types scripts/benchmark-admin-queries.ts 10000
node --experimental-strip-types scripts/benchmark-admin-queries.ts 10000 work-items
node --experimental-strip-types scripts/benchmark-manual-candidates.ts 10000
```
