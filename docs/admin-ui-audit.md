# 管理后台组件与交互审计

基线：613f947；组件体系：shadcn/ui Base UI / Nova / Neutral。只修改需要改进的组合，不按组件数量衡量质量。官方源码更新必须通过 CLI diff；业务层承担布局与数据语义适配。

## 页面清单

| 页面/区域 | 当前组件 | 官方参考 | 决定 | 阶段/验收 |
| --- | --- | --- | --- | --- |
| 主/次导航 | Sidebar | [Sidebar](https://ui.shadcn.com/docs/components/base/sidebar) | 业务组合使用4px间距；精确匹配路由边界，声明当前页；不改官方原语 | 1：已通过，4px/触屏44px/选中与焦点 |
| 收款概览图表 | Card、Chart、ToggleGroup | [Chart / Interactive](https://ui.shadcn.com/docs/components/base/chart) | 指标汇总与切换进图表头，保留三图形与周期 | 2：已通过，鼠标/键盘/明暗/周期 |
| 每日数据 | Card、Table、Pagination | [Table](https://ui.shadcn.com/docs/components/base/table) | 常驻表格、日期倒序、10条分页；宽屏与图表2:1并排 | 2：已通过，1100px容器断点/跨页/空态 |
| 设置分类/表单 | Tabs、Card、FieldSet、FieldGroup | [Tabs](https://ui.shadcn.com/docs/components/base/tabs)、[Field](https://ui.shadcn.com/docs/components/base/field) | 默认Tabs，窄屏横滚；完整卡片和字段组，保留草稿保护 | 3：已通过，默认Tabs/横滚/明确激活/草稿保护 |
| 密钥与安全 | Card、Dialog、AlertDialog、Field | [Dialog](https://ui.shadcn.com/docs/components/base/dialog) | 保留独立敏感操作及短时秘密展示，不合并“保存全部” | 3/7：已复核，独立动作/秘密生命周期/明暗与窄屏 |
| 订单 | Table、InputGroup、Select | [Data Table](https://ui.shadcn.com/docs/components/base/data-table) | 服务端搜索排序、统一表格/列显示；保留编号直达 | 4/6：已通过，服务端查询/URL恢复/列显隐 |
| 业务通知 | Table、InputGroup、Select | [Data Table](https://ui.shadcn.com/docs/components/base/data-table) | 全局搜索排序、统一表格；不加无用途勾选 | 4/6：已通过，服务端查询/URL恢复/列显隐 |
| 支付关联/冲突/异常 | Tabs、Table、InputGroup、Select | [Data Table](https://ui.shadcn.com/docs/components/base/data-table) | 保留分类语义，服务端查询与统一表格 | 5/6：已通过，服务端检索/查询绑定/URL恢复/列显隐 |
| 待处理 | Table、Popover、Dialog | [Data Table](https://ui.shadcn.com/docs/components/base/data-table) | 搜索排序绑定游标；按筛选结果忽略，保留逐条并发恢复 | 5/6：已通过，查询绑定/范围忽略/并发恢复 |
| 订单/关联详情 | Card、Accordion、Collapsible | [Card](https://ui.shadcn.com/docs/components/base/card) | 主要匹配依据直显，附加历史保留按需查看 | 7：已通过，具名证据/长商品名/财务动作回归 |
| 通知投递尝试 | Table、Pagination、Empty | [Table](https://ui.shadcn.com/docs/components/base/table) | 直显、倒序、10条分页；未读取与真实空记录分开 | 7：已通过，21条跨页/同值排序/读取失败/键盘翻页 |
| 交易对照/采集摘要 | Table、DetailFields、Dialog | [Table](https://ui.shadcn.com/docs/components/base/table) | 具名两/三列表格、无已有流水不重复空列；摘要直显，原始报文按需 | 7：已通过，异常原值/差异标记/明暗与窄屏 |
| 运行状态 | Card、Item、Badge | [Item](https://ui.shadcn.com/docs/components/base/item) | 保留结构、状态说明及操作入口，不强行重写 | 7：已复核，桌面/手机/明暗/读取状态 |
| 配置引导 | Tabs、Field、Card、Collapsible | [Field](https://ui.shadcn.com/docs/components/base/field)、[Tabs](https://ui.shadcn.com/docs/components/base/tabs) | 保留向导及可选高级/私钥导入；活动步骤滚入可见范围，触屏页签不裁切 | 7：已通过，常用字段直显/默认与深链入口/草稿及焦点回归 |
| 登录/初始化 | 官方login组合、Field | [官方块](https://ui.shadcn.com/blocks) | 保留初始化事实分流、验证及安全边界 | 7：已复核，独立已配置/全新实例与明暗/窄屏 |
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

### 第3段
- 官方来源：[Base Tabs](https://ui.shadcn.com/docs/components/base/tabs)、[Field](https://ui.shadcn.com/docs/components/base/field)、[Card](https://ui.shadcn.com/docs/components/base/card)；通过CLI docs核对组件API。只改业务组合，不覆盖原语。
- 七分类统一默认TabsList，窄屏同一套横向滚动页签；activateOnFocus=false，方向键仅移焦点，Enter/Space明确切换；深链所选页签滚入可见范围。保留导航、刷新和页面离开草稿保护。
- 普通分类一个完整CardHeader/Content/Footer，内部FieldSet/Legend/Group划分领域，唯一保存按钮明确属于整个分类表单；应用密钥生成移出普通保存表单，密码/密钥/注销仍分别确认。常用字段直显，高级参数及私钥导入保留具名折叠和字段错误展开聚焦。
- 完整npm run check通过：后端752项、前端672项，3项平台测试跳过；目标63项涵盖默认页签、键盘激活、取消切换后的选中与草稿、分组表单、显示设置和引导兼容。
- 独立6270合成库实测1440/390×明暗×七分类28个页面及4组键盘/草稿交互，整页无横向溢出；390下页签自身714px可滚动、容器358px，长表单与保存可达，页面错误0。记录stage-3-browser.json、stage-3-check.log和stage-3-{width}-{theme}-{section}.png。

### 第4段
- 订单/业务通知接口新增q、sort_by、sort_order；先按SQLite参数化字面包含和白名单排序，再LIMIT/keyset分页。旧默认方向不变：订单created_at DESC，通知created_at ASC；同值用唯一ID，空值总在最后。通知next_attempt_at沿用PENDING/RETRY_WAIT的投影语义，其他状态作空值。
- q去首尾空白、最多100个Unicode字符，百分号/下划线不当通配符；订单仅搜编号/商户号/商品名，通知仅搜投递/事件/订单编号、商户号、通知地址、错误码；不搜备注、财务理由、原始报文或秘密。新游标绑定规范化查询及全部原有筛选；旧文本游标仅兼容原默认条件。
- 追加迁移25的5个查询索引，复用既有订单创建时间/状态索引；旧迁移不变。应用版本仍0.2.2，仅数据库兼容上界扩大为25（最低24）；OpenAPI及生成类型由api:types同步。未改公开收银台、鉴权或账号归属规则。
- 完整npm run check通过：后端759项、前端672项，3项平台跳过。目标测试覆盖后续页命中、中文/emoji/特殊字符、各方向/同值/空值、旧游标、跨查询拒绝、超过到期扫描批次的过期订单，以及原有账号隔离/通知重试回归。
- 万条基准：脚本scripts/benchmark-admin-queries.ts在独立临时库各构造10000条订单/通知读投影；批量装载只用于查询计时，不作为财务写入正确性测试，装载后恢复全部触发器再测真实HTTP查询。首批全财务流程造数耗时过长，因此改为可重复的批量合成读投影；正确性仍由完整生产schema上的真实操作测试保证。订单首查2.8—16.6ms、翻页2.3—8.4ms；通知首查0.9—2.3ms、翻页1.0—1.7ms（本机单次观察，不是SLA）。没有取出全量给浏览器处理。日志stage-4-benchmark.json、stage-4-check.log、stage-4-targeted.log。
- 本段是接口能力，用户可见查询工具栏统一在第6段接入并做浏览器验收，现有编号直达和分页入口保留。

### 第5段
- 支付关联、账本冲突、账务异常、提醒新增同样的q/白名单单列排序；查询发生在分页前。新游标绑定关键词、方向和原筛选（包括已解析的provider账户、提醒类型/可见性）；旧游标仅接受各列表旧默认条件。支付关联仍按事件序号默认升序，冲突/异常默认发现时间升序；提醒保留各视图旧默认顺序。
- 忽略当前筛选：请求增加可选q，去空白后参与有关键词指纹，空关键词继续使用旧指纹；首次事务内记录全部匹配成员，重试复用成员收据，不追加新提醒。排序不改变忽略范围；单条恢复、结束事项、事务回滚和财务事实保护不变。
- 追加迁移26：关联状态/创建索引、冲突账户/外部编号索引，以及通知predecessor索引；复用异常及事件序号既有索引。万条提醒实测发现原后继投递判断缺索引导致二次扫描及租约超时，补索引后首查43—53ms、翻页46—177ms（本机观察），没有放宽租约保护。
- 正确性回归使用真实完整schema及合成财务操作，覆盖关键词后续页命中、中文/字面符号、金额/外部编号/时间双向排序、空值/同值、旧游标及跨筛选拒绝、provider隔离；批量忽略跨页仅命中、同编号不同q拒绝、空q兼容旧指纹、首次执行后新增提醒不被重试吞入、资金异常事实不变。完整npm run check通过：后端762项、前端672项，3项平台跳过。
- 基准沿用独立10000订单/10000通知读投影，其中10000条为失败提醒；装载后恢复触发器再测API，不作为财务写入测试。文件stage-5-benchmark.json、stage-5-check.log、stage-5-targeted-existing.log；用户可见筛选范围提示和统一表格在第6段接入并做浏览器验收。

### 第6段
- 官方来源：[Base Data Table v9指南](https://ui.shadcn.com/docs/components/base/data-table)、[Table](https://ui.shadcn.com/docs/components/base/table)、[Dropdown Menu](https://ui.shadcn.com/docs/components/base/dropdown-menu)、[Input Group](https://ui.shadcn.com/docs/components/base/input-group)。已核对发布版本并锁定开发依赖@tanstack/react-table@9.2.4；只进入管理后台包。
- 六类列表统一Table/表头/行导航/列显隐组合；仅启用columnVisibilityFeature和rowSortingFeature，manualSorting=true，不装载客户端筛选/排序/分页模型，没有无业务用途的勾选框或假页数。关键词Enter/搜索按钮提交，筛选/排序清游标，URL保存q/sort/原有筛选；保留完整编号直达。
- 列显隐是本地非敏感UI偏好，主标识和恢复动作列固定；窄屏保留核心信息与原生详情链接，金额对齐，辅助字段可在详情查看。游标路径和详情返回保留原搜索及排序位置。
- 提醒忽略明确显示当前分类与关键词、跨页范围，丢响应重试继续使用原操作ID与原q；连续恢复仍复用逐条状态机、乱序响应及焦点保护。完整回归发现并修复FlexRender随回调函数变化重建单元格、导致按钮节点与焦点丢失的问题；使用稳定单元格组件类型，未删除焦点断言，24项连续恢复回归全部通过。
- 完整npm run check通过：后端762项、前端683项，3项平台跳过；新增查询提交/Unicode上限、六类排序请求、列控制、没有客户端重排、详情返回及乱序响应测试。
- 独立6270实例27项浏览器验收通过，0页面错误：1440/390×明暗×六类列表24场景，真实API排序/空态/列控制/长商品名/页面无横向溢出，另含搜索分页后详情返回、筛选忽略丢响应幂等重试及恢复、读取失败仍可检索。导航验收等待真实数据及视图过渡完成，不把SPA请求开始当成页面就绪。资产stage-6-browser.cjs/json、stage-6-check.log、stage-6-restore-regression.log、stage-6-{width}-{theme}-{page}.png。

### 第7段
- 官方来源：[Base Table](https://ui.shadcn.com/docs/components/base/table)、[Pagination](https://ui.shadcn.com/docs/components/base/pagination)、[Card](https://ui.shadcn.com/docs/components/base/card)、[Empty](https://ui.shadcn.com/docs/components/base/empty)、[Tabs](https://ui.shadcn.com/docs/components/base/tabs)及[Base UI Tabs API](https://base-ui.com/react/components/tabs)。沿用已安装的 Base UI / Nova 原语，通过 CLI docs 核对组合；不引入新的组件体系或覆盖官方源码。
- 投递尝试改为常驻具名表格，按开始时间倒序，同值按尝试次数/编号确定顺序，每页10条；不修改传入证据数组。切换投递重置分页，缩短读取结果时夹到有效页。真实空记录显示空态；未获得尝试明细明确说明不能据此判断未曾投递。摘要避免重复列出表格已有的结果。
- 匹配依据、采集摘要直接呈现；与收款记录重复的事实继续去重。有已有流水时显示字段/传入记录/已有流水三列，没有时只保留两列且仅说明一次“无可对照流水”。固定字段列、边框、差异标记和换行均在业务层实现；保留1.001等异常原始值，不舍入或替换证据。
- 原始报文仍经记录菜单在技术详情 Dialog 中按需查看，补充历史保留折叠；重新投递、撤销关联、退款标记和冲突处理等确认与幂等状态机未改。运行状态、登录/初始化及密钥安全结构复核后保留，不为组件数量重写。
- 人工看图发现并修正手机上 ACK/时间文本过早拆字，以及引导页当前步骤落在横向滚动区之外、44px触屏页签被固定容器高度裁切的问题。采用仅在必要时断开长词的换行，设置/向导的触屏页签容器自适应高度；向导默认路由归一化及显式步骤变化均滚入活动项且保留标题焦点。未更改官方 Tabs 原语、敏感信息展示或草稿保护。
- 最终目标回归127项及前端类型检查通过，覆盖详情/元数据/摘要、两种对照列数、异常金额原值、空/失败区别、21条分页、稳定排序、技术证据按需、向导默认及深链入口和导航草稿。新增7项证据布局与2项向导入口回归。最后一次完整 npm run check 通过：后端762项、前端692项，3项平台跳过；包括构建、版本一致性、生成API检查、资金与连续恢复等既有回归。
- 新独立6270/6271实例最终51项浏览器验收通过，0页面错误：1440/390×明暗×12类页面/布局共48场景，另含默认向导入口、设置键盘明确激活和投递尝试读取失败。验证两/三列与1.001原值、长文本单元格及整页无横向溢出、21条投递尝试分页/键盘翻页、技术详情按需、活动页签完整可见且触屏高度至少44px。通知的21条尝试仅为确定性的只读响应覆写，其余数据和鉴权来自真实隔离服务；不冒充21次真实发送，没有启动支付宝或通知传输器。实测本机浏览器的长页截图会改变触屏媒体条件，因此手机采用真实视口及滚动后视口截图，并在截图前后断言coarse pointer，避免将截图工具偏差当成业务布局。
- 本段日志：stage-7-targeted-final.log、stage-7-check-final.log、stage-7-browser-final.log、stage-7-browser.cjs/json；截图stage-7-{width}-{theme}-{page}.png，以及默认向导入口、设置键盘激活和投递读取失败截图。保留早期验收日志以区分人工复核前后的运行，最终以上述final日志及最后浏览器结果为准。

## 最终交付边界

- 七段计划全部完成，并按段独立提交；没有推送或升版。应用版本仍为0.2.2；数据库兼容范围最终为24—26，新增部分仅为第4/5段的查询索引迁移，旧迁移与财务历史不改。
- 公开收银台保持基线613f947的界面与交互；所有业务写入验收均在隔离合成数据库中进行，原预览服务、账号与数据未改。
- 主要业务证据直接可见；原始报文、补充历史和秘密继续按需查看。没有把当前页过滤/排序冒充全局搜索，也没有增加无对应业务操作的选择框或假总页数。
