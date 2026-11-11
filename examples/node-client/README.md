# PerPay 调用端 Demo

用这个示例完成下单、打开收银台、接收并验证付款通知。支持原生 API、易支付 V1 和 V2，需要 **Node.js 24.15+（24.x）**，无需安装依赖。

示例把订单参数和已验签通知保存在本地 SQLite 数据库，重启后可以继续查看和处理。收到通知时更新付款状态，也可手动查单补查；发货、充值和退款由接入的业务系统实现。

## 配置与启动

从与你的 PerPay 版本对应的 [GitHub Release](https://github.com/Mashiro0619/PerPay/releases) 下载 `demo.zip`，解压后进入 `perpay-client-demo`。使用仓库源码时进入 `examples/node-client`。发布包的 `package.json` 标明版本，包内教程链接也指向对应版本。

先按[支付宝接入教程](https://github.com/Mashiro0619/PerPay/blob/main/docs/alipay-setup.md)配置收款账号并创建业务网站。在「网站设置 → 接入与通知」选择协议，复制服务地址／网关、客户端 ID／PID，并查看对应凭据。

| `PAYMENT_PROTOCOL` | 必填连接配置 |
| --- | --- |
| `native`（默认） | `PERPAY_URL`、`PERPAY_CLIENT_ID`、`PERPAY_API_SECRET`，以及通知密钥。 |
| `epay_v1` | `EPAY_URL`、`EPAY_PID`、`EPAY_V1_KEY`。 |
| `epay_v2` | `EPAY_URL`、`EPAY_PID`、`EPAY_MERCHANT_PRIVATE_KEY`、`EPAY_PLATFORM_PUBLIC_KEY`。 |

三种模式都需要填写完整的 HTTPS 通知地址 `DEMO_NOTIFY_URL`，返回地址 `DEMO_RETURN_URL` 可选。PerPay 服务地址如 `https://pay.example.com`，不带 `/admin` 或 `/api`；易支付网关以 `/` 结尾。V2 密钥可用完整 PEM 或单行 Base64。

首次运行时复制模板；已有 `.env` 直接编辑：

```powershell
Copy-Item .env.example .env
```

Linux / macOS 使用 `cp .env.example .env`。下面是一份原生协议配置：

```dotenv
PAYMENT_PROTOCOL=native
PERPAY_URL=https://pay.example.com
PERPAY_CLIENT_ID=从网站接入助手复制
PERPAY_API_SECRET=网站API密钥
PERPAY_WEBHOOK_SECRET=网站通知密钥
DEMO_NOTIFY_URL=https://shop.example.com/webhooks/perpay
DEMO_RETURN_URL=https://shop.example.com/return
DEMO_PORT=6196
DEMO_DATA_DIR=data-shop
```

已有密钥可直接使用，缺少时再生成。原生 API 密钥用于签名下单和查询请求，通知密钥用于验证收到的通知。需要同时接受新旧两把通知密钥时，按下一节配置各自的 key-id。

示例监听本机地址 `127.0.0.1`，通过 Nginx 将公网通知地址转发到示例服务；配置了浏览器返回地址时，也转发对应路径。创建订单等操作页面仍从本机访问。在业务域名的 Nginx `server` 中添加：

```nginx
location = /webhooks/perpay {
    proxy_pass http://127.0.0.1:6196;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
}

# 配置 DEMO_RETURN_URL 时添加。
location = /return {
    proxy_pass http://127.0.0.1:6196;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
}
```

执行 `sudo nginx -t`，检查通过后用 `sudo systemctl reload nginx` 重载。原生回调为 POST，易支付回调为 GET；代理保留方法、原始正文、请求头和查询参数。使用自定义路径或固定查询参数时，同步修改 `.env` 与代理路径。

在 PerPay 保存通知来源 `https://shop.example.com` 并开启通知；配置了返回地址时，也保存对应返回来源。这里的“来源”只包含 `https://`、域名和必要的端口，完整路径填在 Demo 的 URL 配置中。

启动示例：

```shell
npm start
```

打开 [http://127.0.0.1:6196](http://127.0.0.1:6196)。在远程服务器运行时，可从自己的电脑建立隧道，再打开同一地址：

```shell
ssh -N -L 6196:127.0.0.1:6196 user@server
```

启动时会向 PerPay 查询接入信息，确认服务地址和网站身份与本地数据库记录一致，因此 PerPay 须可访问。修改 `.env` 后重启。原生协议更换客户端 ID 时更新 `PERPAY_CLIENT_ID`；稳定网站编号没有改变，同一网站可继续使用原数据目录。

<a id="通知密钥轮换与可重试错误"></a>

## 更换通知密钥与处理错误

原生协议支持两种通知验签配置：

- `PERPAY_WEBHOOK_SECRET`：单密钥模式，直接用该密钥验证签名，不单独限定 key-id。
- `PERPAY_WEBHOOK_KEYS`：列出 key-id 和密钥的对应关系，最多同时使用当前和上一版本两把密钥。与单密钥配置二选一。

映射配置示例：

```dotenv
PERPAY_WEBHOOK_SECRET=
PERPAY_WEBHOOK_KEYS='{"11111111-1111-4111-8111-111111111111":"当前通知密钥","22222222-2222-4222-8222-222222222222":"上一把通知密钥"}'
```

替换示例 ID 和密钥。登录 PerPay 后台，从对应通知的技术信息中取得 `key_id`，填入该次发送所用的密钥。更换密钥前保存仍需接受的旧密钥，取得新版本后更新配置并重启；疑似泄露的旧密钥应停止使用。添加 key-id 与密钥的对应关系时，以后台配置为准。

| 接收结果 | Demo 响应 | 处理方式 |
| --- | --- | --- |
| 映射模式中的未知 key-id | `503` | 登录 PerPay 后台核对并补齐密钥配置，再等待 PerPay 重试。 |
| 格式正确的通知时间戳与本机相差超过五分钟 | `503` | 校准两端时钟。通知时间戳使用毫秒。 |
| 头部无效或已知密钥的签名错误 | `401` | 核对原始正文、请求头和密钥。 |
| 验签通过且成功写入数据库 | `200`，按协议返回 JSON 成功回执（ACK） | 页面读取本地新状态。 |

验签或保存失败时，示例不会回复成功 ACK。PerPay 按该网站的通知策略重试，修复配置后可在通知发送记录中查看进度。

## 试一笔

1. 在本机页面填写商品和金额（0.01–100.00 元），勾选确认后创建订单。
2. 打开收银台，核对收款方和准确应付金额，再付款。创建订单不会扣款，扫码付款使用真实资金。
3. 返回 Demo，在“已验签通知”查看记录。页面每 5 秒读取本地记录，收到通知后更新状态。

通知未到时，先在 PerPay 的“业务通知”中查看发送记录，也可点击“手动查单”。下单超时或结果未知时，按原业务单号查单；点击重试会使用本地保存的原单号、幂等键和参数。

确认旧单收银台已 `EXPIRED` 或 `CLOSED` 且仍未付款后，新的付款尝试使用新商户单号，重新核对收银台金额和二维码。保留旧单，继续处理后续合法通知。更改回调配置影响新订单，已有订单保留原请求参数。

<a id="其他"></a>

## 数据目录与代码入口

- `DEMO_PORT` 调整监听端口，`DEMO_DATA_DIR` 指定数据目录，相对路径以示例目录为起点。`.env` 和数据库包含凭据、订单及通知，应留在服务端。
- 原生请求签名与通知验签见 [perpay.mjs](perpay.mjs)，易支付见 [epay.mjs](epay.mjs)，数据库保存、重复通知处理和订单版本检查见 [store.mjs](store.mjs)，HTTP 接收见 [server.mjs](server.mjs)。
- 接入业务系统时，还需检查用户权限和订单内容，并实现防止重复执行的发货、充值等任务。状态处理和失败恢复见[完整协议参考](https://github.com/Mashiro0619/PerPay/blob/main/USAGE.md)。
- 维护示例时，在示例目录执行 `npm test` 可检查合成场景；在仓库根目录执行 `npm run demo:package` 可生成 `dist/demo.zip`。

## 多网站与本地数据

每份示例连接一个网站。多个网站分别使用各自的凭据、回调地址、端口和数据目录，并在 PerPay 分别配置通知来源。

| 模式 | 数据目录绑定 | 未设置 `DEMO_DATA_DIR` 时的目录 |
| --- | --- | --- |
| 原生 | PerPay 服务地址、稳定网站编号 | `data` |
| 易支付 V1 | PerPay 服务地址、固定 PID、协议 | `data-PID-epay_v1` |
| 易支付 V2 | PerPay 服务地址、固定 PID、协议 | `data-PID-epay_v2` |

模板中的 `DEMO_DATA_DIR=data` 会覆盖上述默认目录。连接另一套 PerPay、更换网站或切换协议时，使用新目录；同一网站更换密钥后继续使用原目录。旧版原生示例数据库可在原 PerPay 的 `default` 网站下继续使用，不能修改环境变量后当作另一站的数据。

易支付模式通过 API 下单取得收银台链接。收到通知或浏览器返回请求时，先验签，再主动查单核对商户单号、商品原价和当前付款状态。两者使用同一份数据库记录，防止重复处理；已处理订单再次收到有效通知时，仍返回 `success`。V2 响应和通知均检查五分钟时间偏差。

易支付查询返回商品原价，实际应付金额在收银台显示。易支付接口不提供订单版本号，Demo 自己记录每次状态变化的版本；曾确认收款的订单随后查到未付款时，显示付款争议并等待核查。未带成功签名的 `/return` 展示返回提示，付款状态由有效通知或查单更新。
