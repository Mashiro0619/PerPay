<!-- SPDX-License-Identifier: Apache-2.0 -->

# 贡献指南

项目处理支付与账务数据，正确性、可追溯性和安全性优先于交付速度。

## 开发环境

- Node.js 24
- npm
- Docker Compose（容器验收）
- Git

首次检出后运行：

```bash
npm ci
npm run check
```

变更资金状态机、匹配、账本、通知幂等、密钥处理、迁移或备份时，必须同步增加失败路径、并发和恢复测试。

不要提交真实密钥、流水、账户标识、回调 secret、个人信息或本地数据库。兼容性工作只能依据公开协议、贡献者自有的脱敏黑盒样本或独立生成的 fixtures。

提交信息使用中文 Conventional Commits，例如：

```text
feat(订单): 增加幂等创建接口
fix(账本): 拒绝重复资金分配
test(通知): 覆盖崩溃后重复投递
```

Pull Request 应说明目的、风险、回滚方式、已运行测试，以及对 schema、配置、API、部署和安全边界的影响。
