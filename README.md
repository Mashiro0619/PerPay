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

## 网站接入

在后台“设置 → API”生成 `default` 客户端 API 密钥。客户端密钥只放在发起支付网站的后端，不能放进浏览器 JavaScript。

网站后端创建订单时，向 PerPay 的 `POST /api/v1/orders` 发送带 HMAC-SHA256 签名的 JSON 请求。下面是 Node.js 示例：

```js
import { createHash, createHmac, randomBytes } from "node:crypto";

const perpayUrl = "https://pay.example.com";
const clientId = process.env.PERPAY_CLIENT_ID ?? "default";
const secret = Buffer.from(process.env.PERPAY_API_SECRET, "base64url");

async function perpayRequest(method, target, value = null) {
  const body = value === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(32).toString("base64url");
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const signingText = [
    "PERPAY-HMAC-SHA256", "v1", method.toUpperCase(), target,
    timestamp, nonce, clientId, bodyDigest,
  ].join("\n");
  const signature = createHmac("sha256", secret).update(signingText).digest("hex");

  const response = await fetch(new URL(target, perpayUrl), {
    method,
    headers: {
      "content-type": "application/json",
      "x-perpay-client-id": clientId,
      "x-perpay-timestamp": timestamp,
      "x-perpay-nonce": nonce,
      "x-perpay-signature-version": "v1",
      "x-perpay-signature": signature,
    },
    body: body.length === 0 ? undefined : body,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`PerPay ${response.status}: ${JSON.stringify(result)}`);
  return result.data;
}

const order = await perpayRequest("POST", "/api/v1/orders", {
  idempotency_key: "shop-order-20260820-0001", // 重试同一订单必须保持不变
  merchant_order_no: "ORDER-20260820-0001",
  amount_cents: 1000,                            // 10.00 元
  description: "示例商品",
  // notify_url: "https://shop.example.com/webhooks/perpay", // 可选
});

// 将这个地址返回给前端，或由网站后端直接 302 跳转。
console.log(order.checkout.checkout_url);
```

创建订单响应中的 `checkout.checkout_url` 是付款页面，用户付款后回到该页面即可看到确认结果。网站后台可以用同样的签名方式轮询 `GET /api/v1/orders/{order_id}`，读取 `data.payment.status`：`CONFIRMED` 表示已确认，`UNPAID` 表示未支付，`DISPUTED` 表示需要管理员处理。

如果已在后台配置通知地址，PerPay 会向 `notify_url` 发送签名事件。网站应使用原始请求体验证通知签名，并按 `event_id` 做幂等处理；通知失败不会撤销已经确认的支付。完整字段和错误响应见 [`openapi.yaml`](openapi.yaml)。

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
