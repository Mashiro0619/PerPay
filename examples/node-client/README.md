# PerPay 调用端 Demo

默认通过**回调通知**确认付款，验签保存后页面自动更新；手动查单只作补偿。需要 **Node.js 24.15+（24.x）**，无需安装依赖。

## 配置与启动

1. [配好 PerPay](https://github.com/Mashiro0619/PerPay/blob/main/docs/alipay-setup.md)，复制**网站 API 密钥**。启用“业务通知”，允许的 Origin 填你的业务域名（如 `https://shop.example.com`），保存并取得**通知签名密钥**。
2. 将业务域名下的 `POST /webhooks/perpay` 转发到 Demo 的 `http://127.0.0.1:6196/webhooks/perpay`，保留原始正文和请求头。**只开放回调路径**，Demo 页面没有登录保护。
3. 解压 `demo.zip`，在 `perpay-client-demo` 中打开终端；源码位于 `examples/node-client`。复制配置模板：

   ```powershell
   Copy-Item .env.example .env
   ```

   Linux / macOS 使用 `cp .env.example .env`。已有 `.env` 直接编辑，填好四项：

   ```dotenv
   PERPAY_URL=https://你的PerPay域名
   PERPAY_API_SECRET=网站API密钥
   DEMO_NOTIFY_URL=https://你的业务域名/webhooks/perpay
   PERPAY_WEBHOOK_SECRET=通知签名密钥
   ```

   PerPay 地址不带 `/admin`；两种密钥不要混用。回调地址和签名密钥缺一项都会停止启动，不会自动退回查单模式。

4. 运行 `npm start`，打开 [http://127.0.0.1:6196](http://127.0.0.1:6196)。远程服务器运行时，用 SSH 转发端口访问页面。修改配置后需重启。

## 试一笔

1. 填商品和金额（0.01–100.00 元），勾选确认，点击**创建订单**。
2. 打开收银台，核对收款方，按显示的准确金额付款。**这是真实付款；仅创建订单不会扣款。**
3. 返回 Demo 等待自动更新，并在**已验签通知**查看回调记录。页面每 5 秒读取本地记录，不会轮询 PerPay。

未收到通知时，先检查 PerPay 的“业务通知”投递记录，也可点**手动查单**补查。超时重试用原单号和原参数；更换回调配置只影响新订单，旧订单仍按原配置重试。

## 其他

- 端口用 `DEMO_PORT` 调整；订单和通知保存在 `DEMO_DATA_DIR`（默认 `data`）。切换 PerPay 实例时换新目录。
- 不要分享 `.env` 和 `data`。示例不执行发货、充值或退款，不能原样上线。
- 签名见 `perpay.mjs`，通知验签后入库、去重及版本保护见 `store.mjs`；协议见 [接入说明](https://github.com/Mashiro0619/PerPay/blob/main/USAGE.md)。
- `npm test` 运行合成数据测试；仓库根目录 `npm run demo:package` 生成 `dist/demo.zip`。
