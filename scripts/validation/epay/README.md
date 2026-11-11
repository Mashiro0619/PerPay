<!-- SPDX-License-Identifier: MIT -->

<a id="易支付协议与下游互操作验证"></a>

# 易支付客户端与业务系统兼容检查

本目录使用固定版本的客户端，检查它们能否与 PerPay 正常下单、查单和处理通知。PHP/Go 脚本检查参数及签名是否相容，New API 脚本实际运行一个独立业务后端，检查充值和订阅流程。PerPay 的协议处理方式见[接入设计](../../../docs/development/integration-epay-plan.md)，业务配置见[易支付指南](../../../docs/epay-integration.md)。

<a id="固定来源"></a>

## 客户端版本与校验值

| 来源 | 版本与校验值 |
| --- | --- |
| [PHP V1 SDK](https://www.ezfp.cn/assets/files/SDK.zip?_v=1.3) | V1.3，ZIP SHA-256 `aed03c52396dafbf3be3c636d4fcef51bb3f1bc829b20024eedf6dd032614f2d` |
| PHP V1 `EpayCore.class.php` | SHA-256 `4f675d7bde66565aa2d372c5cee41c3dd7dcd12a636fa746b36aa06497bdcb77` |
| [PHP V2 SDK](https://pay.v8jisu.cn/static/files/SDK_2.0.zip) | V2.0，ZIP SHA-256 `33de95841095f99fe8ccd1c16148b71671ed1319b3912205c53a794449a442b0` |
| PHP V2 `EpayCore.class.php` | SHA-256 `161fffe3c68998f539bf4253d4cd274e69aaf1f4b1df30bfe8578eac4d1c94b5` |
| [go-epay](https://github.com/Calcium-Ion/go-epay/tree/v0.0.5) | v0.0.5，依赖由 [go.mod](go.mod)和 [go.sum](go.sum)固定 |
| PHP 容器 | `php:8.3-cli@sha256:628102249d93494233b54490b785f12db9cd60f4dc89416dfca15973f2125f10` |
| New API | 提交 `6c1575c32ba93ad92f7837993ce8fa282bae17ee`，构建清单另记录本轮二进制 SHA-256 |

[prepare-sdk.ps1](prepare-sdk.ps1)检查下载包的校验值，[interop.mjs](interop.mjs)运行前再次核对 SDK 核心文件，确保使用的是上表所列版本。对照文档包括 [ezfp V1](https://www.ezfp.cn/doc_old.html)、[ezfp V2](https://www.ezfp.cn/doc/pay_create.html)和[全日付签名规则](https://alldaypay.cn/docs/?p=rsa)。这里固定的 ezfp/v8jisu V2 核心使用同一套实现。

<a id="可复跑命令"></a>

## 运行步骤

需要检查客户端兼容性时，运行下面的命令。日常开发和现有 CI 各自检查什么，见[开发验证](../../../docs/development/ui-verification.md#现有-ci-与专项入口)。

准备项目支持的 Node.js、满足各自 `go.mod` 的 Go、PowerShell 7 和能运行 Linux PHP 容器的 Docker。脚本把下载包、密钥和结果固定写入源码目录下的 `.scratch/epay-clients`；需要集中保存在指定位置时，将验证源码副本放到所选工作目录，并在该副本根目录执行。系统临时目录可按[开发准备](../../../docs/development/README.md#开始开发)自定义。

```sh
npm ci --ignore-scripts
npm run build
pwsh -File scripts/validation/epay/prepare-sdk.ps1
go -C scripts/validation/epay mod download
go -C scripts/validation/epay mod verify
node --experimental-strip-types scripts/validation/epay/interop.mjs
```

用于检查的本机服务会生成临时密钥并使用临时端口，PHP 容器通过 `host.docker.internal` 访问它。容器以只读方式挂载运行副本，直接调用原始 SDK 的公开方法生成请求、验证回调。

New API 专项还需要含固定提交的本机仓库。将 `../new-api` 换成该仓库的实际位置：

```sh
pwsh -File scripts/validation/epay/build-new-api.ps1 -Repository ../new-api
node --experimental-strip-types scripts/validation/epay/new-api.mjs
```

构建脚本用 `git archive` 把指定提交导出到独立目录，补入 `go:embed` 需要的静态首页，再生成二进制文件及同目录下的 `.json` 清单。清单记录源提交和二进制哈希。检查脚本确认两者相符后，用全新的 SQLite 数据库、随机管理员密码和会话密钥启动进程。`NEW_API_BINARY` 可以指定另一份构建产物，它也必须与旁边的清单相符。

<a id="已执行结果"></a>

## 验证范围与结果文件

| 入口 | 观察内容 |
| --- | --- |
| [interop.mjs](interop.mjs)、[php-client.php](php-client.php) | PHP V1/V2 请求生成、HTTP 下单与查单、通知和同步返回验签，以及 PHP 实际解码后的参数 |
| [Go 调用端](main.go) | go-epay 的 Purchase、Verify，以及参数中含有容易被错误拆分的分隔符时怎样处理 |
| [new-api.mjs](new-api.mjs) | 充值与订阅；浏览器返回或通知先到、重复收到通知、同时收到多条通知时，余额或订阅是否只增加一次 |
| [perpay-fixture.mjs](perpay-fixture.mjs) | 应用实际使用的 PerPay 路由、订单、模拟账单对账、公开查单、凭收银台令牌返回商家，以及通知保存和发送 |

编码样例包含中文、空格、`+`、值中的 `=`、字面量 `%26`、空值和字符串 `0`。V1 把纯空格值计入 MD5 签名，V2 按 PHP `trim` 规则判断空值；V2 列表数组不参加顶层签名。回调参数直接交给 PHP `parse_str` 解码，检查带点号等参数名会怎样变化。

New API 检查程序读取新网站默认生成的易支付密钥。请求经过应用实际使用的 `/submit.php` 路由、订单服务和通知队列；支付宝收入由模拟账单提供，测试代码把允许的 HTTPS 主机名转到本机进程。真正连接支付宝付款、在公网接收通知的检查，按业务接入指南另行进行。

| 输出 | 内容 |
| --- | --- |
| `.scratch/epay-clients/php-v*.zip`、`v1/`、`v2/` | 已核对的外部 SDK |
| `epay_v1.json`、`epay_v2.json` | 本轮合成密钥、请求和回调样例 |
| `new-api-validation.exe.json` | 固定源提交与本轮二进制哈希 |
| `newapi-run-*/results.json` | 本轮充值、订阅及重复处理结果 |
| `newapi-run-*/server.log` | 独立 New API 进程日志 |

PHP/Go 的检查结果显示在终端。脚本结束时关闭 New API 进程，保留结果目录。每次运行都记下 PerPay 提交、所用客户端版本和来源、执行时间及输出目录，便于找到对应记录重新核对。
