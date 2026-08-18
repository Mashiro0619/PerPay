<!-- SPDX-License-Identifier: Apache-2.0 -->

# PerPay

PerPay 是面向个人开发者的开源、自托管经营码收款系统。它通过平台 V3 接口采集并验签账务流水；当账户、币种、金额、经营码配置、金额槽位和时间区间共同得到唯一且无冲突的候选时，系统自动确认订单并通知业务方，其他情况进入人工异常处理。

> 当前 `main` 分支不能用于处理真实资金，也不应直接部署到公网；正式版本的支持状态以对应 Release 和 [安全策略](SECURITY.md) 为准。

本项目是独立开源项目，不由支付平台运营、维护或背书。接口权限、账户政策、备案及法律税务要求需要使用者自行核验。

## 当前能力

- 经营码订单、幂等创建、唯一应付金额和公开收银台页面。
- V3 请求签名、成功响应验签、原始证据留存和账务冲突隔离。
- 唯一流水自动确认、异常人工认领、撤销、退款登记、双式分录和资金异常追踪。
- 管理员会话、CSRF、step-up、API HMAC 签名、限流和审计链。
- 订单事件签名、严格 ACK、有限重试、死信和人工补发。
- SQLite 自动迁移、健康检查、经校验的周期备份、恢复和容器化更新。
- 同源管理后台，覆盖系统状态、订单、异常、结算、冲突、通知和安全操作。

## 部署

正式发布后的推荐路径是下载对应 GitHub Release 附带的 `docker-compose.yml`，填写其中的占位配置，然后运行：

```sh
docker compose up -d
```

仓库根目录的 [docker-compose.yml](docker-compose.yml) 只是生成发布附件的模板，不是固定镜像字节的生产部署证据；正式部署只使用对应 Release 附带的文件。

部署主机必须是 Linux `amd64` 或 `arm64` 服务器，并安装 Docker Engine 以及能够使用 `up --wait --wait-timeout`、`cp` 和长格式健康依赖的 Docker Compose v2 插件。旧版 `docker-compose` v1 不受支持。

Compose 使用同一个不可变镜像运行两个长期服务，并提供一个默认不启动的维护 profile：

- `app`：HTTP API、订单、账务采集、对账和通知。
- `backup`：无网络的周期备份进程。
- `maintenance`：仅在停机恢复时按需运行，同时以可写方式挂载两个卷。

SQLite 数据与本地备份分别保存在两个命名卷中，删除或重建容器不会删除卷。备份卷中的文件是经过完整性校验的明文 SQLite，不等于加密或异地灾备。不要对需要保留数据的实例执行 `docker compose down --volumes`。

项目仅发布并支持 Linux `amd64` 与 `arm64` 容器；Linux Docker 是唯一的部署和发布验收基线。

### 配置要点

`docker-compose.yml` 内的注释是配置字段说明。部署前至少需要：

- 替换所有必填项及已启用功能中的 `CHANGE_ME` 占位值；通知保持关闭时，其专属占位项可以暂不填写。配置中出现 `$` 时写成 `$$`。
- 填写管理员初始密码、API 密钥和经营码原始内容；经营码内容最多为 2331 个 UTF-8 字节。
- 启用账务采集时填写应用 ID、应用私钥和平台公钥。平台公钥不是应用公钥。
- Compose 不提供 TLS 或证书管理。未来的公网入口必须使用外部 HTTPS 反向代理，正确设置公开 origin 与可信直连代理 CIDR，并保持应用端口只绑定宿主机回环地址。
- 将填写后的 Compose 视为高敏感文件，不要提交到 Git、Issue 或日志。部署目录权限不得宽于 `0700`，文件不得宽于 `0600`。完整边界见 [安全策略](SECURITY.md)。

管理员初始密码、API 密钥以及启用后的通知密钥都应独立生成。以下命令会生成一份 32 字节的无填充 base64url 随机值：

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

每项密码或密钥都要重新运行一次，不能复用。管理员初始化成功后，从 Compose 删除 `PERPAY_INITIAL_ADMIN_PASSWORD` 整项并重建应用容器：

```sh
docker compose up -d --wait --wait-timeout 900 app
```

配置错误时查看对应服务日志：

```sh
docker compose logs app
docker compose logs backup
```

## 付款确认模型

账务采集只建立经过验签、可追踪的平台流水事实。系统在同一数据库事务内重读候选并检查账户、币种、精确金额、经营码版本、金额槽位、时间区间和证据冲突；条件仍然严格唯一时，订单直接变为 `CONFIRMED / INFERRED`，同时完成记账并写入付款成功 Outbox。

`INFERRED` 表示金额和时间推断，不是平台提供的订单强关联证明。零候选、多候选、时间重叠、槽位复用、重复流水、错额、迟到或冲突都不会自动确认，而是保留为可审计异常。人工认领、撤销和退款登记同样保留不可变操作历史。

## API

机器可读的路径、请求、响应和错误契约见 [openapi.yaml](openapi.yaml)。API 客户端签名规则和固定测试向量见 [API 认证与签名](docs/API_AUTHENTICATION.md)。

创建订单同时返回 `checkout.state_url`（JSON 状态接口）和 `checkout.checkout_url`（付款人 HTML 收银台）。管理后台位于 `/admin`；浏览器只使用管理员 Cookie 会话、同源 CSRF 和 step-up，不持有商户 API 密钥。

## 运维

- `GET /healthz`：进程与数据库健康检查，供 Docker 判断容器是否正常运行。
- `GET /readyz`：账务采集和自动确认是否足够新鲜，决定能否创建新订单和展示付款指令。
- `GET /api/v1/system/status`：签名认证后的完整运行状态。
- `GET /api/admin/v1/system/status`：管理员会话下的完整运行状态。

自动备份卷默认仍位于同一 Docker 主机，不等于异地灾备。处理重要数据前，应建立加密异地副本并实际演练恢复。

升级使用固定版本镜像和 OCI digest，由 Docker Compose 替换容器；应用不访问 Docker Socket，也不会自行更新。不要使用 `latest` 或无人确认的自动更新工具。

## 文档

| 内容 | 文档 |
| --- | --- |
| 完整 API 契约 | [openapi.yaml](openapi.yaml) |
| API 请求签名 | [docs/API_AUTHENTICATION.md](docs/API_AUTHENTICATION.md) |
| 通知签名、ACK 与重试 | [docs/WEBHOOKS.md](docs/WEBHOOKS.md) |
| 自动备份与恢复 | [docs/BACKUPS.md](docs/BACKUPS.md) |
| 升级、回滚与数据库恢复 | [docs/UPDATES.md](docs/UPDATES.md) |
| 恢复中断与维护锁处置 | [docs/RECOVERY.md](docs/RECOVERY.md) |
| 安全边界与漏洞报告 | [SECURITY.md](SECURITY.md) |
| 正式发布维护 | [docs/RELEASING.md](docs/RELEASING.md) |
| 贡献与本地开发 | [CONTRIBUTING.md](CONTRIBUTING.md) |

## 技术基线

- Node.js 24 LTS、TypeScript 6、Hono 4。
- Node 内置 `node:sqlite`，单应用进程写入。
- Usuzumi 零构建 UI 与普通 CSS/JavaScript 静态资产。
- 同一 Linux 镜像运行应用与备份服务。
- Linux `amd64` 与 `arm64` 镜像目标。

开发检查：

```sh
npm ci --ignore-scripts
npm run check
npm audit --audit-level=high
```

## 许可证

经项目所有者确认，本项目使用 [Apache License 2.0](LICENSE)。第三方组件声明见 [NOTICE](NOTICE)；依赖清单以 `package-lock.json` 为准。
