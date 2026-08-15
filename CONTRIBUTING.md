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

根 Compose 面向使用者，只引用预构建发布镜像，不从当前源码隐式构建。需要验收本地源码容器时，先把候选镜像构建到 Compose 当前引用的本地标签，再明确禁止拉取；该标签只用于本机，不得推送：

```text
docker build --build-arg APP_VERSION=0.1.0-dev -t ghcr.io/mashiro0619/perpay:0.1.0 .
docker compose up -d --pull never --wait --wait-timeout 300
```

容器验收后应确认 `/readyz`、非 root 用户、只读根文件系统、命名卷重建持久化、迁移前备份和恢复命令。正式 release 由发布流水线构建，不能把贡献者机器上的同名候选镜像当作发布证据。

变更资金状态机、匹配、账本、通知幂等、密钥处理、迁移或备份时，必须同步增加失败路径、并发和恢复测试。

不要提交真实密钥、流水、账户标识、回调 secret、个人信息或本地数据库。兼容性工作只能依据公开协议、贡献者自有的脱敏黑盒样本或独立生成的 fixtures。

提交信息使用中文 Conventional Commits，例如：

```text
feat(订单): 增加幂等创建接口
fix(账本): 拒绝重复资金分配
test(通知): 覆盖崩溃后重复投递
```

Pull Request 应说明目的、风险、回滚方式、已运行测试，以及对 schema、配置、API、部署和安全边界的影响。
