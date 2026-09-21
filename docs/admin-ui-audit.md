# 管理后台组件与交互审计

基线：613f947；组件体系：shadcn/ui Base UI / Nova / Neutral。只修改需要改进的组合，不按组件数量衡量质量。官方源码更新必须通过 CLI diff；业务层承担布局与数据语义适配。

## 页面清单

| 页面/区域 | 当前组件 | 官方参考 | 决定 | 阶段/验收 |
| --- | --- | --- | --- | --- |
| 主/次导航 | Sidebar | [Sidebar](https://ui.shadcn.com/docs/components/base/sidebar) | 业务组合使用4px间距；精确匹配路由边界，声明当前页；不改官方原语 | 1：已通过，4px/触屏44px/选中与焦点 |
| 收款概览图表 | Card、Chart、ToggleGroup | [Chart / Interactive](https://ui.shadcn.com/docs/components/base/chart) | 指标汇总与切换进图表头，保留三图形与周期 | 2：已通过，鼠标/键盘/明暗/周期 |
| 每日数据 | Card、Table、Pagination | [Table](https://ui.shadcn.com/docs/components/base/table) | 常驻表格、日期倒序、10条分页；宽屏与图表2:1并排 | 2：已通过，1100px容器断点/跨页/空态 |
| 设置分类/表单 | Tabs line、NativeSelect、Card、Field | [Tabs](https://ui.shadcn.com/docs/components/base/tabs)、[Field](https://ui.shadcn.com/docs/components/base/field) | 默认Tabs，窄屏横滚；完整卡片和字段组，保留草稿保护 | 3：待实施 |
| 密钥与安全 | Card、Dialog、AlertDialog、Field | [Dialog](https://ui.shadcn.com/docs/components/base/dialog) | 保留独立敏感操作及短时秘密展示，检查表单组合 | 3/7：待复核 |
| 订单 | Table、InputGroup、Select | [Data Table](https://ui.shadcn.com/docs/components/base/data-table) | 服务端搜索排序、统一表格/列显示；保留编号直达 | 4/6：待实施 |
| 业务通知 | Table、Select | [Data Table](https://ui.shadcn.com/docs/components/base/data-table) | 全局搜索排序、统一表格；不加无用途勾选 | 4/6：待实施 |
| 支付关联/冲突/异常 | Tabs、Table、Select | [Data Table](https://ui.shadcn.com/docs/components/base/data-table) | 保留分类语义，服务端查询与统一表格 | 5/6：待实施 |
| 待处理 | Table、Popover、Dialog | [Data Table](https://ui.shadcn.com/docs/components/base/data-table) | 搜索排序绑定游标；按筛选结果忽略，保留逐条并发恢复 | 5/6：待实施 |
| 订单/关联详情 | Card、Accordion、Collapsible | [Card](https://ui.shadcn.com/docs/components/base/card) | 主要匹配依据直显，附加历史保留按需查看 | 7：待实施 |
| 通知投递尝试 | Collapsible、Table | [Table](https://ui.shadcn.com/docs/components/base/table) | 直显、倒序、10条分页 | 7：待实施 |
| 交易对照/采集摘要 | Table、Collapsible | [Table](https://ui.shadcn.com/docs/components/base/table) | 具名两/三列表格、无已有流水不重复空列；摘要直显 | 7：待实施 |
| 运行状态 | Card、Item、Badge | [Item](https://ui.shadcn.com/docs/components/base/item) | 保留结构，复核状态说明与操作可达性 | 7：待复核 |
| 配置引导 | Field、Card、Collapsible | [Field](https://ui.shadcn.com/docs/components/base/field) | 保留向导及可选高级/私钥导入，检查常用字段直显 | 7：待复核 |
| 登录/初始化 | 官方login组合、Field | [官方块](https://ui.shadcn.com/blocks) | 保留初始化事实分流、验证及安全边界 | 7：待复核 |
| 公开收银台 | Card、Badge、Dialog | 已单独验收的613f947 | 本轮不改 | 保留 |

## 数据与安全边界

约一万条记录规模，SQLite参数化包含匹配与必要排序索引；不取全量到浏览器搜索/排序，不引入全文搜索服务。保留旧查询默认排序及旧游标兼容。新游标绑定全部筛选。财务理由、密钥和原始报文不进入搜索。所有写入验收只对独立临时库执行，不修改现有预览账号或业务数据。

## 分段验收记录

每段目标测试及完整 npm run check 通过后独立commit；不自动push或升版。截图、网络/布局实测和完整日志保存在本地任务附件的 admin-ui-rework 目录，逐段记录下文。

### 第1段
- 目标导航回归与全量检查通过：752项后端、663项前端，3项平台跳过。
- 独立6270实例实测1440/390宽度、明暗主题，菜单相邻间距均4px、移动命中高度至少44px、唯一当前页。截图stage-1-*与stage-1-browser.json。未更改官方Sidebar原语及收银台。

### 第2段
- 官方结构参考：[Bar Chart - Interactive](https://ui.shadcn.com/charts/bar#chart-bar-interactive)及其[示例源码](https://ui.shadcn.com/code/apps/v4/registry/new-york-v4/charts/chart-bar-interactive.tsx)；组件API对照[Base Chart](https://ui.shadcn.com/docs/components/base/chart)、[Toggle Group](https://ui.shadcn.com/docs/components/base/toggle-group)、[Table](https://ui.shadcn.com/docs/components/base/table)、[Pagination](https://ui.shadcn.com/docs/components/base/pagination)。图表集合示例是new-york-v4来源，仅采用“标题/范围 + 可切换指标汇总 + 图表”的信息结构，继续组合现有Base UI / Nova原语，未覆盖官方组件源码。
- 确认金额、新建订单汇总进入图表头部；独立汇总卡仅保留确认次数、当前待付款。沿用服务端汇总口径，不由每日行重新推算汇总；面积、柱状、折线和7/30/90天均保留。使用现有chart-1/chart-2语义颜色，不引入违反CSP的动态style块；tooltip读取原始分值，不将图表浮点坐标反推为金额。
- 每日数据默认直显，日期倒序、每页10天；周期变化回到第一页，加载时不显示旧周期行，空结果与读取失败分开呈现。客户端分页仅处理最多90条聚合日记录，不用于后续业务列表的全局查询。
- 必要布局适配：主内容容器不足1100px时上下排列，达到1100px按2:1并排。实测容器1099px为单列；1100px为690.66/345.34px；1440px视口下为720/360px。长金额仅在表格自身滚动，整页无横向溢出。保留最近订单、待处理与统计口径说明。
- 目标回归70项通过；完整npm run check通过：752项后端、671项前端，3项平台跳过。覆盖单序列、精确金额、指标键盘切换、三图形高亮、跨页无遗漏、周期切换与异步乱序、空态及失败态。浏览器负向验收发现并修复统计失败后汇总卡永久显示Skeleton的问题。
- 浏览器20项场景通过，包含1440/390宽度×明暗×三图形、1100px临界断点、7/90天、长金额、加载和读取失败；鼠标、键盘、分页均实测，页面错误为0。独立6270/6271合成测试库验证真实页面与鉴权；图形矩阵使用固定合成analytics/settings只读响应，以便复现实验，不修改原预览数据或账号。
- 验收资产位于本轮线程01a0c4e1-7a3f-7f33-9c58-3544a5e40529的admin-ui-rework目录：stage-2-browser.cjs、stage-2-browser.json、stage-2-check.log、stage-2-1440/390-{light,dark}-{area,bar,line}.png，以及loading、failed-read、long-values截图。
