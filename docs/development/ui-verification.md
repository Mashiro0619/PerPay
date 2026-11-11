<!-- SPDX-License-Identifier: MIT -->

# 开发验证

日常开发以相关类型检查、构建和人工核对为主。本文说明怎样启动预览、拍摄 README 截图，以及按需运行已有的浏览器和 Linux 检查。命令在仓库根目录执行，环境准备见[开始开发](README.md#开始开发)，界面规则见[后台操作规则](../../web/README.md#后台交互约束)。

## 本地预览

```sh
npm run build
npm run demo:preview -- --interactive
```

打开 `http://127.0.0.1:6192/admin/`，密码为 `123456`。预览会生成独立的临时数据库、随机主密钥和示例订单，二维码不能用于付款，服务只监听本机回环地址。按 Ctrl+C 退出时，清理这次创建的临时数据库。

| 参数 | 用途 |
| --- | --- |
| 不加参数 | 只读预览，可以登录、退出；导出仍需通过鉴权等检查 |
| `--interactive` | 允许管理员 API 修改临时数据，用于检查保存、字段校验、配置冲突和删除操作 |
| `--official-updates` | 实际向 GitHub 查询公开发布的版本 |
| `--port 6192` | 指定本轮预览端口 |

参数放在 `npm run demo:preview --` 后。预览中的健康状态由模拟数据给出，查账和通知由本地模拟代码返回结果，公开收银台不能进行真实付款。需要前端热更新时，按 [Vite 开发步骤](../../web/README.md#开发与构建)连接这个临时后端。

启动日志中的 `featured` 指向带有完整收款和通知记录的示例订单；`scenarios.lifecycle`、`financial`、`ledger` 和 `notifications` 列出其他示例记录的编号。按页面和这次启动的日志查找记录；重启后从新日志取编号，并重新登录。临时库重建后首次登录回到全部网站总览，同一次预览中再次登录则保留原页面。

修改源码后，依次停止旧预览、完成构建、在原端口重启。截图和操作核对均使用这次重启后的产物。

## 日常手工核对

先执行对应类型检查和构建，再按改动检查下面的操作。

| 改动类型 | 核对内容 |
| --- | --- |
| 布局、文案或样式 | 桌面与窄屏、明暗主题、长内容和放大文字下能否读清；能否用键盘选中控件、滚动到全部内容 |
| 表单与设置 | 保存、取消、字段错误；切换分组后是否保留未保存内容；刷新失败、版本冲突、请求尚未完成或结果不明时怎样继续 |
| 列表与详情 | 筛选、排序、翻页；打开与关闭详情；直接打开详情地址后刷新；浏览器前进后退；关闭后焦点是否回到原控件 |
| 多网站操作 | 请求是否使用正确网站编号，全局与本站数据是否区分；切换或删除网站后，查询、保存和侧栏选择是否仍正确 |
| 付款与通知展示 | 下单金额、应付与实收、付款截止、收款确认、通知接收结果和重试原因 |
| 收银台 | 服务端首屏（SSR）、浏览器接管交互（hydration）、无脚本刷新、二维码操作、到期与结束状态、返回商家 |

布局检查可以使用 200% 文字和较矮窗口；README 展示截图使用下一节的统一比例。核对流水来源时，展开“核对凭据”或“支付宝交易编号”，同时检查完整编号、来源标签和复制入口。

人工核对时记下源码提交、构建版本、浏览器、页面地址、操作步骤和结果。遇到失败，保留截图和错误信息；实际支付宝小额付款、业务网站接收通知和实体设备操作，各自记录对应结果。

## README 截图

1. **固定桌面规格。** CSS 视口宽 1280，使用 DPR 2、浅色主题和 100% 页面缩放。当前总览图高 980、订单图高 952；调整高度时让画面下沿落在完整卡片或记录之间。展开侧栏“业务网站”，确保示例网站列表完整可见，再确认筛选和当前网站范围。
2. **使用当前界面和演示数据。** 新建独立的只读预览，网站、商品和付款人明确标注“示例”，商户订单号、支付宝流水号与支付宝交易号使用 `DEMO_` 前缀。不要导入真实数据库、账号、凭据或账单。等待字体、数据和图表加载完成，加载占位消失，页面动效结束后再截取。
3. **每张只截一屏。** 截取浏览器当前可见的区域，保持文字与控件的原始比例。长页面选择能说明功能的位置，分别截取；不用全页长图缩小后充当一屏截图。
4. **检查成图。** 核对标题、数字、字段、边缘和图表是否完整，避免鼠标提示、残留菜单、加载中状态或意外选中文本遮挡内容。成图应能按 README 实际显示宽度清楚阅读。
5. **分别全宽展示。** 两张图各用独立的 Markdown 图片段落，按正文可用宽度显示。不要放进并排表格或窄列，也不要为了塞进同一行缩小图片。

选定成图保存到 README 引用的素材目录；未选用的截图、拍摄参数和核对记录保存到独立工作目录。重新拍摄时沿用同一规格和取景位置，便于比较界面变化。

## 浏览器回归

下面是已有的 Playwright 检查命令，可在 CI 或需要检查指定功能时运行。先安装 Chromium，再完成构建；用例运行期间不要重新构建或清理构建目录。

```sh
npx playwright install chromium
npm run build
npm run test:ui -- --project core
```

`core` 检查核心流程和指定功能；需要遍历全部页面时，使用 `npm run test:ui:full`。运行单个文件可用 `npm run test:ui -- ui-tests/business-flow.spec.ts --project core`；测试环境和数据代码的类型检查命令为 `npm run typecheck:ui`。

用例会创建独立临时实例。下单到通知的连续流程使用应用实际的 Hono、SQLite、签名和业务服务，支付宝和通知接收方则由测试代码模拟。检查时继续使用应用原有的 CSP、网站／账号归属检查，以及防止财务操作重复执行的幂等规则。

浏览器缓存可通过 `PLAYWRIGHT_BROWSERS_PATH` 指定。输出位置由 [playwright.config.ts](../../playwright.config.ts) 决定：`PERPAY_UI_OUTPUT_DIR` 指定完整目录；未设置时使用 `.ui-audit/runs/<运行名>/`，运行名可通过 `PERPAY_UI_RUN` 设置。每次运行使用独立目录，结束后用 `node scripts/summarize-ui-run.mjs <输出目录>` 汇总结果。失败时的操作轨迹（trace）、截图，以及 axe 提出的人工复核项，都保存在这次运行的记录中。

<a id="现有-ci-与专项入口"></a>

## CI 与其他检查命令

| 入口 | 当前执行范围 |
| --- | --- |
| [ci.yml](../../.github/workflows/ci.yml) | `npm run check`、依赖审计，以及分片运行的 Chromium `core` |
| [release.yml](../../.github/workflows/release.yml) | 发布版本、OpenAPI、类型、测试、构建、依赖审计和 Chromium `core`；发布流程见工作流 |
| [container-validation.yml](../../.github/workflows/container-validation.yml) | Linux amd64/arm64 存储、Compose、备份与恢复验证 |
| [支付宝 SDK 接口检查](../../scripts/validation/alipay-sdk/README.md) | 检查应用实际使用的 SDK 适配器如何发请求、验签、保存原始响应和控制传输；包含在已有 Node 测试入口中 |
| [易支付客户端兼容检查](../../scripts/validation/epay/README.md) | 按需在独立环境中，用固定版本的 PHP/Go SDK 和 New API 实际请求 PerPay |
| [调用端 Demo](../../examples/node-client/README.md) | 原生、V1、V2 的业务接入与接收端行为 |
| 查询性能脚本 | `scripts/benchmark-admin-queries.ts`、`scripts/benchmark-manual-candidates.ts`，测量对应查询的执行时间 |

列表性能脚本通过 Node 的 `--experimental-strip-types` 运行。根据改动选择已有专项，不把整套自动化命令作为每次日常开发的前置步骤。

## Linux 升级与进程恢复

[run-linux-validation.mjs](../../scripts/validation/run-linux-validation.mjs) 使用预先构建的本地 Linux 镜像。宿主需要项目支持的 Node.js 和 Docker；镜像架构与 Docker 引擎匹配，并包含版本及 40 位提交 SHA 的 OCI 标签。

升级起点固定为 RC1，其数据库结构版本（schema）为 38；被检查的新版本使用 [DATABASE_COMPATIBILITY.maximum](../../src/version.ts) 中的结构版本。将以下标签替换为已构建的镜像，并按需调整输出目录：

```sh
node scripts/validation/run-linux-validation.mjs --phase=all --rc1-image=perpay-validation:rc1 --candidate-image=perpay-validation:candidate --output=./.scratch/linux-validation
```

| 参数 | 用途 |
| --- | --- |
| `--phase=all` | 运行升级、恢复与存储相关检查 |
| `--phase=upgrade` | 升级、备份与匹配版本恢复 |
| `--phase=recovery` | 检查新版本镜像在进程被中断后能否恢复，可省略 RC1 镜像 |
| `--phase=storage` | 存储专项，与容器 CI 对应 |
| `--scenarios=...` | 选择逗号分隔的恢复场景，名称见脚本中的 `scenarios` |

脚本为每次运行生成唯一标识、临时密钥和独立数据卷，只操作带有这次运行标识的容器和卷。容器使用 `network none`、只读根文件系统和受限权限，生产数据卷不参与检查。成功后清理这次创建的资源；失败时保留资源清单供排查，输出保留在指定目录。

升级检查先核对原有网站等标识和审计哈希链，再继续执行业务操作、备份与恢复。中断检查会在保存付款事务、领取通知任务（claim）、处理通知确认响应（ACK），或写入审计暂存文件（spool）的指定步骤发送 SIGKILL，强制结束进程；随后检查任务占用记录（租约）和进程能否正确恢复。记录结果时，写明实际检查了哪个步骤。

`result.json` 保存检查结果，`resources.json` 列出这次运行创建的资源；`private-run.json` 含临时密钥，留在本地核对。
