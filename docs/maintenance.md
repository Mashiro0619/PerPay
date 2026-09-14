<!-- SPDX-License-Identifier: MIT -->

# 维护与恢复

以下命令在 `docker-compose.yml` 所在目录执行。[返回部署说明](../README.md)。

## 查看状态

```sh
docker compose ps
docker compose logs --tail=100 app backup
docker compose --profile maintenance run --rm maintenance health
```

- `/healthz`：进程和数据库是否正常。
- `/readyz`：是否可以创建收款订单；支付宝配置、首次查账和自动确认未就绪时不会通过。
- 收款异常可在管理后台的“运行状态”查看原因。

## 忘记管理员密码

在服务器上执行。使用与实例一致的镜像版本，先停止应用和备份：

```sh
docker compose stop app backup
docker compose --profile maintenance run --rm --no-deps --entrypoint node maintenance dist/identity/recover.js --confirm-reset-admin-password
```

按提示输入新密码两次（不回显）。密码至少 6 个字符；成功后再执行 `docker compose up -d`。

只修改管理员密码、注销旧会话并记录审计，订单、配置和各类密钥不变。不要删除数据卷。若提示数据库仍被占用，确认停服；异常退出后等待 30 秒再试。不会自动迁移数据库或重新生成主密钥。

源码部署：停掉服务后，将 `PERPAY_DATA_DIR` 指向原数据目录，运行 `node dist/identity/recover.js --confirm-reset-admin-password`。自动化可加 `--password-stdin`，从标准输入传一行 UTF-8 密码；不要把密码写在命令参数、环境变量或 shell 历史中。

## 查看备份

备份保存在 `perpay-backups` 卷，周期和保留数量在后台“实例设置 → 自动备份”调整。

```sh
docker compose --profile maintenance run --rm maintenance list-backups
```

输出中的 `name` 和 `sha256` 用于恢复。数据库备份不包含主密钥，需另外保管 `perpay-secrets` 卷。

## 固定版本与回滚

将 Compose 中 `app`、`backup`、`maintenance` 的镜像统一改成同一个[已发布版本](https://github.com/Mashiro0619/PerPay/releases)，再执行：

```sh
docker compose pull
docker compose up -d
```

回滚前先备份并查看版本说明。旧版本不一定兼容新版数据库；需要恢复时，使用目标版本兼容的备份。

当前代码使用数据库 schema 23，启动时会自动升级旧结构。迁移 21（匿名密码验证预算）和 22（金额复用冷却）继续保留；新增迁移 23 保存独立的提醒忽略状态、批次成员、操作结果和管理员退款标记历史。应用、备份与维护工具必须使用相互兼容的构建；已升级的数据库不能直接交给只支持 schema 22 或更早版本的程序打开。

迁移 23 不修改历史订单金额、退款状态、记账分录、异常证据、已生成通知或既有审计哈希，也不把旧退款登记自动转换为管理员标记。旧通知继续投递；提醒忽略状态与标记随数据库备份和恢复持久保存。普通支出及历史支出提示只从待处理视图排除，不删除原记录。旧退款登记写接口返回 `410 / refund_recording_retired`，外部退款后请使用订单详情中的管理员标记。

**没有待处理提醒不代表运行正常：** 批量忽略不会消除账本冲突或通知失败，真实运行计数与重试保持原规则。升级验证和恢复演练请使用隔离数据库，不要为测试而重写运行数据。

**不要为了回滚程序而直接覆盖已经产生新流水的数据库。** 旧备份不包含备份之后的订单、入账和操作记录。应先保留当前完整数据及主密钥；若升级后出现问题，先限制新下单，再使用兼容当前结构的修正版处理。

## 恢复数据库

恢复会覆盖当前数据库。先保留当前数据副本，并确认原 `perpay-secrets` 卷仍在。

1. 停止应用和自动备份，列出可用备份：

   ```sh
   docker compose stop app backup
   docker compose --profile maintenance run --rm maintenance list-backups
   ```

2. 将 `BACKUP_NAME`、`SHA256` 替换为选中备份的 `name`、`sha256`：

   ```sh
   docker compose --profile maintenance run --rm maintenance restore BACKUP_NAME SHA256 --confirm-replace-current-database
   ```

3. 确认恢复成功后再启动；失败时先排查，不要继续启动：

   ```sh
   docker compose up -d
   ```

## 清理遗留维护锁

仅在备份或恢复异常中断、提示发布锁未释放时使用。先停止服务，并确认没有其他维护容器或进程运行：

```sh
docker compose stop app backup
docker compose --profile maintenance run --rm maintenance inspect-publication-lock
```

只有锁超过 7 小时且检查结果 `cleanup_eligible` 为 `true`，才用返回的 `record.token` 替换 `LOCK_TOKEN` 清理：

```sh
docker compose --profile maintenance run --rm maintenance clear-stale-publication-lock LOCK_TOKEN --confirm-no-maintenance-process
```

清理后重新执行原先失败的维护操作，成功后再启动服务。
