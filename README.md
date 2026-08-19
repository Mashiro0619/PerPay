<!-- SPDX-License-Identifier: MIT -->

# PerPay

面向个人开发者的开源、自托管经营码收款系统。付款后由系统自动采集流水并确认，只有错付、重复、冲突和退款等异常才需要管理员处理。

## 原理

```text
创建订单 → 分配唯一金额 → 展示经营码 → 验签采集流水
         → 唯一匹配 → 自动确认 → 异步通知
```

应用镜像只保存代码，SQLite 数据和备份保存在 Docker 卷中；更新容器不会删除订单或配置。金额推断是经营码模式下的匹配证据，只有账户、币种、金额、时间和冲突条件都唯一时才会自动确认。

## 部署

仅支持 Linux Docker（`amd64`、`arm64`）。先编辑 `docker-compose.yml` 顶部的部署配置：

- `PERPAY_MASTER_KEY`：64 位十六进制主密钥，必须长期保管，不能随意更换。
- `PERPAY_PUBLIC_URL`：管理员和 API 实际访问的完整地址；使用 HTTPS 反向代理时填写代理后的地址，并填写 `PERPAY_TRUSTED_PROXY_CIDRS`。
- `ports`：默认 `127.0.0.1:6190` 只允许本机访问；公网部署必须使用 HTTPS 反向代理。

可用下面的命令生成主密钥：

```sh
openssl rand -hex 32
```

本项目使用 SQLite，不需要另设数据库密码。经营码、应用 ID、支付宝公钥、API 密钥和通知配置不要写进 Compose。填写完成后启动：

```sh
docker compose up -d
```

首次设置完成前不要将反向代理开放到公网；默认端口映射只允许宿主机本地访问。

打开 `PERPAY_PUBLIC_URL`，首次访问会要求设置管理员密码；完成后使用该密码登录后台。业务配置按下面的顺序完成：

1. 由系统生成应用密钥，复制应用公钥并上传到支付宝开放平台。
2. 将开放平台给出的支付宝公钥、应用 ID 和环境保存到系统。
3. 保存经营码，并生成 `default` 客户端的 API 密钥。
4. 按需开启异步通知；通知不是开放收款的必填项。

应用私钥由系统加密保存，不需要用户生成或粘贴。配置完成且首次采集、对账成功后，`/readyz` 才会返回 200。管理员密码之后可在“安全”页面修改。

首次密码设置没有额外验证码。设置完成前不要向公网开放反向代理，只从可信网络或 SSH 隧道访问；初始化完成后再开放公网入口。

## 更新

保留原来的 Compose 文件和卷，执行：

```sh
docker compose pull
docker compose up -d
```

不要使用 `docker compose down --volumes`。回滚时将三个服务的 `image` 从 `latest` 改为同一个固定版本标签，再运行上面的命令。

## 接口与开发

- 管理后台：`/admin`
- 进程检查：`/healthz`
- 收款就绪检查：`/readyz`
- OpenAPI：[`openapi.yaml`](openapi.yaml)

```sh
npm ci --ignore-scripts
npm run check
```

技术栈：Node.js 24 LTS、Hono、TypeScript、`node:sqlite`、React、Material UI。

## 许可证

MIT
