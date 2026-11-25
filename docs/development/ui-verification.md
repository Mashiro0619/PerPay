<!-- SPDX-License-Identifier: MIT -->

# 开发验证

日常改动以对应维度的类型检查、构建与人工核对为主，自动化套件按需或在 CI 中执行。命令均在仓库根目录运行；环境要求见[开始开发](README.md#开始开发)，前端交互不变量见[后台交互约束](../../web/README.md#后台交互约束)。

## 本地预览

```sh
npm run build
npm run demo:preview -- --interactive
```

打开 `http://127.0.0.1:6192/admin/`（密码 `123456`）。预览进程仅监听 loopback，每次启动创建独立临时 SQLite 库、随机主密钥与演示数据（二维码不可真实付款，健康/查账/通知均由本地 mock 驱动），按 `Ctrl+C` 退出时自动清理临时库。

| 参数（置于 `--` 后） | 行为 |
| --- | --- |
| 无参数 | 只读预览：支持登录/登出，写接口拒绝，导出仍走鉴权 |
| `--interactive` | 允许管理 API 修改临时库，用于验证保存、校验、乐观锁冲突与删除 |
| `--official-updates` | 实际请求 GitHub Releases 检查更新，替代本地 mock |
| `--port <port>` | 指定监听端口（默认 `6192`） |

- **定位预置场景**：启动日志输出 `featured`（含完整收款与通知链路的示例订单）及 `scenarios.lifecycle` / `financial` / `ledger` / `notifications` ID 映射。重启后必须重新读取日志 ID 并重新登录（新临时库首次登录回到全部网站总览，同一实例再次登录保留原路径）。
- **代码更新流程**：停旧预览 → 重新构建 → 原端口启动，避免静态资源清单与服务端版本错位。需要前端 HMR 时按[开发与构建](../../web/README.md#开发与构建)挂接 Vite。

## 日常手工核对

执行完对应的 `typecheck` 与 `build` 后，按改动域对照检查：

| 改动域 | 核对清单 |
| --- | --- |
| 布局 / 文案 / 样式 | 桌面与窄屏、明暗主题、200% 字号缩放、矮视口下的可读性与滚动；纯键盘可达性 |
| 表单与配置 | 保存/取消/字段报错；切换编辑分组保留草稿；刷新失败、`config_version` 冲突、请求超时/结果未知时的恢复路径 |
| 列表与 Overlay 详情 | 筛选/排序/分页；打开与关闭详情保留列表状态；详情直链刷新与浏览器前进/后退；关闭后焦点归位 |
| 多站点边界 | 请求 `client_id` 准确；全局视图与单站视图严格隔离；切换或删除网站后缓存、选中态与表单草稿不串站 |
| 账务与通知展示 | 下单/应付/实收金额区分、付款截止、收款确认状态、通知回执与重试原因；展开“核对凭据”/“支付宝交易编号”核对完整编号、来源标签与复制按钮 |
| 公开收银台 | SSR 首屏 HTML、Hydration 接管、禁用 JS 刷新降级、二维码展示、到期/关闭/争议终态、返回商家跳转 |

手工验证记录应包含：Commit SHA、构建产物版本、浏览器版本、页面 URL、操作步骤与实际结果；涉及真实支付宝小额实付、真实下游回调或真机测试时单独留痕。

## README 截图

1. **视口与主题规格**：`1440×1000` CSS 视口、DPR `1`、浅色主题、100% 缩放；展开侧栏“业务网站”确保示例网站完整可见，再核对筛选条件与当前站点范围。
2. **数据脱敏与就绪时机**：使用全新只读预览（严禁导入真实库/账号/账单），网站/商品/付款人带“示例”标识，单号/流水号统一 `DEMO_` 前缀；等字体、接口数据、图表渲染完毕且骨架屏与动效结束后再截图。
3. **单屏截取**：仅截当前可见视口，保持原始比例；长页面选关键首屏分张截取，禁止整页长图缩放充当单屏图。
4. **成图质检**：核对数字、标签、边界与图表完整，无残留 tooltip/popover/loading/误选文本；按 README 实际展示宽度仍清晰可读。
5. **排版约定**：README 采用一行两列 HTML 表格（每列 `50%`，图片 `width="100%"`），保留原图尺寸并外包原图链接。

定稿存入 README 引用的素材目录；候选题材、参数和复核日志放独立工作目录，重拍时沿用相同规格与取景以便前后比对。

## 浏览器回归

基于 Playwright 的端到端测试（真实 Hono + SQLite + 签名与业务服务，仅 mock 支付宝与通知接收端，保留 CSP、站点/账号租户检查与财务幂等校验）。运行期间禁止并发重建或清理产物目录：

```sh
npx playwright install chromium
npm run build
npm run test:ui -- --project core
```

| 命令 | 作用 |
| --- | --- |
| `npm run test:ui -- --project core` | 运行核心业务流与关键约束回归 |
| `npm run test:ui:full` | 遍历全部页面与完整矩阵 |
| `npm run test:ui -- ui-tests/business-flow.spec.ts --project core` | 运行单个 spec 文件 |
| `npm run typecheck:ui` | 检查 `ui-tests/` 及测试夹具类型 |
| `node scripts/summarize-ui-run.mjs <输出目录>` | 汇总单次运行结果（含失败 trace、截图及 axe 人工复核项） |

环境变量（见 [playwright.config.ts](../../playwright.config.ts)）：`PLAYWRIGHT_BROWSERS_PATH` 指定浏览器缓存；`PERPAY_UI_OUTPUT_DIR` 指定完整输出路径，未设置时默认写入 `.ui-audit/runs/<PERPAY_UI_RUN>/`。

<a id="现有-ci-与专项入口"></a>

## CI 与专项验证入口

| 入口 | 覆盖范围 |
| --- | --- |
| [ci.yml](../../.github/workflows/ci.yml) | `npm run check`、依赖审计、分片 Chromium `core` |
| [release.yml](../../.github/workflows/release.yml) | 版本号、OpenAPI、类型、单测、构建、依赖审计、Chromium `core` 及发布流水线 |
| [container-validation.yml](../../.github/workflows/container-validation.yml) | Linux `amd64`/`arm64` 存储权限、Compose、备份与恢复验证 |
| [支付宝 SDK 验证](../../scripts/validation/alipay-sdk/README.md) | SDK 适配器签名、验签、原始响应保存与传输限制（已纳入常规 Node 测试） |
| [易支付兼容验证](../../scripts/validation/epay/README.md) | 独立环境下用固定版本 PHP/Go SDK 与 New API 实测交互 |
| [调用端 Demo](../../examples/node-client/README.md) | 原生 / V1 / V2 端到端联调与接收端验签 |
| 查询基准脚本 | `scripts/benchmark-admin-queries.ts`、`scripts/benchmark-manual-candidates.ts`（通过 `node --experimental-strip-types` 运行） |

## Linux 升级与进程恢复

[run-linux-validation.mjs](../../scripts/validation/run-linux-validation.mjs) 针对预构建的本地 Linux 镜像执行升级、备份恢复与故障注入测试。宿主机需具备支持版本的 Node.js 与同架构 Docker，镜像须携带版本与 40 位 Commit SHA 的 OCI 标签。

- **升级基线**：固定起点为 RC1（Schema v38），目标版本为候选镜像对应的 [DATABASE_COMPATIBILITY.maximum](../../src/version.ts)。

```sh
node scripts/validation/run-linux-validation.mjs \
  --phase=all \
  --rc1-image=perpay-validation:rc1 \
  --candidate-image=perpay-validation:candidate \
  --output=./.scratch/linux-validation
```

| 参数 | 覆盖内容 |
| --- | --- |
| `--phase=all` | 依次运行升级、崩溃恢复与存储专项 |
| `--phase=upgrade` | RC1 → 候选版本迁移（先校验站点 ID 与审计哈希链，再执行业务写入、备份与同版本恢复） |
| `--phase=recovery` | `SIGKILL` 故障注入恢复验证（可省略 `--rc1-image`） |
| `--phase=storage` | 容器存储权限专项（与容器 CI 对齐） |
| `--scenarios=...` | 逗号分隔指定恢复场景（可选值见脚本内 `scenarios` 定义） |

**隔离与故障注入机制**：

- 每次运行生成唯一 Run ID、临时主密钥与独立数据卷，容器启用 `--network none`、只读根文件系统与受限权限，绝不触碰生产卷；通过后自动清理资源，失败时保留资源供排障。
- 故障注入在**付款事务落库**、**通知任务 claim（租约）**、**通知 ACK 处理**、**审计 spool 落盘**等断点精确发送 `SIGKILL`，重启后校验租约回收与数据一致性（记录结果时须写明具体注入点）。
- 输出产物：`result.json`（断言结果）、`resources.json`（创建的容器/卷清单）、`private-run.json`（含临时密钥，仅留本地）。
