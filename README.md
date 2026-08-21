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
4. 生成网站接入 API 密钥。
5. 按需启用异步通知。
6. 在“备份”设置中配置备份周期和保留数量。

`/healthz` 表示进程和 SQLite 正常；`/readyz` 表示已经可以创建订单。完成配置并成功采集、对账后才会开放收款。

## 网站接入

API 密钥只能放在网站后端。完整字段、签名规则和错误定义见 [`openapi.yaml`](openapi.yaml)。最小调用示例：

```js
import { createHash, createHmac, randomBytes } from "node:crypto";

const baseUrl = "https://pay.example.com";
const clientId = "default";
const secret = Buffer.from(process.env.PERPAY_API_SECRET, "base64url");
const target = "/api/v1/orders";
const body = Buffer.from(JSON.stringify({
  idempotency_key: "order-20260821-0001",
  merchant_order_no: "ORDER-20260821-0001",
  amount_cents: 1000,
  product_name: "示例商品",
  note: "用户名：demo",
  notify_url: "https://shop.example.com/webhooks/perpay",
  return_url: "https://shop.example.com/orders/paid",
}));
const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = randomBytes(32).toString("base64url");
const bodyHash = createHash("sha256").update(body).digest("hex");
const signingText = ["PERPAY-HMAC-SHA256", "v1", "POST", target, timestamp, nonce, clientId, bodyHash].join("\n");
const signature = createHmac("sha256", secret).update(signingText).digest("hex");

const response = await fetch(new URL(target, baseUrl), {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-perpay-client-id": clientId,
    "x-perpay-timestamp": timestamp,
    "x-perpay-nonce": nonce,
    "x-perpay-signature-version": "v1",
    "x-perpay-signature": signature,
  },
  body,
});
const order = (await response.json()).data;
console.log(order.checkout.checkout_url);
```

订单状态为 `UNPAID`、`CONFIRMED` 或 `DISPUTED`。通知必须验签并按 `event_id` 幂等处理，最终结果以服务端查询或已验签通知为准。

### 回调通知

在后台“设置 → 通知”中启用通知，允许来源填写网站的 HTTPS Origin，例如 `https://shop.example.com`，不要填写路径。然后在“安全”页面查看并复制通知密钥，只保存到网站后端的环境变量中。创建订单时，把 `notify_url` 填成该 Origin 下的具体地址，例如 `https://shop.example.com/webhooks/perpay`。

接收端必须使用原始请求体验签。下面是 Node.js Fetch 风格的示例：

```js
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const webhookSecret = Buffer.from(process.env.PERPAY_WEBHOOK_SECRET, "base64url");

export async function receivePerPayWebhook(request) {
  const body = Buffer.from(await request.arrayBuffer());
  const headers = request.headers;
  const version = headers.get("x-perpay-webhook-version");
  const keyId = headers.get("x-perpay-webhook-key-id");
  const timestamp = headers.get("x-perpay-webhook-timestamp");
  const deliveryId = headers.get("x-perpay-webhook-delivery-id");
  const eventId = headers.get("x-perpay-webhook-event-id");
  const attempt = headers.get("x-perpay-webhook-attempt");
  const received = headers.get("x-perpay-webhook-signature");
  if (!version || !keyId || !timestamp || !deliveryId || !eventId || !attempt || !received) {
    return new Response("invalid webhook headers", { status: 400 });
  }

  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const signingText = [
    "perpay:webhook:v1", keyId, timestamp, deliveryId, eventId, attempt, bodyDigest,
  ].join("\n");
  const expected = `v1=${createHmac("sha256", webhookSecret)
    .update(signingText, "utf8").digest("hex")}`;
  const valid = received.length === expected.length && timingSafeEqual(
    Buffer.from(received, "ascii"),
    Buffer.from(expected, "ascii"),
  );
  if (version !== "1" || !valid) {
    return new Response("invalid webhook signature", { status: 401 });
  }

  const event = JSON.parse(body.toString("utf8"));
  // 在数据库事务中按 event.event_id 去重；重复通知直接返回同一个 ACK。
  await processOnceByEventId(event.event_id, event);
  return Response.json({
    schema: "perpay:webhook-ack:v1",
    ack: true,
    event_id: eventId,
    delivery_id: deliveryId,
  });
}
```

必须返回 HTTP `200`、`application/json`，并且响应体只能包含上面四个字段。网络错误、`5xx`、`429` 或错误的 ACK 会重试；`401`、`403` 等鉴权错误可能直接进入失败或死信。网站业务处理必须以 `event_id` 幂等，不能按投递次数重复执行充值。

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
