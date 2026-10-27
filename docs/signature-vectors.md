<!-- SPDX-License-Identifier: MIT -->

# 签名测试向量

以下全部是公开的合成测试数据，不能用于部署。向量分别取自 [API 请求签名测试](../test/api-signature.test.ts) 和 [通知协议测试](../test/notifications-model.test.ts)，用于不同语言实现的逐字节核对。

API 向量里的路径和正文是算法测试材料，不是可直接下单的业务请求；通知向量的正文也不是完整业务事件。真实接口与完整正文见[快速接入指南](integration-quickstart.md)及 [OpenAPI](../openapi.yaml)。固定时间戳不能用于真实请求，API nonce 每次都要重新生成。

## 如何核对

1. 将 `secret_base64url` 解码为 32 字节密钥。
2. 将 `body_hex` 解码为原始正文；它必须与 `body_utf8` 的 UTF-8 编码一致。不要先解析 JSON 再序列化。
3. 正文的 SHA-256 小写十六进制应等于 `body_sha256`。
4. 对 `canonical_utf8` 的 UTF-8 字节计算 HMAC-SHA256。JSON 中的 `\n` 表示一个 LF 字节，末尾没有额外换行。
5. API 签名是裸小写十六进制；通知签名还需加上 `v1=` 前缀。

API 的 `timestamp` 使用 Unix **秒**；通知使用 Unix **毫秒**。API 查询参数按规范化后的编码名称排序，所以输入 `target` 与 `canonical_target` 可以不同。正文里的 `\\u0000` 在下方 JSON 解析后仍是反斜杠加 `u0000` 六个字符，不是直接插入一个 NUL 字节。

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

API 请求发送的对应头为 `X-PerPay-Signature-Version: v1`、`X-PerPay-Client-Id`、`X-PerPay-Timestamp`、`X-PerPay-Nonce`、`X-PerPay-Signature`。通知的版本头为 `X-PerPay-Webhook-Version: 1`，其余坐标与签名使用 `X-PerPay-Webhook-*` 请求头；两套格式不能混用。

仓库的 [文档向量测试](../test/signature-documentation.test.ts) 会读取上面的 JSON，校验正文、规范化文本、摘要和签名与实现一致。修改签名协议时，须同时评估兼容性及原有固定向量，不要只更新预期值来绕过回归。
