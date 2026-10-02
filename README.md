<!-- SPDX-License-Identifier: MIT -->

<p align="center">
  <img src="web/src/assets/favicon.svg" alt="PerPay 钱包图标" width="72" height="72">
</p>
<h1 align="center">PerPay</h1>
<p align="center"><strong>自托管的支付宝经营码收款服务</strong></p>

<p align="center">
  <a href="https://github.com/Mashiro0619/PerPay/releases/latest"><img src="https://img.shields.io/github/v/release/Mashiro0619/PerPay?label=Release" alt="最新正式版本"></a>
  <a href="https://github.com/Mashiro0619/PerPay/pkgs/container/perpay"><img src="https://img.shields.io/badge/GHCR-amd64%20%7C%20arm64-2496ED?logo=docker&logoColor=white" alt="Docker 镜像：amd64 和 arm64"></a>
  <a href="https://nodejs.org/en/about/previous-releases"><img src="https://img.shields.io/badge/Node.js-24.15%2B%20%2824.x%29-5FA04E?logo=nodedotjs&logoColor=white" alt="Node.js 24.15+，24.x"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Mashiro0619/PerPay" alt="MIT License"></a>
  <a href="https://github.com/Mashiro0619/PerPay/stargazers"><img src="https://img.shields.io/github/stars/Mashiro0619/PerPay?style=flat" alt="GitHub Stars"></a>
</p>

<p align="center">
  <a href="#界面预览">界面预览</a> ·
  <a href="#部署">快速部署</a> ·
  <a href="docs/alipay-setup.md">支付宝配置</a> ·
  <a href="USAGE.md">接入文档</a>
</p>

**适用边界：** 静态经营码没有逐单交易凭证，PerPay 按金额与时间推断订单归属，并非支付宝官方逐单支付网关。适合能够人工核对的小规模收款；错付金额、迟到付款或重复付款需要商户核查。确认收款与业务通知送达是两件事。

## 功能

| 功能 | 说明 |
| --- | --- |
| 经营码收银台 | 展示应付金额与二维码，查询付款状态 |
| 自动查账与对账 | 查询到账流水、匹配订单，支持异常处理与人工核对 |
| 订单管理 | 按创建日期搜索、筛选订单，查看付款确认时间并导出 CSV |
| 业务通知 | 签名回调、失败重试与投递记录 |
| 收款概览 | 今日确认金额／笔数、待处理事项及近 7 / 30 / 90 天趋势 |
| 自托管运维 | Docker 部署、自动备份与版本检查 |
| 界面显示 | 自定义系统名称、商家帮助链接、首页图表样式，支持明暗主题 |

技术栈：**Node.js 24 · TypeScript · Hono · SQLite · React · Vite · shadcn/ui**。

## 界面预览

| 收款概览 | 订单详情 |
| --- | --- |
| ![收款概览](docs/screenshots/dashboard-light.png) | ![订单详情](docs/screenshots/order-detail.png) |

<details>
<summary>展开查看桌面收银台</summary>

![收银台](docs/screenshots/checkout.png)

</details>

[本地只读预览](web/README.md#只读预览) · [全部截图](docs/screenshots/README.md)

## 部署前准备

- Linux 服务器，安装 Docker 和 Docker Compose v2；Windows 使用 WSL2 的 Linux 容器。
- 公网使用需准备域名和 HTTPS 反向代理。
- 支付宝经营码，以及具备账务明细查询权限的开放平台应用。

## 部署

### 1. 下载配置

在服务器终端执行：

```sh
mkdir -p perpay && cd perpay
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/Mashiro0619/PerPay/main/docker-compose.yml
```

### 2. 修改配置

编辑 `docker-compose.yml` 顶部的三项：

| 配置项 | 怎么填 |
| --- | --- |
| `x-perpay-public-url` | 你的 HTTPS 地址，如 `https://pay.example.com`，不带路径。 |
| `x-perpay-trusted-proxy-cidrs` | PerPay 容器实际看到的直连代理 IP 或网段，多个用逗号分隔；HTTPS 部署必填。 |
| `x-perpay-host-port` | 默认 `127.0.0.1:6190:6190`，只允许从宿主机访问。 |

反向代理安装在宿主机时，将域名转发到 `http://127.0.0.1:6190`，并通过 `X-Forwarded-For` 传递客户端 IP。Docker 转发后的代理来源可能是桥接网关，不要直接照填 `127.0.0.1`。宿主机与容器代理的完整示例见 [反向代理部署](docs/reverse-proxy.md)，不要信任所有来源。

仅在本机试用：把 `x-perpay-public-url` 改为 `http://localhost:6190`，代理配置留空，无需域名。

### 3. 启动

首次启动前，先限制域名访问，只允许自己；创建管理员后再对外开放。

```sh
docker compose config --quiet
docker compose up -d
docker compose ps
```

启动失败时查看日志：`docker compose logs --tail=100 app backup`。

## 初始化

1. 访问 `https://你的域名/admin`；本机试用访问 [http://localhost:6190/admin](http://localhost:6190/admin)。
2. 创建管理员并登录，密码至少 6 个字符，建议使用更长的随机密码。
3. 按 [支付宝配置图文教程](docs/alipay-setup.md) 完成向导，检查收款就绪。

订单结束后的应付金额默认冷却 10 分钟再复用；这不是补付宽限期，也不能完全消除静态码的归属风险。付款截止与重试规则见 [接入说明](USAGE.md#金额复用冷却与付款截止)。

## 更新

每次登录后台会自动检查官方更新：正式版只提示正式版；预发布版（如 `-rc.1`）同时检查正式版与预发布版。也可在 **运行状态 → 官方更新** 手动检查。仅检查版本，不自动升级。检查由服务器访问 GitHub，不发送订单、配置或密钥；成功结果缓存 5 分钟，失败后等待 60 秒再试，不影响收款。

更新前做好备份，在原部署目录执行：

```sh
docker compose pull
docker compose up -d
```

默认使用稳定版 `latest`，预发布版不会覆盖它。预发布 Release 附件固定到对应版本，详见 [预发布版本与更新通道](docs/maintenance.md#预发布版本与更新通道)；固定版本或回滚见 [维护说明](docs/maintenance.md#固定版本与回滚)。

## 数据与备份

| 数据卷 | 内容 |
| --- | --- |
| `perpay-data` | 订单和配置 |
| `perpay-backups` | 数据库备份 |
| `perpay-secrets` | 自动生成的主密钥，恢复配置时必需 |

自动备份默认启用，可在 **实例设置 → 自动备份** 调整。请将备份和主密钥另存到服务器之外。

**不要删除数据卷或执行 `docker compose down --volumes`。** 恢复步骤见 [维护说明](docs/maintenance.md#恢复数据库)。

忘记管理员密码？见 [停服重设密码](docs/maintenance.md#忘记管理员密码)，无需删除数据。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [支付宝配置](docs/alipay-setup.md) | 应用、密钥、经营码与首次收款检查 |
| [业务网站接入](USAGE.md) | 请求签名、订单接口、业务通知与金额匹配规则 |
| [调用端 Demo](examples/node-client/README.md) | 业务网站接入示例 |
| [维护说明](docs/maintenance.md) | 备份恢复、版本升级、回滚与密码重设 |
| [前端开发](web/README.md) · [OpenAPI](openapi.yaml) | 构建、测试与接口定义 |

## 许可证

PerPay 使用 [MIT License](LICENSE)。第三方代码与素材说明见 [NOTICE](NOTICE)。

## 友链

[Linux Do](https://linux.do/)
