<!-- SPDX-License-Identifier: MIT -->

# PerPay

面向个人开发者的开源、自托管经营码收款系统。正常付款自动确认，只有异常交易才需要管理员处理。

## 原理

```text
创建订单 → 分配唯一金额 → 展示经营码 → 验签采集流水
         → 唯一匹配 → 自动确认 → 异步通知
```

金额推断是经营码模式下的证据，不是平台订单级证明；只有账户、币种、金额、时间和冲突条件都唯一时才会自动确认。应用镜像与 SQLite 数据分离，数据保存在 Docker volume 中，更新容器不会删除订单。

## 安装

仅支持 Linux Docker（`amd64`、`arm64`）。下载 Release 附带的 `docker-compose.yml`，填写文件顶部首次部署必填项中的 `CHANGE_ME` 值，至少包括：

- 管理员初始密码 `PERPAY_INITIAL_ADMIN_PASSWORD`
- 公网地址 `PERPAY_PUBLIC_URL`（本地测试可保留 `http://localhost:8080`）
- API 密钥 `PERPAY_API_SECRET`（客户端 ID 默认是 `default`）
- 经营码内容 `PERPAY_COLLECTION_CODE_PAYLOAD`
- 启用采集时的支付宝应用 ID、应用私钥和平台公钥

通知默认关闭；只有把 `PERPAY_WEBHOOK_ENABLED` 改为 `true` 时，才填写通知域名和密钥。

然后运行：

```sh
docker compose config --quiet
docker compose up -d
```

初始化完成后删除 `PERPAY_INITIAL_ADMIN_PASSWORD` 并重建 `app`。配置值中的 `$` 写成 `$$`；不要把填写后的 Compose、私钥或 API 密钥提交到 Git。公网请放在 HTTPS 反向代理后面。

## 更新

默认使用 `latest`，保留原 Compose 和数据卷：

```sh
docker compose pull
docker compose up -d
```

不要执行 `docker compose down --volumes`。应用启动时会自动备份并迁移数据库。

## 回滚

把 `app`、`backup`、`maintenance` 三处 `image:` 一起改为 Release 提供的固定版本，例如 `ghcr.io/mashiro0619/perpay:0.1.0`，再运行：

```sh
docker compose --profile maintenance pull
docker compose up -d
```

若新版本已经升级了数据库 schema，仅改标签不能回滚，需从升级前备份恢复。

## 接口

- OpenAPI：[`openapi.yaml`](openapi.yaml)
- 管理后台：`/admin`
- 存活检查：`/healthz`
- 收款就绪检查：`/readyz`

通知使用 HMAC 签名，接收方按 `event_id` 幂等处理。

## 开发

```sh
npm ci --ignore-scripts
npm run check
```

技术栈：Node.js 24 LTS、Hono、TypeScript、`node:sqlite`、Usuzumi。

## 许可证

[`MIT License`](LICENSE)
