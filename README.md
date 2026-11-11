<!-- SPDX-License-Identifier: MIT -->

<p align="center">
  <img src="web/src/assets/favicon.svg" alt="PerPay" width="64" height="64">
</p>
<h1 align="center">PerPay</h1>
<p align="center"><strong>面向个人开发者、可自行部署的支付宝收款系统</strong></p>
<p align="center">收款码收银台 · 自动查账 · 多网站与多账号 · 原生 API 与易支付</p>

<p align="center">
  <a href="https://github.com/Mashiro0619/PerPay/releases"><img src="https://img.shields.io/github/v/release/Mashiro0619/PerPay?include_prereleases&label=Release" alt="最新发布"></a>
  <a href="https://github.com/Mashiro0619/PerPay/pkgs/container/perpay"><img src="https://img.shields.io/badge/GHCR-amd64%20%7C%20arm64-2496ED?logo=docker&logoColor=white" alt="Docker：amd64 和 arm64"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Mashiro0619/PerPay" alt="MIT License"></a>
</p>

<p align="center">
  <a href="#部署">快速部署</a> ·
  <a href="docs/alipay-setup.md">配置支付宝</a> ·
  <a href="docs/integration-quickstart.md">接入业务网站</a> ·
  <a href="docs/README.md">全部文档</a> ·
  <a href="CHANGELOG.md">版本记录</a>
</p>

PerPay 将下单、展示收款码、查询支付宝账单和通知业务网站连成一个流程。一次部署可管理多个业务网站和支付宝账号，无需在手机上安装监听软件。

系统通过支付宝开放平台查询账务明细，按**收款账号、应付金额和付款时间**匹配订单。例如商品标价 10 元，收银台可能要求支付 10.03 元；顾客需要按完整金额付款。错付、迟付和重复付款可在后台核对处理。退款需要管理员自行处理，完成后再在 PerPay 登记。

## 功能

| 你要做什么 | PerPay 提供什么 |
| --- | --- |
| 为网站接收付款 | 收款码收银台、付款状态查询、原生 API、易支付 V1/V2 |
| 管理多个业务 | 每个网站有自己的密钥、订单和通知；可指定收款账号，也可随机或按设定比例分配 |
| 确认收款并通知网站 | 自动查账，向网站发送带签名的收款通知；发送失败后自动重试，也可查看记录并手动重发 |
| 处理异常付款 | 订单与流水相互核对、人工关联、争议处理及操作记录 |
| 了解收款情况 | 今日指标、7 / 30 / 90 天趋势、网站概览、订单筛选与 CSV 导出 |
| 维护收款服务 | Docker 部署、自动备份、恢复工具、操作日志和版本提醒 |

## 界面预览

以下截图中的网站、商品、付款人和交易编号都是专门生成的示例数据。

### 全部网站总览

集中查看所有网站的今日收款、趋势和待处理数量。

![PerPay 全部网站总览：今日指标、收款趋势与待处理数量](docs/screenshots/dashboard-light.png)

### 单网站工作台

选择一个业务网站，查看商品、订单金额和付款状态。

![PerPay 单网站订单：商品、金额与付款状态](docs/screenshots/workspace-site.png)

## 部署前准备

- **服务器**：安装 Docker 和 Docker Compose v2，支持 `amd64` 或 `arm64`。Windows 可使用 WSL2 的 Linux 容器。
- **访问地址**：公网部署准备域名、HTTPS 证书与反向代理；本机试用可使用 HTTP。
- **支付宝**：准备收款码，以及已上线、具备对应收款账户账务明细查询权限的开放平台应用。申请与配置步骤见[支付宝配置](docs/alipay-setup.md)。

订单如何匹配付款、何时可以再次使用同一应付金额，见[订单金额和付款期限](USAGE.md#金额复用冷却与付款截止)。业务网站收到通知后需要验证签名，也可以主动查单；确认付款成功后再发货或开通服务。

## 免责声明

PerPay 是需要自行部署的开源软件，不是支付宝官方产品。软件可能存在缺陷，使用前请自行判断是否适合你的业务。**在法律允许免责的范围内，因使用本项目导致的支付宝账号风控、冻结或封禁、收付款异常、资金损失等问题，由使用者自行承担，项目作者、维护者和贡献者不承担责任。** 法律规定必须承担的责任除外，详见[免责声明](DISCLAIMER.md)。

## 部署

<a id="1-下载配置"></a>

### 1. 下载配置

下面的配置默认使用 `latest`，也就是最新稳定版镜像：

```sh
mkdir -p perpay && cd perpay
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/Mashiro0619/PerPay/main/docker-compose.yml
```

需要指定版本或体验预发布版时，再按[固定版本与回滚](docs/maintenance.md#固定版本与回滚)操作。

<a id="2-修改配置"></a>

### 2. 设置访问地址

编辑 `docker-compose.yml` 顶部的配置：

| 配置项 | 填写方式 |
| --- | --- |
| `x-perpay-image` | 默认 `ghcr.io/mashiro0619/perpay:latest`，通常不用修改。 |
| `x-perpay-public-url` | PerPay 的公开地址，如 `https://pay.example.com`，不带路径。 |
| `x-perpay-trusted-proxy-cidrs` | 反向代理连接到 PerPay 时使用的 IP 或网段，多个用逗号分隔。本机直接访问时留空。 |
| `x-perpay-host-port` | 默认 `127.0.0.1:6190:6190`，供宿主机上的反向代理访问。 |
| `x-perpay-setup-token-enabled` | 默认 `"false"`。改为 `"true"` 后，首次创建管理员还需要填写启动日志中的一次性令牌。 |

在服务器上配置反向代理，将域名转发到 `http://127.0.0.1:6190`。代理 IP 怎么填，见[反向代理配置示例](docs/reverse-proxy.md)。

本机试用时，把公开地址设为 `http://localhost:6190`，可信代理留空，浏览器也使用这个地址。

<a id="3-启动"></a>

### 3. 启动服务

公网部署先按[首次访问控制](docs/reverse-proxy.md#首次访问控制)限制后台访问，创建管理员后再开放。

```sh
docker compose config --quiet
docker compose up -d
docker compose ps
```

启动失败时查看 `docker compose logs --tail=100 app backup`。

## 初始化

1. 打开 `https://你的域名/admin/`；本机试用打开 [http://localhost:6190/admin/](http://localhost:6190/admin/)。
2. 设置管理员密码，至少 6 个字符，建议使用随机长密码。若启用了初始化令牌，从 `docker compose logs --tail=100 app` 中读取最近一次 `administrator_setup_required` 的 `setup_token`。
3. 登录并按向导[配置支付宝账号](docs/alipay-setup.md)，完成密钥与收款码设置、连接检查。
4. [创建业务网站](docs/multi-site.md)，选择收款账号；在接入助手中选择原生 API 或易支付 V1/V2。
5. 从业务网站下单并支付一笔小额订单，确认 **PerPay 显示“收款已确认”，业务网站也已收到通知并完成发货或服务开通**。

暂时无法收款时，打开“运行状态”查看原因；通知发送失败时，打开订单中的通知记录。如果启用了初始化令牌，服务重启后令牌会更换，首次设置时使用最新值。

## 更新

使用默认的 `latest` 时，先[完成备份](docs/maintenance.md#启用与验证备份)，再在保存 `docker-compose.yml` 的目录执行：

```sh
docker compose pull
docker compose stop app backup
docker compose up -d
docker compose ps
```

这些命令会下载最新稳定版并重启服务。后台“运行状态 → 官方更新”可以查看新版本说明。使用指定版本或需要退回旧版本时，按[升级与回滚](docs/maintenance.md#固定版本与回滚)操作。

## 数据与备份

| 数据卷 | 保存内容 |
| --- | --- |
| `perpay-data` | 数据库：订单、流水、配置与审计记录 |
| `perpay-backups` | 数据库备份及维护记录 |
| `perpay-secrets` | 自动生成的主密钥，恢复加密配置时必需 |

自动备份默认每 24 小时运行、保留 7 份，可在“系统设置 → 自动备份”调整。将数据库备份和原主密钥分别另存到服务器之外。

**删除数据卷或执行 `docker compose down --volumes` 会删除订单、配置、备份和主密钥。** 更换服务器请按[恢复数据库](docs/maintenance.md#恢复数据库)操作；忘记密码可[停服重设](docs/maintenance.md#忘记管理员密码)。

## 文档导航

| 任务 | 文档 |
| --- | --- |
| 配置收款环境 | [支付宝配置](docs/alipay-setup.md) · [反向代理](docs/reverse-proxy.md) |
| 接入业务系统 | [快速接入](docs/integration-quickstart.md) · [易支付 V1/V2](docs/epay-integration.md) · [Node.js Demo](examples/node-client/README.md) |
| 查询接口与错误 | [完整接口参考](USAGE.md) · [错误处理](docs/integration-errors.md) · [OpenAPI](openapi.yaml) |
| 管理与维护 | [多网站管理](docs/multi-site.md) · [备份、恢复与排错](docs/maintenance.md) · [数据与隐私](docs/privacy.md) |
| 参与开发 | [开发导航](docs/development/README.md) · [前端开发](web/README.md) · [本地预览](docs/development/ui-verification.md#本地预览) |

全部资料见[文档索引](docs/README.md)，版本变化见[变更日志](CHANGELOG.md)。技术栈为 Node.js 24、TypeScript、Hono、SQLite、React、Vite 和 shadcn/ui。

## 许可证

[MIT License](LICENSE) · [免责声明](DISCLAIMER.md)。第三方代码与素材见 [NOTICE](NOTICE)，安全问题请[私密报告](SECURITY.md)。

## 友链

[Linux Do](https://linux.do/)
