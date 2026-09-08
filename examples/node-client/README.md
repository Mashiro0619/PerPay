# PerPay 调用端 Demo

本机演示：创建订单、查单和接收付款通知。需要 **Node.js 24.15+（24.x）**，无需安装依赖。

## 启动

1. [配好 PerPay](https://github.com/Mashiro0619/PerPay/blob/main/docs/alipay-setup.md)，在“实例设置 → 密钥与安全”复制 **网站 API 密钥**。
2. 解压 `demo.zip`，在 `perpay-client-demo` 文件夹打开终端。使用源码时进入 `examples/node-client`。
3. 复制配置模板：

   ```powershell
   Copy-Item .env.example .env
   ```

   macOS / Linux 使用 `cp .env.example .env`。已有 `.env` 直接编辑。

4. 编辑 `.env`，先只填两项：

   ```dotenv
   PERPAY_URL=https://你的PerPay域名
   PERPAY_API_SECRET=粘贴网站API密钥
   ```

   地址与部署时的 `PERPAY_PUBLIC_URL` 一致，不带 `/admin`；本机可用 `http://127.0.0.1:6190`。通知相关两项先留空。

5. 运行 `npm start`，打开 [http://127.0.0.1:6196](http://127.0.0.1:6196)。按 Ctrl+C 停止；修改配置后需重启。

## 创建与查单

1. 填商品和金额（0.01–100.00 元），勾选确认，点击 **“创建订单”**。
2. 打开收银台，核对收款方，按显示的准确金额付款。**这是真实付款；仅创建订单不会扣款。**
3. 返回 Demo，点击 **“查询 PerPay 状态”**。页面自动刷新只读取本机记录，不代替查单。

超时或失败时，查原订单或点 **“按原参数重试创建”**，不要换单号。同一单号不能改金额或其他参数；新订单才换新单号。

## 可选：接收付款通知

1. 在 PerPay 启用“业务通知”，“允许的 Origin”填 `https://shop.example.com`（换成自己的域名，不带路径），保存并取得 **通知签名密钥**。
2. 在与 Demo 同机的 HTTPS 反向代理中，**只转发** `POST /webhooks/perpay` 到 `http://127.0.0.1:6196/webhooks/perpay`。保留原始正文和 `X-PerPay-Webhook-*` 请求头。
3. 在 `.env` 同时填写：

   ```dotenv
   DEMO_NOTIFY_URL=https://shop.example.com/webhooks/perpay
   PERPAY_WEBHOOK_SECRET=粘贴通知签名密钥
   ```

4. 重启后创建**新订单**，付款后查看“已验签通知”。旧订单的通知地址不会随配置改变。

需要可公网访问的 HTTPS 地址；没有就跳过，手动查单即可。不要暴露整个 Demo，它没有用户登录。

## 其他

- 端口占用：修改 `DEMO_PORT`。订单保存在 `DEMO_DATA_DIR`（默认 `data`）；切换 PerPay 实例时换新目录。
- 不要分享 `.env` 和 `data`。密钥只用于后端；示例不执行发货、充值或退款，不能原样上线。
- 请求签名见 `perpay.mjs`，订单与通知去重见 `store.mjs`。签名器仅支持示例中的固定订单路径，不是通用 SDK；扩展前阅读 [接口与通知协议](https://github.com/Mashiro0619/PerPay/blob/main/USAGE.md)。
- 运行 `npm test` 测试，无需真实密钥；仓库根目录运行 `npm run demo:package` 生成 `dist/demo.zip`。
