<!-- SPDX-License-Identifier: MIT -->

# PerPay 调用端示例（Node.js）

本目录提供一个零外部依赖的参考业务服务端，用于联调「创建订单 → 跳转收银台 → 接收并验签回调 → 查单补齐」全流程，支持 **原生 API**、**易支付 V1** 与 **易支付 V2** 三种协议。

- **运行环境**：Node.js 24.15+（24.x），无需执行 `npm install`。
- **本地存储**：订单与已验签通知持久化于本地 SQLite，重启不丢失。

---

## 1. 配置与启动

### 获取示例文件

- 从对应版本的 [GitHub Releases](https://github.com/Mashiro0619/PerPay/releases) 下载 `demo.zip` 解压并进入 `perpay-client-demo`；
- 或直接使用仓库中的 `examples/node-client` 目录。

### 配置 `.env`

```sh
# Linux / macOS
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

在 PerPay 完成 [支付宝配置](https://github.com/Mashiro0619/PerPay/blob/main/docs/alipay-setup.md) 并创建业务网站后，于 **网站设置 → 接入与通知** 获取对应协议凭据（也可通过后台「接入助手」直接导出 `.env`）：

| `PAYMENT_PROTOCOL` | 必填凭据变量 |
| --- | --- |
| `native`（默认） | `PERPAY_URL`、`PERPAY_CLIENT_ID`、`PERPAY_API_SECRET`、`PERPAY_WEBHOOK_SECRET` |
| `epay_v1` | `EPAY_URL`（末尾带 `/`）、`EPAY_PID`、`EPAY_V1_KEY` |
| `epay_v2` | `EPAY_URL`（末尾带 `/`）、`EPAY_PID`、`EPAY_MERCHANT_PRIVATE_KEY`、`EPAY_PLATFORM_PUBLIC_KEY` |

所有协议均需设置公网 HTTPS 回调地址 `DEMO_NOTIFY_URL`（同步返回地址 `DEMO_RETURN_URL` 可选）。原生模式示例：

```dotenv
PAYMENT_PROTOCOL=native
PERPAY_URL=https://pay.example.com
PERPAY_CLIENT_ID=业务网站客户端ID
PERPAY_API_SECRET=网站API密钥
PERPAY_WEBHOOK_SECRET=网站通知密钥
DEMO_NOTIFY_URL=https://shop.example.com/webhooks/perpay
DEMO_RETURN_URL=https://shop.example.com/return
DEMO_PORT=6196
DEMO_DATA_DIR=data-shop
```

### 配置公网回调转发

示例进程仅监听本机 `127.0.0.1:6196`。在业务域名的 Nginx 配置中转发回调与返回路径，保持原始请求体与请求头不变：

```nginx
location = /webhooks/perpay {
    proxy_pass http://127.0.0.1:6196;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
}

# 配置了 DEMO_RETURN_URL 时添加
location = /return {
    proxy_pass http://127.0.0.1:6196;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
}
```

重载 Nginx 后，在 PerPay 后台将该站的 **通知来源** 设为 `https://shop.example.com` 并启用通知（若启用返回地址同步配置「返回来源」）。

### 启动与测试流程

```sh
npm start
```

访问 [http://127.0.0.1:6196](http://127.0.0.1:6196)（在远端服务器运行时，可通过 `ssh -N -L 6196:127.0.0.1:6196 user@server` 端口转发至本机）：

1. 填写商品名称与金额（`0.01–100.00` 元）创建测试订单。
2. 打开收银台链接，按页面显示的完整应付金额完成实际支付。
3. 返回示例页面等待数秒（页面每 5 秒刷新一次），确认收到已验签通知；若未收到可点击「手动查单」或在 PerPay 后台核对通知投递日志。

---

<a id="通知密钥轮换与可重试错误"></a>

## 2. 原生通知密钥轮换与错误响应

原生模式支持单密钥与多密钥映射两种验签配置：

- **单密钥**：配置 `PERPAY_WEBHOOK_SECRET`。
- **多密钥平滑轮换**：留空 `PERPAY_WEBHOOK_SECRET`，配置 `PERPAY_WEBHOOK_KEYS`（支持同时配置新旧两把密钥）：

```dotenv
PERPAY_WEBHOOK_SECRET=
PERPAY_WEBHOOK_KEYS='{"11111111-1111-4111-8111-111111111111":"当前通知密钥","22222222-2222-4222-8222-222222222222":"上一把通知密钥"}'
```

`key-id` 可在 PerPay 通知详情的技术信息中查看。轮换时先将新旧密钥同时写入映射并重启示例，待过渡期结束后移除旧密钥。

| 回调异常场景 | 示例返回状态 | 处理建议 |
| --- | --- | --- |
| 映射中缺少对应 `key-id` | `503` | 更新 `.env` 并重启示例，等待 PerPay 自动重试 |
| 通知毫秒时间戳与本机偏差超过 5 分钟 | `503` | 校准服务器时钟后等待自动重试 |
| 签名不匹配或请求头格式非法 | `401` | 核对密钥配置及反向代理是否改动原始请求体 |
| 验签通过且入库成功 | `200` + 标准 ACK | 页面状态更新为已确认 |

---

<a id="其他"></a>

## 3. 代码结构与数据目录

- **核心模块**：[perpay.mjs](perpay.mjs)（原生请求签名与通知验签）、[epay.mjs](epay.mjs)（易支付 V1/V2 协议）、[store.mjs](store.mjs)（SQLite 幂等与 `order_version` 保护）、[server.mjs](server.mjs)（HTTP 路由与页面）。
- **数据目录隔离**：每套本地数据目录绑定单个站点与协议。切换至其他 PerPay 实例、其他网站或切换协议时，应修改 `DEMO_DATA_DIR`（未设置时默认使用 `data`、`data-<PID>-epay_v1` 或 `data-<PID>-epay_v2`）。同一网站仅更换密钥或原生客户端 ID 时可继续沿用原目录。
- **测试与打包**：在示例目录执行 `npm test` 运行合成测试；在仓库根目录执行 `npm run demo:package` 生成 `dist/demo.zip`。
- **生产接入**：正式业务系统需自行补齐用户登录鉴权与发货/充值履约任务，完整接口规范见 [USAGE.md](https://github.com/Mashiro0619/PerPay/blob/main/USAGE.md)。
