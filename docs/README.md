<!-- SPDX-License-Identifier: MIT -->

# PerPay 文档目录

按部署、接入、运维与开发四个阶段分类检索文档：

## 1. 部署与基础配置

| 顺序 | 文档 | 内容范围 |
| --- | --- | --- |
| 1 | [快速部署](../README.md#部署) | Docker Compose 部署、环境变量与管理员初始化 |
| 2 | [反向代理部署](reverse-proxy.md) | Nginx HTTPS 转发、可信代理 IP 配置与首次访问限制 |
| 3 | [支付宝配置指南](alipay-setup.md) | 开放平台应用准备、密钥交换、收款码上传与试收款 |
| 4 | [多网站与多账号管理](multi-site.md) | 配置作用域、账号分流规则、站点生命周期与管理接口 |

## 2. 业务系统接入

- 已有易支付插件的系统，直接参阅 [易支付 V1/V2 接入指南](epay-integration.md)。
- 自研业务后端，可先阅读 [原生 API 快速接入](integration-quickstart.md) 并结合 [Node.js 示例](../examples/node-client/README.md) 联调。

| 文档 | 内容范围 |
| --- | --- |
| [易支付 V1/V2 接入指南](epay-integration.md) | 插件参数配置、接口路径、签名编码规则与回调处理 |
| [原生 API 快速接入](integration-quickstart.md) | 请求签名、下单、收银台跳转、回调验签与幂等履约 |
| [Node.js 调用端示例](../examples/node-client/README.md) | 零依赖可运行示例，支持原生、易支付 V1 与 V2 模式 |
| [使用与接口参考](../USAGE.md) | 工作原理、查账与冷却机制、原生 API 完整字段与后台操作 |
| [业务错误码与重试](integration-errors.md) | HTTP 错误码分类、重试规范与故障恢复 |
| [签名计算测试向量](signature-vectors.md) | 多语言客户端实现签名与验签时的校验样例 |
| [OpenAPI 规范](../openapi.yaml) | 完整的管理 API 与原生业务 API Schema 定义 |

## 3. 运维与恢复

| 文档 | 内容范围 |
| --- | --- |
| [维护、升级与恢复](maintenance.md) | 版本升级与回滚、在线更新器、备份与恢复、密码/白名单重置、查账排查与磁盘维护 |
| [数据与隐私说明](privacy.md) | 数据存储范围、留存与清理策略、访问边界及加密导出说明 |
| [版本说明](releases/README.md) · [更新日志](../CHANGELOG.md) | 各版本变更记录、兼容性与升级注意事项 |
| [免责声明](../DISCLAIMER.md) · [安全报告](../SECURITY.md) | 风险责任边界与安全漏洞私密上报方式 |

## 4. 开发与工程规范

| 文档 | 内容范围 |
| --- | --- |
| [开发导航](development/README.md) | 本地启动、模块源码索引、数据流、改动验证矩阵与契约约束 |
| [前端开发](../web/README.md) | 目录结构、Vite 联调、浏览器基线、组件维护与后台交互不变量 |
| [开发验证](development/ui-verification.md) | 本地预览参数、手工核对清单、README 截图规范、Playwright 与 Linux 容器回归 |
| [支付宝 SDK 与易支付接入设计](development/integration-epay-plan.md) | SDK 适配层、易支付协议实现、数据库事务与导出设计 |
| [文案与字段术语表](glossary.md) | 界面、文档与 API 的字段来源、命名规范与状态定义 |
| [支付宝 SDK 验证](../scripts/validation/alipay-sdk/README.md) · [易支付兼容验证](../scripts/validation/epay/README.md) | 协议适配与第三方 SDK 互操作验证脚本 |

---

[返回项目首页](../README.md)
