<!-- SPDX-License-Identifier: MIT -->
# 易支付协议与下游互操作验证

2026-11-07 已执行 PHP V1.3、PHP V2.0、go-epay v0.0.5 及固定提交 New API 的隔离联调。

## 固定来源

| 来源 | 版本与校验值 |
| --- | --- |
| [PHP V1 SDK 下载](https://www.ezfp.cn/assets/files/SDK.zip?_v=1.3) | V1.3，ZIP SHA-256 `aed03c52396dafbf3be3c636d4fcef51bb3f1bc829b20024eedf6dd032614f2d` |
| PHP V1 `EpayCore.class.php` | SHA-256 `4f675d7bde66565aa2d372c5cee41c3dd7dcd12a636fa746b36aa06497bdcb77` |
| [PHP V2 SDK 下载](https://pay.v8jisu.cn/static/files/SDK_2.0.zip) | V2.0，ZIP SHA-256 `33de95841095f99fe8ccd1c16148b71671ed1319b3912205c53a794449a442b0` |
| PHP V2 `EpayCore.class.php` | SHA-256 `161fffe3c68998f539bf4253d4cd274e69aaf1f4b1df30bfe8578eac4d1c94b5`，与此前 ezfp 核心相同 |
| [go-epay](https://github.com/Calcium-Ion/go-epay/tree/v0.0.5) | v0.0.5，模块和依赖由 `go.mod/go.sum` 固定，`go mod verify` 通过 |
| PHP 容器 | `php:8.3-cli@sha256:628102249d93494233b54490b785f12db9cd60f4dc89416dfca15973f2125f10`，OpenSSL、cURL 已检查 |
| New API 源码 | 本机仓库 `6c1575c32ba93ad92f7837993ce8fa282bae17ee`，通过 `git archive` 导出后独立构建，二进制 SHA-256 写入构建清单 |

对照的协议文档包括 [ezfp V1](https://www.ezfp.cn/doc_old.html)、[ezfp V2](https://www.ezfp.cn/doc/pay_create.html)、[全日付签名规则](https://alldaypay.cn/docs/?p=rsa)。ezfp 与 v8jisu 的 V2 PHP 核心使用相同实现，按一组 SDK 来源处理。

## 可复跑命令

从仓库根目录运行。下载包和合成密钥文件保存在已忽略的 `.scratch/epay-clients`。

```powershell
./scripts/validation/epay/prepare-sdk.ps1
Push-Location scripts/validation/epay
go mod download
go mod verify
Pop-Location
node --experimental-strip-types scripts/validation/epay/interop.mjs
./scripts/validation/epay/build-new-api.ps1 -Repository D:/Project/Web/new-api
node --experimental-strip-types scripts/validation/epay/new-api.mjs
```

PHP 验证使用原始 SDK 类的公开方法生成链接、调用下单和查单接口、验证异步通知与同步返回。HTTP 请求由隔离协议服务接收，服务端使用生产 `src/epay/protocol.ts` 验签并生成响应。V2 另验证顶层 `data` 数组的列表响应。Go 验证实际调用 `Purchase` 和 `Verify`，同时确认歧义分隔符被拒绝。

New API 构建使用固定后端源码，仅在隔离副本补一个 `go:embed` 所需的静态首页。验证进程使用新 SQLite、随机管理员密码和会话密钥。原仓库、现有容器及用户实例保持独立。

## 已执行结果

- PHP V1.3 与 V2.0 的请求生成、HTTP 下单、HTTP 查单、通知验签和同步返回验签通过。中文、空格、`+`、`=`、字面量 `%26`、零值及带静态查询参数的回调均通过。
- PHP V1.3 保留空格值参与 MD5，V2.0 排除 PHP `trim` 后为空的值。两者保留字符串 `0`。原始数组请求拒绝，V2 列表响应的 `data` 数组按 SDK 规则排除顶层签名。
- go-epay v0.0.5 的页面下单参数与 PerPay 验签一致，PerPay 生成的通知被 Go 验签通过，参数值中的 `&` 被 Go SDK 与 PerPay 一致拒绝。
- New API 充值与订阅各完成两组真实后端流程，分别让同步返回、异步通知先到。每单收到三次异步通知，其中两次并发重复，SQLite 断言充值额度与订阅权益均只增加一次。
- New API 生成的下单请求经过 PerPay 真实 `/submit.php` 路由、订单服务、合成账单自动对账、公开查单、令牌返回入口与持久化通知队列。通知通过 `NodeWebhookTransport` 测试依赖定向到独立 New API 进程，HTTP 方法、查询参数和回执由真实代码处理。
- 支付平台收入采用合成账单。网络测试依赖把批准的 HTTPS 主机及 DNS 地址映射到本机 HTTP 进程，真实支付宝付款与公网 TLS 由后续实际收款验收核对。

每次 New API 运行在 `.scratch/epay-clients/newapi-run-*` 保存 `results.json` 和 `server.log`。脚本结束会关闭实例，结果目录保留用于复核。

最终复跑于北京时间 2026-11-07 02:52 完成，证据目录为 `.scratch/epay-clients/newapi-run-ux9Sw6`。该次二进制 SHA-256 为 `bee8b3d10469c3fe8b31f414bdbac9b4b70136ed7fc5a3152b7222d3b859284c`，四组流程均通过。SDK 交叉验证、协议测试 6 项、Demo 测试 38 项、打包测试 4 项及升级夹具测试 2 项同时完成。
