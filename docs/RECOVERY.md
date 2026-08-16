# 恢复故障处置

本页只用于恢复命令被中断、维护锁阻止启动或备份状态损坏等少见故障。正常的备份与卷外恢复见 [自动备份与恢复](BACKUPS.md)；迁移回退决策见 [更新与回滚](UPDATES.md)。

这些命令会改变恢复锁或活动数据库路径。先停止外部入口，保存完整错误输出并确认目标 Compose 项目与卷；整个检查和处置过程必须使用创建中断现场时 `app`、`backup` 与 `maintenance` 三处相同的完整镜像引用，不要先切换或回退版本。不要根据文件名猜测、直接删锁或手工替换数据库。

## 恢复命令被中断

原子替换保证主路径仍指向完整的旧库或新库，但维护锁会故意保留，使应用拒绝启动。先依次停止两个服务，并确认没有一次性维护容器仍在运行：

```text
docker compose stop backup
docker compose stop app
docker compose ps --all
docker compose run --rm --no-deps --entrypoint node maintenance dist/database/maintenance.js inspect-maintenance-lock
```

只有确认 `backup`、`app` 和所有一次性维护容器都已停止后，才使用检查输出中的精确 token 尝试普通清锁：

```text
docker compose run --rm --no-deps --entrypoint node maintenance dist/database/maintenance.js clear-stale-maintenance-lock <LOCK_TOKEN> --confirm-no-maintenance-process
```

如果工具明确报告该 token 对应的维护租约仍在有效期，并且已经再次确认进程确实终止，才允许显式放弃租约：

```text
docker compose run --rm --no-deps --entrypoint node maintenance dist/database/maintenance.js clear-stale-maintenance-lock <LOCK_TOKEN> --confirm-no-maintenance-process --force-abandon-maintenance-lease
```

清锁后重新执行原恢复命令并核对隔离库，不要直接假定恢复已经完成。

## 全新卷恢复中断

全新卷恢复使用硬链接实现原子 no-replace 发布。如果进程恰好在主路径链接成功、隐藏 staging 尚未解除时中断，普通清锁会拒绝链接数为 2 的主库。

只有当锁记录的 operation 是本次 `restore-backup:<BACKUP_NAME>`，并已确认所有相关容器停止时，才能运行专用收尾：

```text
docker compose run --rm --no-deps --entrypoint node maintenance dist/database/maintenance.js clear-stale-maintenance-lock <LOCK_TOKEN> --confirm-no-maintenance-process --finalize-interrupted-fresh-restore
```

工具会验证 staging 与主路径是同一 inode、链接数、源备份、sidecar、SHA-256 和 schema，随后只解除 staging 并清锁。任一条件不符都会保留现场。如果收尾进程在解除 staging 后再次中断，主库会恢复为单链接；重新检查后使用普通精确 token 清锁。

## 不可读维护锁

如果恢复进程在完整写入锁记录前崩溃，检查命令可能只报告锁损坏。确认没有任何维护容器后，使用专用参数：

```text
docker compose run --rm --no-deps --entrypoint node maintenance dist/database/maintenance.js clear-stale-maintenance-lock --force-unreadable-lock --confirm-no-maintenance-process
```

这只适用于数据库维护锁，不适用于备份周期锁或备份状态文件。

## 孤立 SQLite sidecar

全新卷没有主库却残留 `perpay.sqlite3-wal`、`perpay.sqlite3-shm` 或 `perpay.sqlite3-journal` 时，恢复会拒绝继续并保留维护锁，防止应用绕过异常现场创建新库。

当前版本没有能够校验并删除孤立 sidecar 的专用维护命令，不支持在原卷上自助清理。保持服务停止并保留该卷、维护锁和脱敏错误信息；使用新的唯一 Compose 项目名和一组全新空卷，按 [自动备份与恢复](BACKUPS.md) 从已验证的卷外恢复集重建服务。不要为了复用原项目名而删除或改写异常现场；仍存在主库时也绝不能把 sidecar 当成孤立文件处理。

若仍有容器或运行时任务持有数据库句柄或 SQLite 事务，恢复会安全失败并保留锁。先停止这些容器或任务，再检查和清锁。

## 备份锁或状态损坏

`/backups/perpay-local-backup.lock` 与 `/backups/perpay-local-backup-state.json` 不属于数据库维护锁。备份锁超过 6 小时执行窗口、创建时间在未来、格式损坏或文件身份异常时，备份健康会立即失败。先停止 `backup`，再用只读命令检查锁；该命令不会修改权限、修复制品、取得锁或开始备份：

```text
docker compose run --rm --no-deps backup node dist/backup/runner.js inspect-lock
```

输出状态为 `missing`、`active`、`expired`、`stale`、`future` 或 `unreadable`。可读锁会同时返回精确 `record.token`；只有 `cleanup_eligible: true` 才已超过 7 小时安全间隔。`future` 表示系统时钟或锁时间在未来，先校准时钟并保留现场；不要改写锁时间。

只有确认所有备份进程已停止、状态为 `stale` 且 `cleanup_eligible: true` 时，才可使用检查结果中的精确 token 显式清理：

```text
docker compose run --rm --no-deps backup node dist/backup/runner.js clear-lock <LOCK_TOKEN> --confirm-no-backup-process
```

格式或文件身份损坏的锁不会公开 token。只有检查结果为 `unreadable` 且 `cleanup_eligible: true`，并确认所有备份进程已停止后，才可使用明确的强制参数；不得用删除文件的方式绕过锁：

```text
docker compose run --rm --no-deps backup node dist/backup/runner.js clear-lock --force-unreadable-lock --confirm-no-backup-process
```

状态文件损坏时不要手工编辑。保持 `backup` 与 `app` 停止，先按 [自动备份与恢复](BACKUPS.md) 核对一个已知的 name/SHA-256 对；普通恢复会拒绝损坏状态。只有明确接受用该副本中的实例 ID、schema、大小和摘要重建备份状态后，才增加显式参数：

```text
docker compose run --rm --no-deps maintenance \
  restore <BACKUP_NAME> <BACKUP_SHA256> \
  --confirm-replace-current-database --rebuild-state
```

工具仍会完整验证所选 SQLite，并在替换数据库前先原子写入保护该恢复点的新状态；恢复后会要求立即创建一份当前时间线的新备份。`--rebuild-state` 不能绕过文件类型、链接数、SHA-256、schema、实例身份或数据库完整性检查。

不要删除、改写或伪造状态来接管既有备份。保持 `backup` 停止，优先从同一代异地恢复集还原完整备份卷；其中的 SQLite 文件、状态和锁必须作为一个现场处理。没有一致副本时，应保留当前卷和脱敏错误信息，等待具备明确迁移或修复程序的版本。

## 恢复后核对

任何故障处置完成后都先启动并检查，不要立即删除源备份、隔离库或异地副本：

```text
docker compose up -d --wait --wait-timeout 900 app backup
docker compose ps
docker compose exec -T app node -e "fetch('http://127.0.0.1:8080/healthz').then(async r=>{const body=await r.text();console.log(body);process.exit(r.ok?0:1)}).catch(error=>{console.error(error);process.exit(1)})"
docker compose exec -T app node -e "fetch('http://127.0.0.1:8080/readyz').then(async r=>{const body=await r.text();console.log(body);process.exit(r.ok?0:1)}).catch(error=>{console.error(error);process.exit(1)})"
docker compose exec -T backup node dist/backup/runner.js health
```

同时核对应用实例 ID、目标备份 SHA-256、业务记录、认证系统状态和恢复前保存的镜像完整引用。等待超时不会自动回滚；先查看日志和容器健康，再决定下一步。
