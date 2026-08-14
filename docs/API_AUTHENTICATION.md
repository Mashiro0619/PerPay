<!-- SPDX-License-Identifier: Apache-2.0 -->

# API 认证与签名

原生 `/api/v1/*` 接口使用单客户端 HMAC-SHA256。传输层仍必须使用 HTTPS；HMAC 不替代 TLS。

## 配置材料

- `PERPAY_API_CLIENT_ID` 是客户端标识。
- `PERPAY_API_SECRET` 是恰好 32 个随机字节的无填充 base64url 文本。签名时先将其解码为原始 32 字节，不能直接把 43 个文本字符当作 HMAC key。
- 每次请求生成新的 32 字节随机 nonce，并编码为 43 个字符的无填充 base64url。网络重试也必须使用新 nonce。

## 请求头

```text
X-PerPay-Signature-Version: v1
X-PerPay-Client-Id: <client id>
X-PerPay-Timestamp: <Unix whole seconds>
X-PerPay-Nonce: <32 random bytes as unpadded base64url>
X-PerPay-Signature: <64 lowercase hexadecimal characters>
```

时间戳必须是 10 到 12 位、无前导零的十进制整数。服务端最多接受正负 300 秒偏差；不能通过客户端参数扩大该窗口。

## v1 签名载荷

先计算原始 HTTP body 字节的 SHA-256 小写十六进制摘要。空 body 的摘要也必须按零字节输入计算。

以下 8 行使用单个 LF (`0x0a`) 连接，末尾没有换行，再以 UTF-8 编码：

```text
PERPAY-HMAC-SHA256
v1
<UPPERCASE METHOD>
<canonical request-target>
<timestamp header value>
<nonce header value>
<client id>
<lowercase body SHA-256>
```

使用解码后的 32 字节 API secret 对这些字节计算 HMAC-SHA256，输出 64 个小写十六进制字符。

创建订单的 `idempotency_key` 位于 JSON body 内，因此由 body hash 覆盖。不要把它移到未参与签名的自定义 header。

## Request-target 规范化

签名输入使用线上实际发送的 origin-form request-target，即以单个 `/` 开头的路径和可选 query；不能使用完整 URL、fragment 或框架解码后的路由字符串。

v1 规则如下：

1. request-target 必须是 ASCII，UTF-8 总长度不超过 8192 字节。
2. 路径拒绝空段、`.`、`..`、反斜杠、重复 `/`、编码后的 `/` 或 `\`。
3. 百分号转义必须完整，并表示合法、NFC 形式的 UTF-8。输出使用大写十六进制转义。
4. 路径中百分号编码的 ASCII 保留字符会被拒绝，避免它与字面保留字符合并成同一签名。
5. query 只接受 `name=value`，不接受裸字段、空 query 标记、`+`、分号分隔或重复参数名。
6. query 名和值解码后要求 NFC，再按 UTF-8 百分号编码；参数按编码后的名称、再按值排序。
7. 最多接受 128 个 query 参数。

客户端应直接复用仓库中的 `canonicalizeApiRequestTarget` 和 `signApiRequest`，或逐项移植其固定测试向量；不要依赖通用表单编码器猜测这些规则。

## 固定向量

输入：

```text
secret hex = 6be74796a45948e654921cb70b7a8db38ab78cf7c1d5cb206a8e6a3a50427c8d
method     = post
target     = /v1/orders/%E6%94%B6%E6%AC%BE?order_id=A-1&note=%E6%B5%8B%E8%AF%95
timestamp  = 1786708800
nonce      = paWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaU
client id  = client_test_01
body       = {"amount":"10.00","note":"收款\u0000"}
```

规范结果：

```text
canonical target = /v1/orders/%E6%94%B6%E6%AC%BE?note=%E6%B5%8B%E8%AF%95&order_id=A-1
body SHA-256     = 67b98328e54aece93728c2bfc3d9a295018f66b820dca03f434dbbf4efdba851
signature        = 8a71e37ddfaa23364e2610478b15ead1b4de71a43293c31a270b6e001594cbc2
```

## 重放与错误

- nonce 在客户端范围内只消费一次。签名正确但 nonce 已使用时返回 `409 api_nonce_replayed`。
- 缺少头、签名错误、未知客户端和错误 secret 统一返回 `401 api_authentication_failed`，不暴露具体失败位置。
- nonce 在业务字段校验前消费。收到 `400`、`409`、`413`、`415`、`422` 或 `503` 后重试时，必须重新生成 nonce 和签名。
- 同一个下单 JSON 及幂等键使用新 nonce 重试，会返回原订单；同一幂等键对应不同请求语义会返回 `409 idempotency_conflict`。
