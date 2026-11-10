<!-- SPDX-License-Identifier: MIT -->

# 开发验证

以下命令在仓库根目录执行。先安装依赖并完成 `npm run build`；构建、`npm run check` 与浏览器验证依次运行，避免浏览器读取到正在清理的 `web-dist`。架构约束见[前端开发](../../web/README.md#后台交互约束)。

## 本地预览

```sh
npm run build
npm run demo:preview
```

打开 `http://127.0.0.1:6192/admin/`，演示密码为 `123456`。预览使用独立临时库、随机主密钥、合成订单与非付款二维码，只绑定回环地址；Ctrl+C 退出时清理临时数据。更新代码后停止旧进程、重新构建并在原端口启动，不以刷新页面或叠加端口代替重启。

| 参数 | 用途 |
| --- | --- |
| `--interactive` | 允许管理员 API 修改临时数据，验证保存、校验及版本冲突 |
| `--official-updates` | 仅允许真实 GitHub 官方版本元数据查询 |
| `--port 6192` | 显式指定本地端口 |

参数放在 `npm run demo:preview --` 后。默认只读，仅允许登录、退出及受保护导出；两种模式都不启动支付宝查账或通知传输，公开收银台仍受演示限制，健康状态为模拟。需要热更新时，将 `PERPAY_DEV_API_URL` 设为预览地址，再运行 `npm run dev:admin`。

启动日志的 `featured` 定位完整收款与通知证据订单，`scenarios.lifecycle`、`financial`、`ledger`、`notifications` 提供本次对象 ID。通过页面或日志定位，不硬编码编号、网站名称和日期；重启会生成新 ID 和会话。造数及只读边界回归为 `test/preview-demo.test.ts`、`test/preview-scenarios.test.ts`。

预览重建临时库后，各浏览器标签页首次登录会回到全部网站总览，清除地址中的旧网站、记录和弹窗上下文。同一轮预览再次登录时保留原页面。

## 浏览器回归

流水与付款来源断言保留当前交互：手机流水主链接显示付款人，完整流水号位于记录元数据；订单中的“核对凭据”和流水中的“支付宝交易编号”先展开再核对。弹窗几何检查约束布局滚动容器，原生多行文本框的内部滚动单独验证键盘可达性，不计为第二个布局滚动区。

首次安装 Chromium，完成构建后选择所需范围：

```sh
npx playwright install chromium
npm run test:ui -- --project core
npm run test:ui:full
```

`core` 运行核心与专项流程，`full` 运行完整页面矩阵。单项可用 `npm run test:ui -- ui-tests/business-flow.spec.ts --project core`；夹具和 Playwright 类型检查为 `npm run typecheck:ui`。列表查询性能可分别运行 `scripts/benchmark-admin-queries.ts` 和 `scripts/benchmark-manual-candidates.ts`，使用 Node 的 `--experimental-strip-types`，它们不验证财务写入。

用例自行启动独立临时实例；只读场景、受控响应场景和真实领域写入场景应分别说明。连续业务流程使用实际 Hono、SQLite、签名与领域服务，仅模拟外部支付宝与通知接收端；测试订单、带回调业务订单和人工处理订单是不同对象，不能混为一笔交易。

布局变更检查桌面和窄屏、明暗主题、长内容、200% 文字、键盘焦点及滚动可达性；交互变更检查深链接刷新、前进后退、网站范围、未保存草稿、并发冲突、离线及未知结果恢复。收银台另测无脚本和 hydration。使用生产 CSP，不通过隐藏错误、强制点击或放宽策略使验收通过。

产物默认写入 `.ui-audit/runs/`，可用环境变量 `PERPAY_UI_RUN` 指定运行目录名，或用 `PERPAY_UI_OUTPUT_DIR` 指向其他磁盘上的完整输出目录。临时数据库位置由系统临时目录配置决定。运行后执行 `node scripts/summarize-ui-run.mjs <输出目录>` 汇总已有证据。保留实际源码／构建摘要、浏览器、视口、截图及失败 trace；不将产物提交到源码库。axe 未确定项需人工复核，动效需可重复操作或录屏。

## Linux 升级与进程恢复

使用 [Linux 验证脚本](../../scripts/validation/run-linux-validation.mjs)，宿主需满足 [package.json](../../package.json) 的 Node.js 版本范围，并能运行 Docker 的 Linux 容器。先从待验证的源码分别构建本地基线与候选镜像；脚本不构建或拉取镜像。镜像架构须匹配 Docker 引擎的 `linux/amd64` 或 `linux/arm64`，具有 `org.opencontainers.image.version` 和 40 位提交 SHA 的 `org.opencontainers.image.revision` 标签。历史基线固定为 RC1/schema 38；候选升级、备份恢复及存储验证使用 [版本声明](../../src/version.ts) 中的 `DATABASE_COMPATIBILITY.maximum`，并由镜像内夹具严格核对实际结构版本。

将以下镜像名替换为已构建的本地标签：

```sh
node scripts/validation/run-linux-validation.mjs --phase=all --rc1-image=perpay-validation:rc1 --candidate-image=perpay-validation:candidate --output=.scratch/linux-validation
```

`--phase=upgrade` 仅验证升级、备份与恢复；`--phase=recovery` 仅验证候选镜像的中断恢复，此时可省略 `--rc1-image`。`--scenarios` 接受逗号分隔的恢复场景名，取值见脚本的 `scenarios` 列表。

脚本为每轮生成唯一标识、临时密钥和独立卷，所有容器使用 `network none`、只读根文件系统及受限权限，并核对角色挂载。只允许访问本轮隔离标记对应的数据，不挂载生产卷。成功后按双重标签核对并清理自己创建的容器和卷；失败时保留资源清单，需核对所属者与本轮运行标签后人工清理。输出保留在指定目录。

升级验证先核对原业务身份和审计链，再执行业务推进、真实备份及匹配版本恢复。中断验证等待支付事务、通知 claim／ACK 或审计 spool 的精确边界握手后发出 SIGKILL，检查退出码与自然租约恢复；不通过 SQL 修改业务状态或租约制造成功。

公开分享 `result.json` 前核对内容；`private-run.json` 含本轮隔离密钥，不分享或提交。数据库和领域服务是实际镜像代码，外部支付宝与通知接收端为模拟；进程中断恢复不等于断电、真实外网传输或生产实例验收。Chromium 手机仿真也不等于实体设备验收。
