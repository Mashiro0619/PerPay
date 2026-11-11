<!-- SPDX-License-Identifier: MIT -->

# PerPay 文档

第一次使用，从[部署](../README.md#部署)开始，默认安装 `latest` 稳定版。已经运行 PerPay，可以按要做的事情选择下面的文档。

## 部署与首次收款

| 文档 | 解决什么问题 |
| --- | --- |
| [快速部署](../README.md#部署) | 下载配置、启动服务、创建管理员 |
| [支付宝配置](alipay-setup.md) | 准备支付宝应用、填写密钥、上传收款码，完成第一笔收款 |
| [反向代理](reverse-proxy.md) | 用自己的 HTTPS 域名访问，保护首次管理员设置页面 |
| [多网站管理](multi-site.md) | 创建网站、分配收款账号、管理密钥与通知 |

## 业务系统接入

已有易支付插件，直接看易支付指南；自己写接入代码，从原生 API 或 Node.js 示例开始。

| 文档 | 用途 |
| --- | --- |
| [原生 API 快速接入](integration-quickstart.md) | 完成下单、付款与通知处理 |
| [易支付 V1/V2](epay-integration.md) | 配置现有插件，让业务网站能下单、查单并接收通知 |
| [Node.js Demo](../examples/node-client/README.md) | 运行完整示例，核对订单和通知结果 |
| [接口参考](../USAGE.md) · [OpenAPI](../openapi.yaml) | 查询请求参数、返回结构、订单状态与配置 |
| [错误处理](integration-errors.md) | 根据错误码选择修正、查单或重试 |
| [签名计算示例](signature-vectors.md) | 对照固定输入和结果，检查自己的签名代码 |

## 运行维护

| 文档 | 用途 |
| --- | --- |
| [维护与恢复](maintenance.md) | 查看故障、备份、搬迁服务器、更新程序或恢复旧版本 |
| [数据与隐私](privacy.md) | 了解保存的数据、保留时间及导出范围 |
| [安全报告](../SECURITY.md) | 私密报告漏洞与敏感问题 |
| [免责声明](../DISCLAIMER.md) | 了解账号、交易、资金和数据风险，以及相关责任 |
| [版本说明](releases/README.md) · [变更日志](../CHANGELOG.md) | 查看更新内容和升级前需要做的事 |

## 开发与设计

| 文档 | 用途 |
| --- | --- |
| [开发导航](development/README.md) | 准备开发环境，找到需要修改的代码 |
| [前端开发](../web/README.md) | 修改页面和组件，构建前端，核对界面操作 |
| [本地预览与验证](development/ui-verification.md) | 打开带示例数据的预览，检查操作并拍摄截图 |
| [易支付接入设计](development/integration-epay-plan.md) | 了解易支付接口如何使用 PerPay 的订单和通知功能 |
| [术语与字段](glossary.md) | 区分收款、查账、通知和界面数值的含义 |
| [支付宝 SDK 验证](../scripts/validation/alipay-sdk/README.md) · [易支付验证](../scripts/validation/epay/README.md) | 维护协议实现时使用的专项工具 |

[返回项目首页](../README.md)
