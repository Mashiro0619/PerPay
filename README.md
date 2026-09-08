<!-- SPDX-License-Identifier: MIT -->

# PerPay

面向个人开发者的开源支付宝经营码收款服务。正常付款会自动确认，错付、重复或争议交易才需要管理员处理。内置轻量管理控制台，也保留完整管理 API。

## 安装

仅支持 Linux Docker。Windows 请使用 WSL2 的 Linux Docker 环境，不提供原生 Windows 容器方案。

1. 下载 `docker-compose.yml`。
2. 只修改文件顶部的部署参数：
   - `PERPAY_PUBLIC_URL`：访问 PerPay 的完整地址，例如 `https://pay.example.com`。
   - `PERPAY_TRUSTED_PROXY_CIDRS`：使用 HTTPS 反向代理时填写直接连接到 PerPay 的代理网段；没有反向代理时只能使用回环地址，例如 `http://localhost:6190`，并保持空值。
   - 端口映射：默认 `127.0.0.1:6190:6190`。
3. 检查并启动：

   ```sh
   docker compose config --quiet
   docker compose up -d
   ```

SQLite 不需要数据库用户名或数据库密码。应用首次启动会在 `perpay-secrets` 卷中自动生成主密钥，密钥不会出现在 Compose 或日志中。请保留这个卷；删除它将无法解密数据库中的支付宝密钥。

Compose 中的 `https://pay.example.com` 只是 HTTPS 部署占位值，不能直接原样启动：请改成你的真实 HTTPS 地址，并填写反向代理的可信网段。若先在服务器本机验证，可将地址改为 `http://localhost:6190`；该回环 HTTP 地址不能作为公网收款地址。

访问 `/admin` 管理控制台，配置支付宝经营码、应用 ID、支付宝公钥、网站 API 密钥和通知。根路径 `/` 会跳转到控制台；公开收银台仍使用独立的原生页面，不加载管理前端。

## 初始化

启动后在浏览器打开 `/admin`，按提示创建管理员、登录，并依次生成应用密钥、配置支付宝、设置经营码和生成 API 密钥。首次初始化应在可信网络中完成；设置密码前不要将未初始化的实例暴露到公网。

也可以使用同源 JSON 请求完成相同操作：

1. `POST /api/admin/v1/setup` 设置管理员密码。
2. `POST /api/admin/v1/session/login` 创建管理员会话，并保存 CSRF Cookie。
3. 通过 `/api/admin/v1/settings/...` 配置应用密钥、支付宝平台、经营码、API、通知和备份。
4. 使用 `/healthz` 和 `/readyz` 检查服务及收款链路状态。

`/healthz` 表示进程和 SQLite 正常；`/readyz` 表示已经可以创建订单。完成配置并成功采集、对账后才会开放收款。

## 接入说明

签名、创建订单和回调通知示例保存在根目录的 [`USAGE.md`](USAGE.md)。完整字段、错误码和接口契约见 [`openapi.yaml`](openapi.yaml)。

## 管理控制台

- 收款概览：真实统计、采集/确认链路状态、最近订单及待处理事项。确认金额按事件聚合，不代表净结算收入。
- 订单：付款与收银台状态筛选、完整订单号查询、时间线、对账依据及完整通知历史。
- 账务处理：查看匹配、异常、冲突和流水证据；人工关联、撤销错误关联、登记已发生退款。退款登记不会发起支付宝退款或转账。
- 业务通知：查看投递结果和尝试记录，对符合条件的终态通知创建新一代投递。
- 实例设置：支付宝、经营码、通知、密钥、密码、会话、备份策略与高级配置。

技术栈为 React + TypeScript + Vite、React Router、TanStack Query 和原生 CSS，不使用 UI 组件库。管理资源由现有 Hono 服务同源提供，无需另部署前端服务。页面支持窄屏、系统深色模式及键盘操作。

源码构建运行 `npm ci --ignore-scripts`、`npm run build`。前端热更新、接口类型生成和验证方式见 [`web/README.md`](web/README.md)。Docker 构建会自动打包控制台；所有前端工具和框架在运行时镜像中会被裁剪，仅保留静态产物。

管理控制台调用本实例的真实管理 API，不依赖演示服务器。`test/admin-browser-fixture.ts` 仅用于隔离界面验收，不用于正式收款。容器验收与发布工作流还会验证管理员初始化、登录退出、CSP、分包资源、配置冲突和重启持久化；真实支付宝收款与业务方通知仍需在完成生产配置后单独联调。

## 更新与回滚

保留原来的 Compose 文件和卷，更新默认 `latest` 镜像：

```sh
docker compose pull
docker compose up -d
```

不要执行 `docker compose down --volumes`，否则会删除业务数据和自动生成的主密钥。回滚时把三个服务的镜像统一改成固定版本标签，再执行同样的命令。

## 备份与恢复

备份服务默认运行，备份文件保存在 `perpay-backups` 卷。周期和保留数量可在“实例设置 → 自动备份”或通过 `/api/admin/v1/settings/backup` 修改。恢复仍需使用下面的服务器维护流程。

```sh
docker compose --profile maintenance run --rm maintenance health
docker compose --profile maintenance run --rm maintenance list-backups
docker compose --profile maintenance run --rm maintenance inspect-publication-lock
```

如果备份或恢复进程异常中断，先确认没有维护进程，再按检查结果使用返回的 token 清理超过 7 小时的跨卷发布锁：

```sh
docker compose --profile maintenance run --rm maintenance clear-stale-publication-lock LOCK_TOKEN --confirm-no-maintenance-process
```

恢复前停止应用和备份服务，核对备份文件名与 SHA-256，再执行：

```sh
docker compose stop app backup
docker compose --profile maintenance run --rm maintenance restore BACKUP_NAME SHA256 --confirm-replace-current-database
docker compose up -d
```

恢复时必须保留 `perpay-secrets` 卷，否则数据库中的加密配置无法解密。

## 入口与许可

- 管理控制台：`/admin`
- 管理 API：`/api/admin/v1`
- 健康检查：`/healthz`
- 收款就绪：`/readyz`
- 完整 API：[`openapi.yaml`](openapi.yaml)

MIT
