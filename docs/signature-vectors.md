<!-- SPDX-License-Identifier: MIT -->

# 签名测试向量

把本页的固定输入交给你的签名代码，检查输出是否与给定结果完全一致。这组输入和预期结果称为“签名测试向量”，可以用来核对正文编码、路径和查询参数的处理、SHA-256 摘要及 HMAC 计算。

示例密钥、时间戳、路径和正文是公开的校对数据。实际发送请求时，使用自己的网站密钥、当前时间和新 nonce，业务字段按 [USAGE](../USAGE.md) 填写。

| 项目 | API 请求 | 原生通知 |
| --- | --- | --- |
| 时间戳 | Unix 秒 | Unix 毫秒 |
| 版本头 | `X-PerPay-Signature-Version: v1` | `X-PerPay-Webhook-Version: 1` |
| 签名值 | 小写十六进制 | `v1=` 加小写十六进制 |
| 密钥 | 网站 API 密钥 | 网站通知密钥 |

## 如何核对

1. 将 `secret_base64url` 解码为 32 字节密钥。
2. 将 `body_hex` 解码为原始正文，与 `body_utf8` 的 UTF-8 字节比较。
3. 对正文计算 SHA-256，小写十六进制结果应等于 `body_sha256`。
4. `canonical_utf8` 是实际参与签名的文本。对它的 UTF-8 字节计算 HMAC-SHA256，再与 `signature` 比较；通知签名先加上 `v1=` 前缀。

读取下面的 JSON 后，`canonical_utf8` 中的 `\n` 会成为一个 LF 换行字节，整段文本末尾没有换行。API 查询参数按规范化后的编码名称排序，所以原始 `target` 与排序后的 `canonical_target` 顺序不同。`body_utf8` 中写成 `\\u0000` 的部分，在读取这一层 JSON 后仍是反斜杠加 `u0000`，不是 NUL 字节。

结果不一致时，依次比较正文原始字节、正文摘要、参与签名的完整文本和最终 HMAC，找到最早出现差异的一步。收到通知后，用原始正文验签；正文中的空白和转义也参与签名，重新生成 JSON 后即使字段相同，也可能验签失败。

## 固定输入与预期输出

```json
{
  "api": {
    "secret_base64url": "a-dHlqRZSOZUkhy3C3qNs4q3jPfB1csgao5qOlBCfI0",
    "method": "POST",
    "target": "/v1/orders/%E6%94%B6%E6%AC%BE?order_id=A-1&note=%E6%B5%8B%E8%AF%95",
    "client_id": "client_test_01",
    "timestamp": "1786708800",
    "nonce": "paWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaU",
    "body_utf8": "{\"amount\":\"10.00\",\"note\":\"收款\\u0000\"}",
    "signature": "8a71e37ddfaa23364e2610478b15ead1b4de71a43293c31a270b6e001594cbc2",
    "body_hex": "7b22616d6f756e74223a2231302e3030222c226e6f7465223a22e694b6e6acbe5c7530303030227d",
    "body_sha256": "67b98328e54aece93728c2bfc3d9a295018f66b820dca03f434dbbf4efdba851",
    "canonical_target": "/v1/orders/%E6%94%B6%E6%AC%BE?note=%E6%B5%8B%E8%AF%95&order_id=A-1",
    "canonical_utf8": "PERPAY-HMAC-SHA256\nv1\nPOST\n/v1/orders/%E6%94%B6%E6%AC%BE?note=%E6%B5%8B%E8%AF%95&order_id=A-1\n1786708800\npaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaU\nclient_test_01\n67b98328e54aece93728c2bfc3d9a295018f66b820dca03f434dbbf4efdba851"
  },
  "webhook": {
    "secret_base64url": "ERERERERERERERERERERERERERERERERERERERERERE",
    "key_id": "c45fbe13-bb39-4d31-a8b4-708bfe8fd9c3",
    "timestamp": 2000000000123,
    "delivery_id": "c9b3f2e7-5e8e-4ebd-b8e3-bf45c613eacb",
    "event_id": "8c5fa229-bd49-482d-a40e-52f475fefcc0",
    "attempt": 3,
    "body_utf8": "{\"event_id\":\"exact\",\"amount\":100}",
    "signature": "v1=cb7b71c26ba48608b813fb3f473caf66e2adde1a04e7cfc6157deb2c826562e6",
    "body_hex": "7b226576656e745f6964223a226578616374222c22616d6f756e74223a3130307d",
    "body_sha256": "71d1d27b61f4949ff3b5775faa7a4e1a26b6dbcfe1c1a218d275acf867d584ec",
    "canonical_utf8": "perpay:webhook:v1\nc45fbe13-bb39-4d31-a8b4-708bfe8fd9c3\n2000000000123\nc9b3f2e7-5e8e-4ebd-b8e3-bf45c613eacb\n8c5fa229-bd49-482d-a40e-52f475fefcc0\n3\n71d1d27b61f4949ff3b5775faa7a4e1a26b6dbcfe1c1a218d275acf867d584ec"
  }
}
```

API 的身份、时间戳、nonce 和签名分别放在 `X-PerPay-Client-Id`、`X-PerPay-Timestamp`、`X-PerPay-Nonce`、`X-PerPay-Signature` 中。通知使用 `X-PerPay-Webhook-*` 请求头传递对应字段。[完整请求签名规则](../USAGE.md#2-请求签名) · [完整通知协议](../USAGE.md#5-回调通知)

向量来源：[API 签名用例](../test/api-signature.test.ts)、[通知签名用例](../test/notifications-model.test.ts)。仓库中的[文档向量检查](../test/signature-documentation.test.ts)读取本页同一份 JSON。
