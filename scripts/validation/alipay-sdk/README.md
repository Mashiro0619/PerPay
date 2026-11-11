<!-- SPDX-License-Identifier: MIT -->

# 支付宝官方 SDK 适配验证

本目录保存检查 SDK 请求和响应规则的用例、模拟数据，以及迁移时保留的独立参考适配器。应用的查账、连接检查和密钥验证已经使用 [SdkAlipayLedgerProvider](../../../src/infrastructure/alipay/sdk-provider.ts)；日常开发入口见[开发导航](../../../docs/development/README.md)。

## 运行

这组用例已接入现有的 [Node 测试入口](../../../test/alipay-sdk.test.mjs)，CI 运行 `npm run check` 时会执行。修改 SDK 适配或传输逻辑时，也可单独运行。

先在仓库根目录安装项目依赖，再执行独立验证：

```sh
npm ci
npm --prefix scripts/validation/alipay-sdk ci --ignore-scripts
npm --prefix scripts/validation/alipay-sdk test
```

需要比较迁移时的原型时，Linux/macOS 在仓库根目录运行：

```sh
PERPAY_SDK_PROTOTYPE=true npm --prefix scripts/validation/alipay-sdk test
```

Windows PowerShell 使用：

```powershell
$env:PERPAY_SDK_PROTOTYPE = 'true'
npm --prefix scripts/validation/alipay-sdk test
Remove-Item Env:PERPAY_SDK_PROTOTYPE
```

默认检查应用实际使用的 TypeScript 适配器；设置上述环境变量后，只有这组用例会改用参考适配器。用例会生成 RSA 密钥，启动本机 HTTP 服务，并在系统临时目录创建 SQLite 数据库；自定义临时目录见[开发准备](../../../docs/development/README.md#开始开发)。

本目录固定使用 `alipay-sdk 4.14.0`、`urllib 4.9.1`，间接依赖的版本由 [package-lock.json](package-lock.json)固定。应用实际使用的依赖以仓库根 [package.json](../../../package.json)及其锁文件为准。

## 实现

请求经过以下路径：

1. 官方 SDK 的普通 `curl` 生成并签名支付宝请求。
2. 每次请求创建独立 [SdkTransportDispatcher](../../../src/infrastructure/alipay/sdk-dispatcher.ts)，通过公开的 agent/Dispatcher 接口交给 [NodeV3Transport](../../../src/infrastructure/alipay/node-transport.ts)。
3. 传输层保存原始响应，再由 SDK 验签；PerPay 按字段、金额和分页规则严格解析账单。
4. 查账服务把流水、原始响应等来源记录、验签状态和错误分类保存到原有账本。

传输层负责 DNS、连接、处理调用方取消、限制整次请求时间和控制重定向，同时将正文限制在 2 MiB、响应头限制在 16 KiB。保存收到的原始字节，便于重新核对签名和账单内容；`signatureVerified` 分别表示验签成功、失败或尚未完成。

[provider.mjs](provider.mjs)是独立参考实现，[fixture.mjs](fixture.mjs)提供模拟响应。应用适配器与参考原型接收相同的用例输入，便于比较请求、返回结果和错误处理。

<a id="验证结果"></a>

## 现有检查范围

现有用例检查以下情况。记录运行结果时，一并保存这次的命令输出、源码提交和环境信息。

| 检查类别 | 现有用例检查内容 |
| --- | --- |
| 请求签名及参数 | SDK 签名、查询路径、时间范围、分页、应用标识和请求 ID |
| 响应验签 | 正常、篡改、缺失、错误、重复签名及证书身份 |
| 原始响应保存 | 正文空白、重复响应头、未知字段，以及验签失败后能否查看原始记录 |
| 错误分类 | 401、403、429、500、302、非 JSON 错误和 Retry-After |
| 请求控制 | DNS 截止时间、读取超时、外部取消、正文与响应头超限、连接释放 |
| 并发及取消时机 | 多个请求是否相互独立，取消其中一个请求是否影响其他请求，以及传输完成后取消能否保留已收到的响应 |
| 密钥格式 | PKCS8、PKCS1 和 KeyObject |
| 账单解析与保存 | 2000 条满页、分页异常、空首页、密钥检查，以及模拟账单经采集逻辑保存到数据库 |

遇到无法分类的 SDK 异常，或在传输完成后取消请求时，仍保留已经收到的响应。响应使用非 `identity` 内容编码时会被拒绝，避免解压改变需要验签的原文。每种情况的预期结果见 [provider.test.mjs](provider.test.mjs)。

## 迁移状态

运行时查账、连接检查和密钥验证均已使用应用适配器。旧协议实现保留在 `test/fixtures/alipay-legacy-*.ts`，用于对照请求和响应规则；应用继续执行账务解析、密钥格式检查，以及响应大小和时间限制。

SDK 适配沿用账号配置和原有账本接口。回退版本时，按[维护说明](../../../docs/maintenance.md)选择与数据库结构版本（schema）相匹配的程序和备份。实际小额付款还需核对支付宝流水、订单确认和业务通知结果，按[支付宝配置指南](../../../docs/alipay-setup.md)另行操作。
