# PerPay 调用端 Demo

默认通过**回调通知**确认付款，验签保存后页面自动更新；手动查单只作补偿。需要 **Node.js 24.15+（24.x）**，无需安装依赖。

## 配置与启动

1. [配好 PerPay](https://github.com/Mashiro0619/PerPay/blob/main/docs/alipay-setup.md)，创建业务网站，进入“网站设置 → 接入与通知”。先点击“生成／轮换 API 密钥”和“生成／轮换通知密钥”，复制**网站 API 密钥**、**通知签名密钥**和**客户端 ID**。已有密钥可直接查看复用，无需轮换；先保持通知关闭，保存配置不会自动生成密钥。
2. 将业务域名下的 `POST /webhooks/perpay` 转发到 Demo 的 `http://127.0.0.1:6196/webhooks/perpay`，保留原始正文和请求头。**只开放回调路径**，Demo 页面没有登录保护。
3. 解压 `demo.zip`，在 `perpay-client-demo` 中打开终端；源码位于 `examples/node-client`。复制配置模板：

   ```powershell
   Copy-Item .env.example .env
   ```

   Linux / macOS 使用 `cp .env.example .env`。已有 `.env` 直接编辑，填好五项：

   ```dotenv
   PERPAY_URL=https://你的PerPay域名
   PERPAY_CLIENT_ID=业务网站页面显示的客户端ID
   PERPAY_API_SECRET=网站API密钥
   DEMO_NOTIFY_URL=https://你的业务域名/webhooks/perpay
   PERPAY_WEBHOOK_SECRET=通知签名密钥
   ```

   PerPay 地址不带 `/admin`；两种密钥不要混用。回调地址和签名密钥缺一项都会停止启动，不会自动退回查单模式。

4. 运行 `npm start`，打开 [http://127.0.0.1:6196](http://127.0.0.1:6196)。远程服务器运行时，用 SSH 转发端口访问页面。修改配置后需重启。
5. 接收端配置完成后，回到该网站的“网站设置 → 接入与通知”，通知来源填业务域名的 HTTPS Origin（如 `https://shop.example.com`，不带回调路径），开启通知并保存。确认保存成功后再创建测试订单；订单的回调地址必须属于该来源。

## 通知密钥轮换与可重试错误

已有的 `PERPAY_WEBHOOK_SECRET` 单密钥配置继续可用，适合尚未取得 key-id 的首次接入；此模式只按签名验证，不单独限制 key-id。需要按 key-id 区分新旧密钥时，清空它，改填 `PERPAY_WEBHOOK_KEYS`，内容为一把或两把通知密钥的 JSON 映射：

```dotenv
PERPAY_WEBHOOK_SECRET=
PERPAY_WEBHOOK_KEYS='{"11111111-1111-4111-8111-111111111111":"当前通知密钥","22222222-2222-4222-8222-222222222222":"上一把通知密钥"}'
```

上例的 ID 与值都是占位符。key-id 可从 PerPay 后台对应通知的投递详情／技术信息中的 `key_id` 获取，须与该次投递所用的密钥版本对应；不要从未验签的外部请求自动建立映射。轮换前自行保留仍需接收的旧通知密钥，取得新版本 ID 后更新配置并重启示例。接收端保留两把密钥不会改变 PerPay 服务端的轮换策略。

映射模式中，未知 key-id 返回 `503`，便于补齐配置后由 PerPay 重试；已知 ID 的错误签名仍返回 `401`。合法毫秒时间戳与本机偏差超过五分钟时返回 `503`，先检查两端时钟。无效头部格式仍返回 `401`。这些失败均不会保存事件或返回成功 ACK，重试次数仍受 PerPay 的投递策略限制。

## 试一笔

1. 填商品和金额（0.01–100.00 元），勾选确认，点击**创建订单**。
2. 打开收银台，核对收款方，按显示的准确金额付款。**这是真实付款；仅创建订单不会扣款。**
3. 返回 Demo 等待自动更新，并在**已验签通知**查看回调记录。页面每 5 秒读取本地记录，不会轮询 PerPay。

未收到通知时，先检查 PerPay 的“业务通知”投递记录，也可点**手动查单**补查。请求超时或响应丢失、下单结果尚未明确时，先按原业务单号查单；重试下单仍使用原单号和原参数，避免重复创建订单。

服务端已确认旧单收银台为 `EXPIRED` 或 `CLOSED` 且仍未付款时，新的付款尝试应使用新的 `merchant_order_no` 重新下单，并核对新收银台的金额与二维码。保留旧单记录及其原始参数，继续处理旧单后续的合法通知；收银台过期本身不能作为忽略后来付款确认的依据。更换回调配置只影响新订单，旧订单仍按原配置重试。

## 其他

- 端口用 `DEMO_PORT` 调整；订单和通知保存在 `DEMO_DATA_DIR`（默认 `data`）。切换 PerPay 实例时换新目录。
- 不要分享 `.env` 和 `data`。示例不执行发货、充值或退款，不能原样上线。
- 签名见 `perpay.mjs`，通知验签后入库、去重及版本保护见 `store.mjs`；协议见 [接入说明](https://github.com/Mashiro0619/PerPay/blob/main/USAGE.md)。
- `npm test` 运行合成数据测试；仓库根目录 `npm run demo:package` 生成 `dist/demo.zip`。

## 多网站与本地数据

每份示例服务连接一个明确的网站，必须填写 `PERPAY_CLIENT_ID`，不会自动使用 `default`。多份业务网站可以指向同一 `PERPAY_URL`，但分别使用各自 API／通知密钥、回调地址、端口和 `DEMO_DATA_DIR`。PerPay 后台也要分别配置通知来源。

本地数据库绑定 PerPay 来源和网站 ID，不能通过修改环境变量把旧订单带到另一个网站。旧示例数据库只可在原实例的 `default` 网站下原地使用；其他网站使用新的数据目录。轮换同一网站密钥不会改变此绑定。示例不负责部署或自动同步密钥。
