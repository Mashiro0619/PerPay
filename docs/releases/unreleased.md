<!-- SPDX-License-Identifier: MIT -->

# PerPay 未发布改动

当前源码包版本仍为 [1.0.0-alpha.2](v1.0.0-alpha.2.md)。其后新增支付宝多账号、网站指定／随机／加权收款、账号独立查账及三步首次设置，数据库升级至 schema 38，保留删除账号的历史关联以保证重启和恢复完整性；下一次发布须更新版本号，不能沿用旧版本的 schema 36 发布契约。功能与验证范围见[多账号验收记录](../development/multi-account-acceptance.md)。

上述多账号改动尚未发布，部署前请确认目标版本的 GitHub Release 和镜像已经可用。升级与回退要求见[维护说明](../maintenance.md#固定版本与回滚)。

新增发布说明按[发布模板](TEMPLATE.md)编写。
