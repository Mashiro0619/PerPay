<!-- SPDX-License-Identifier: MIT -->

# PerPay

自托管的支付宝经营码收款服务，包含收银台、自动查账确认和管理后台。无需另装数据库或单独部署前端。

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

反向代理安装在宿主机时，将域名转发到 `http://127.0.0.1:6190`，并通过 `X-Forwarded-For` 传递客户端 IP。Docker 转发后的代理来源可能是桥接网关，不要直接照填 `127.0.0.1`。

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

## 更新

更新前做好备份，在原部署目录执行：

```sh
docker compose pull
docker compose up -d
```

默认使用 `latest`。固定版本或回滚见 [维护说明](docs/maintenance.md#固定版本与回滚)。

## 数据与备份

| 数据卷 | 内容 |
| --- | --- |
| `perpay-data` | 订单和配置 |
| `perpay-backups` | 数据库备份 |
| `perpay-secrets` | 自动生成的主密钥，恢复配置时必需 |

自动备份默认启用，可在 **实例设置 → 自动备份** 调整。请将备份和主密钥另存到服务器之外。

**不要删除数据卷或执行 `docker compose down --volumes`。** 恢复步骤见 [维护说明](docs/maintenance.md#恢复数据库)。

忘记管理员密码？见 [停服重设密码](docs/maintenance.md#忘记管理员密码)，无需删除数据。

## 其他文档

- [业务网站接入](USAGE.md) · [调用端 Demo](examples/node-client/README.md)
- [开发说明](web/README.md) · [API 文档](openapi.yaml)

[MIT License](LICENSE)
