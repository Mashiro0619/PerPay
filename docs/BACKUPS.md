# 自动备份与恢复

项目提供一个轻量的本机 SQLite 备份服务。备份是明文、独立卷中的已验证数据库副本，用于误删、升级失败和单文件损坏后的快速恢复；它不是异地灾备，也不提供加密存储。

## 运行结构

默认拓扑只有两个会自动运行的服务：

| 服务 | `/data` | `/backups` | 作用 |
| --- | --- | --- | --- |
| `app` | 可写 | 只读 | 对外提供支付 API 和管理 API |
| `backup` | 只读 | 可写 | 无网络周期创建和清理 SQLite 副本 |

`maintenance` 是同一镜像提供的停机维护 profile。它默认不启动，只有执行恢复命令时临时创建；它同时以可写方式挂载两个卷，并保持非 root、只读根文件系统、无网络和丢弃全部 Linux capabilities。

应用数据与备份数据必须使用两个不同的卷或目录。容器层不保存业务状态，重建 `app` 或 `backup` 不会删除卷；不要对仍需保留数据的实例执行 `docker compose down --volumes`。

## 部署配置

先填写根目录的 `docker-compose.yml`，再检查最终配置：

```sh
docker compose config --quiet
docker compose up -d --wait --wait-timeout 900
```

部署者需要调整的备份策略只有以下两项：

- `PERPAY_BACKUP_INTERVAL_SECONDS`：`3600` 至 `604800` 秒，默认每天一次。`app` 与 `backup` 必须使用同一个值。
- `PERPAY_BACKUP_KEEP_COUNT`：保留 `1` 至 `365` 个已验证副本，默认 `7` 个。

`PERPAY_DATA_DIR=/data` 与 `PERPAY_BACKUP_DIR=/backups` 是 Compose 固定的容器内部路径，不需要填写或修改；两个路径必须保持在不同的卷中。

首次启动后，`backup` 会等待 `app` 健康，然后立即执行一次备份，之后按周期运行。单次备份包含：在线复制 SQLite、关闭并重新打开副本、SHA-256 校验、SQLite `quick_check`、外键与领域完整性检查、schema 13 检查和应用实例 ID 检查。所有检查通过后才会把临时文件发布为正式文件。

## 日常操作

查看备份服务健康状态（退出码为 `0` 才表示健康）：

```sh
docker compose exec -T backup node dist/backup/runner.js health
```

手动执行一轮备份：

```sh
docker compose run --rm --no-deps backup node dist/backup/runner.js run-once
```

输出是 JSON，主要字段如下：

```json
{
  "backup": {
    "name": "perpay.sqlite3.backup-2026-08-17T00-00-00.000Z-<uuid>.sqlite3",
    "sha256": "<64 位小写十六进制>",
    "size_bytes": 123456,
    "created_at": "2026-08-17T00:00:00.000Z",
    "schema_version": 13,
    "instance_id": "<32 位小写十六进制>"
  },
  "verified_at": 0,
  "deleted_backups": 0,
  "recovered_temporary_files": 0
}
```

列出所有仍在副本卷中的已验证文件：

```sh
docker compose run --rm --no-deps backup node dist/backup/runner.js list-backups
```

若损坏文件使严格列表失败，使用容错清单查看每个可识别文件的状态和可取得的摘要：

```sh
docker compose run --rm --no-deps backup node dist/backup/runner.js list-backup-files
```

列表中的 `name` 与 `sha256` 必须成对保存。自动保留策略只删除最旧且能安全验证的副本，并始终保留状态文件所引用的最近成功副本；损坏、外部实例或发生竞态的旧文件会被保留并报告 retention 故障，但不会阻止先发布新的恢复点。确认无需保留某个损坏文件后，只能用容错清单给出的精确名称和 SHA-256 删除：

```sh
docker compose run --rm --no-deps backup node dist/backup/runner.js \
  delete-backup-file <BACKUP_NAME> <BACKUP_SHA256> \
  --confirm-delete-backup-file
```

该命令拒绝状态引用的恢复点、路径逃逸、链接、sidecar、摘要变化和无法取得摘要的异常现场。并发操作由 `/backups/perpay-local-backup.lock` 串行化。只有可识别且链接数、文件类型均正常的 staging 临时文件会在下一次操作开始时自动收敛；其他异常制品会保留现场并让健康检查失败。

状态文件位于 `/backups/perpay-local-backup-state.json`，记录最近成功副本、摘要、大小、schema、实例 ID、保留数量和错误阶段。不要手工编辑、复制半个文件或删除它来绕过健康检查。

健康输出中的 `backup_required: true` 表示刚完成恢复、必须立即为当前时间线创建新副本；下一轮成功后自动变为 `false`。`backup_in_progress: true` 表示六小时执行窗口内仍有持锁备份，合法临时文件不会被误报为崩溃残留。锁超过六小时执行窗口、创建时间在未来、格式或文件身份异常，或者失去活动持有者后仍有中断发布文件时，`recovery_required` 会立即变为 `true`，即使最近一次备份仍在允许年龄内也会判定备份不健康。应用状态接口异步流式复核最近副本摘要，并将结果合并缓存 5 秒，不会在支付事件循环中同步读取整份数据库。

## 从本机副本恢复

恢复会替换当前数据库，必须先确认选中的文件名和 SHA-256，且停掉应用和周期备份：

```sh
docker compose stop backup
docker compose stop app
docker compose run --rm --no-deps maintenance \
  restore <BACKUP_NAME> <BACKUP_SHA256> \
  --confirm-replace-current-database
docker compose up -d --wait --wait-timeout 900 app backup
```

`maintenance` 只在这条命令期间创建，不会改变默认 `docker compose up -d` 的服务集合。恢复流程会重新计算摘要、检查 SQLite 完整性与 schema 兼容性，把被替换的数据库先保存为带时间戳的隔离文件，再原子发布恢复结果；只有无法确定发布结果、检测到活动租约或遇到孤立 sidecar 等情况才会保留维护锁和现场，普通参数或完整性校验失败会清理未发布 staging 并释放锁。任何失败都不能直接删除锁或猜测恢复是否完成。选中的恢复点会先写入备份状态并受到保留策略保护；恢复成功后 `backup` 会立即为恢复后的当前时间线创建一份新副本，在此之前 `backup_required` 保持为 `true`，备份健康保持未就绪。

恢复后检查：

```sh
docker compose exec -T backup node dist/backup/runner.js health
docker compose exec -T app node -e \
  "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
```

每次替换已有数据库都会留下一个 `perpay.sqlite3.before-restore-*` 隔离副本。先列出并核对状态；数量增长时可显式保留最新 N 份，或按精确名称和 SHA-256 删除一份：

```sh
docker compose run --rm --no-deps --entrypoint node maintenance \
  dist/database/maintenance.js list-pre-restore-quarantines
docker compose run --rm --no-deps --entrypoint node maintenance \
  dist/database/maintenance.js prune-pre-restore-quarantines <KEEP_COUNT> \
  --confirm-prune-pre-restore-quarantines
docker compose run --rm --no-deps --entrypoint node maintenance \
  dist/database/maintenance.js delete-pre-restore-quarantine \
  <QUARANTINE_NAME> <QUARANTINE_SHA256> \
  --confirm-delete-pre-restore-quarantine
```

数量清理不会自动删除无法验证的隔离库；损坏但仍是普通单链接文件的隔离库只能使用容错清单给出的精确摘要删除。清理前必须先保留必要的卷外恢复集。

恢复的是数据库状态，不会自动恢复 Compose 中填写的密码、支付宝密钥、经营码、Webhook 密钥、反向代理证书或公开 URL。恢复时必须继续使用与数据库兼容的固定镜像，并保留同一套秘密配置。

## 维护与故障处理

普通备份和备份卷异常文件只通过 `dist/backup/runner.js` 管理；`schedule` 是长期服务入口，`clear-lock` 只用于下述故障处置。数据库维护工具只处理数据卷中的迁移恢复点、恢复前隔离库和维护锁，不要混用两个卷的入口。

恢复异常时，在 `app` 与 `backup` 都已停止的前提下检查维护锁：

```sh
docker compose stop backup
docker compose stop app
docker compose run --rm --no-deps --entrypoint node maintenance \
  dist/database/maintenance.js inspect-maintenance-lock
```

只有在确认没有任何应用或维护进程运行后，才可使用 `clear-stale-maintenance-lock` 并按检查结果提供精确 token 和确认参数。备份锁的单次操作最长 6 小时；先用只读的 `backup-runner inspect-lock` 查看状态和精确 token。创建超过 6 小时的锁会使健康失败，但超过 7 小时才具备显式清理资格，而且不会自动删除；必须停止所有备份进程，再通过 `backup-runner clear-lock` 提供精确 token 和确认参数。不要用 `run-once` 探测锁，也不要用 `rm` 绕过检查。迁移恢复点只通过 `list-migration-backups` 和 `restore-migration-backup` 处理，具体故障分支见 [恢复故障处置](RECOVERY.md)。

若 `backup` 短暂失败但最近一次成功仍在允许年龄内，应用仍可运行；备份健康只影响监控状态，不撤销已经确认的支付。超过最大允许年龄、状态损坏、实例 ID 不一致或找不到最近副本时，应停止创建新的高风险维护操作并先修复备份卷。

## 备份边界与异地保护

副本是同一主机上的明文 SQLite 文件。SHA-256 和完整性检查只能发现部分损坏或错用，不能提供保密性，也不能抵御拥有备份卷写权限的攻击者。正式处理真实资金前，应将选定副本、精确 SHA-256、固定镜像引用、兼容 Release 说明和秘密配置分别放入受访问控制的加密异地备份，并实际演练恢复。

不要把 `/data`、`/backups` 或导出的 SQLite 文件提交到 Git。导出到宿主机时，每次使用一个全新的、已被忽略且权限受限的目录；复制完成后重新计算 SHA-256。主机磁盘、Docker 卷、账号入侵和同时删除两个卷不在本地备份的保护范围内。

## 支持范围

发布镜像与 Compose 只支持 Linux Docker Engine 的 `amd64` 和 `arm64`，所有卷、权限、导出和恢复命令都以 Linux 语义为准。
