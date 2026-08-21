<!-- SPDX-License-Identifier: MIT -->

# PerPay

面向个人开发者的开源支付宝经营码收款服务。正常付款会自动确认，错付、重复或争议交易才需要管理员处理。

## 安装

仅支持 Linux Docker。Windows 请使用 WSL2 的 Linux Docker 环境，不提供原生 Windows 容器方案。

1. 下载 `docker-compose.yml`。
2. 只修改文件顶部的部署参数：
   - `PERPAY_PUBLIC_URL`：访问 PerPay 的完整地址，例如 `https://pay.example.com`。
   - `PERPAY_TRUSTED_PROXY_CIDRS`：使用 HTTPS 反向代理时填写代理网段；没有代理时保持空值。
   - 端口映射：默认 `127.0.0.1:6190:6190`。
3. 检查并启动：

   ```sh
   docker compose config --quiet
   docker compose up -d
   ```

SQLite 不需要数据库用户名或数据库密码。应用首次启动会在 `perpay-secrets` 卷中自动生成主密钥，密钥不会出现在 Compose 或日志中。请保留这个卷；删除它将无法解密数据库中的支付宝密钥。

支付宝经营码、应用 ID、支付宝公钥、网站 API 密钥和通知密钥，全部在启动后登录 `/admin` 配置。

## 初始化

打开 `PERPAY_PUBLIC_URL`，首次访问直接设置管理员密码，然后登录后台按页面流程完成：

1. 生成应用密钥，并把应用公钥上传到支付宝开放平台。
2. 填写应用 ID、平台公钥和生产或沙箱环境。
3. 配置经营码。
4. 生成网站 API 密钥。
5. 按需启用异步通知。
6. 在“备份”设置中配置备份周期和保留数量。

`/healthz` 表示进程和 SQLite 正常；`/readyz` 表示已经可以创建订单。完成配置并成功采集、对账后才会开放收款。

## 接入说明

后台“使用方法”页面提供可复制的签名、创建订单和回调通知示例；根目录的 [`USAGE.md`](USAGE.md) 保存同一套完整中文说明。完整字段、错误码和接口契约见 [`openapi.yaml`](openapi.yaml)。

## 更新与回滚

保留原来的 Compose 文件和卷，更新默认 `latest` 镜像：

```sh
docker compose pull
docker compose up -d
```

不要执行 `docker compose down --volumes`，否则会删除业务数据和自动生成的主密钥。回滚时把三个服务的镜像统一改成固定版本标签，再执行同样的命令。

## 备份与恢复

备份服务默认运行，备份文件保存在 `perpay-backups` 卷。周期和保留数量在后台“备份”页面修改，不需要编辑 Compose。

```sh
docker compose --profile maintenance run --rm maintenance health
docker compose --profile maintenance run --rm maintenance list-backups
```

恢复前停止应用和备份服务，核对备份文件名与 SHA-256，再执行：

```sh
docker compose stop app backup
docker compose --profile maintenance run --rm maintenance restore BACKUP_NAME SHA256 --confirm-replace-current-database
docker compose up -d
```

恢复时必须保留 `perpay-secrets` 卷，否则数据库中的加密配置无法解密。

## 入口与许可

- 管理后台：`/admin`
- 健康检查：`/healthz`
- 收款就绪：`/readyz`
- 完整 API：[`openapi.yaml`](openapi.yaml)

MIT
