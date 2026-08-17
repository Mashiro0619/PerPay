# 更新与回滚

PerPay 使用不可变应用镜像和两个外置命名卷：应用数据卷保存在线 SQLite 与迁移恢复点，备份卷保存经过校验的本地 SQLite 副本、备份状态和备份锁。同一个镜像同时运行长期 `app`、`backup` 服务和按需 `maintenance` profile；容器可以替换，卷不能随意删除。

本页只处理镜像更新、自动迁移和版本回退。日常备份、恢复以及恢复前隔离库的显式清理见 [自动备份与恢复](BACKUPS.md)；恢复命令被中断时见 [恢复故障处置](RECOVERY.md)。隔离库不会在恢复完成时自动删除，空间管理仍由部署者负责。

## 前置要求与项目身份

要求 Docker Compose v2 插件支持 `up --wait --wait-timeout`、`cp`、顶层 `name` 和长格式健康依赖。旧版 `docker-compose` v1 不受支持，也不提供绕过健康等待的兼容路径。

正式 Compose 默认顶层名称为 `perpay`，对应卷通常为 `perpay_perpay-data` 与 `perpay_perpay-backups`。`-p`、`--project-name` 和 `COMPOSE_PROJECT_NAME` 可以覆盖顶层名称；日常运维不得临时使用这些覆盖方式。真正决定卷身份的是有效项目名，不是当前目录名。

始终从同一稳定部署路径操作，并保持有效项目名不变；每次升级仍要以目标 Release 附件为新模板，不能只在旧文件中改镜像。操作前用 `docker compose ls --all`、`docker compose config --quiet` 和 `docker volume ls` 核对实例与当前配置有效性。不要运行会输出完整插值配置的裸 `docker compose config`，它会把秘密写到终端和日志。多实例部署必须为每个实例配置不同且长期不变的项目名，并分别修改宿主端口与 `PERPAY_PUBLIC_URL`。不要用 `docker compose down --volumes` 试探卷是否正确。

正式发布使用固定语义版本和 OCI digest，不使用 `latest`。Release 附件中的 `app`、`backup` 与 `maintenance` 三处 `image:` 必须完全相同；更新或回退时同时替换三处完整引用。

## 标准升级流程

1. 阅读目标版本 Release 说明，确认 CPU 架构、数据库兼容范围、schema migration、数据分叉风险和恢复要求。代理或 Docker 网络变化时重新核对 `PERPAY_TRUSTED_PROXY_CIDRS`，不得扩大为全部地址。
2. 加密保存升级前填写后的 Compose，并记录其中三处旧的完整 `仓库:版本@sha256:...` 引用。不要只记录裸 digest。
3. 保持旧应用运行，停止自动备份，创建经过验证的当前状态备份并复制到两个卷之外。复制前准备一个受访问控制、全新且为空的 `<FRESH_IGNORED_EXPORT_DIR>`；目录必须在源码树之外，或已被 `.gitignore` 明确排除，且本次操作不得复用旧导出目录：

   ```text
   docker compose stop backup
   docker compose run --rm --no-deps backup node dist/backup/runner.js run-once
   docker compose cp backup:/backups/<BACKUP_NAME> <FRESH_IGNORED_EXPORT_DIR>/<BACKUP_NAME>
   ```

   从 `run-once` 输出的 `backup.name` 与 `backup.sha256` 取精确值，复制后重新计算 SHA-256，并按 [备份与恢复要求](BACKUPS.md) 加密和限制卷外副本访问。任一步失败都不得继续，失败或部分写入的目录不得续用；如果暂时中止升级，先执行 `docker compose up -d --wait --wait-timeout 900 backup` 恢复自动备份。
4. 在受限目录中以目标 Release 附件为基线准备新的私密 Compose：迁移现有秘密、稳定项目名、宿主端口、公开 URL 和其他实例值，并按 Release 的 `Operational notes` 处理新增或变化的环境变量、卷、健康检查与安全约束。三处 `image:` 必须保留附件给出的同一完整引用。不要把填写后的新旧文件上传到在线 diff、Issue 或日志，也不要用旧模板覆盖目标附件的新结构。
5. 对候选文件运行 `docker compose -f "<NEW_COMPOSE_PATH>" config --quiet`，确认成功后再用它替换稳定部署路径中的 Compose；加密保留第 2 步的旧文件。替换过程中不得改变有效项目名，除非本次操作本来就是经过单独计划的实例迁移。
6. 只拉取镜像；此时不会停止当前应用或修改数据：

   ```text
   docker compose --profile maintenance pull
   ```

7. 重建两个服务并等待 healthcheck：

   ```text
   docker compose up -d --wait --wait-timeout 900 app backup
   ```

   大型数据库可以增加等待时间。超时或 healthcheck 失败不会自动回滚；先查看 `docker compose ps`、`docker compose logs app` 和 `docker compose logs backup`，不要并发启动恢复命令。
8. 核对核心就绪和后台状态：

   ```text
   docker compose ps
   docker compose exec -T app node -e "fetch('http://127.0.0.1:8080/healthz').then(async r=>{const body=await r.text();console.log(body);process.exit(r.ok?0:1)}).catch(error=>{console.error(error);process.exit(1)})"
   docker compose exec -T app node -e "fetch('http://127.0.0.1:8080/readyz').then(async r=>{const body=await r.text();console.log(body);process.exit(r.ok?0:1)}).catch(error=>{console.error(error);process.exit(1)})"
   docker compose exec -T backup node dist/backup/runner.js health
   ```

账务采集和自动确认任务都必须先有一次成功记录，且最近成功仍在 `PERPAY_ALIPAY_MAX_SUCCESS_AGE_SECONDS` 内，`/readyz` 才返回 200。后续瞬时故障在既有成功仍新鲜时表现为 `status: degraded`；任一任务从未成功、停止或成功记录过期后会重新返回 503，并关闭新订单和仍可付款订单的付款指令。终态订单仍可查询。必须同时检查签名的 `/api/v1/system/status` 中 `collection_ready`、`confirmation_ready` 和两个任务的成功年龄，不能只看容器正在运行。

单机个人部署接受更新期间的短暂停机，不增加多副本和负载均衡复杂度。

## 自动迁移与恢复点

新容器监听 HTTP 端口前依次完成：

1. 校验全部配置；配置无效时不打开或迁移数据库。
2. 检查已应用 migration 的连续性、名称和 checksum。
3. 如有待执行 migration，使用 SQLite online backup API 创建一致恢复点。
4. 对恢复点执行 `quick_check`、外键、真实 schema catalog、领域约束和密码学指纹检查，再原子发布。
5. 逐个事务执行前向 migration；任一步失败都让容器退出。
6. 迁移和数据库启动检查通过后，`/healthz` 返回 HTTP 200；账务采集与自动确认分别取得近期成功记录后，`/readyz` 才返回 HTTP 200。

迁移恢复点位于应用数据卷，名称中的数字是 schema 号，不是应用版本：

```text
/data/perpay.sqlite3.pre-migration-v<OLD_SCHEMA>-to-v<TARGET_SCHEMA>.sqlite3
```

同一迁移链失败重试时复用稳定文件名。恢复点与主库位于同一卷，只用于版本回退，不是异地灾备。

## 选择回退方式

只有目标 Release 明确声明旧镜像仍兼容升级后持久状态，并且没有执行旧程序不支持的 schema 或状态变更时，才可恢复升级前保存的三处完整旧镜像引用，然后执行：

```text
docker compose --profile maintenance pull
docker compose up -d --wait --wait-timeout 900 app backup
```

如果执行了旧程序不支持的 migration，仅改回旧镜像并不等于数据库回滚。恢复迁移前时点会使新版本启动后的订单、流水、账本、通知和配置变更从活动库消失；恢复工具会把被替换的新库保留为 `perpay.sqlite3.before-restore-*`，但两份历史已经分叉，工具不会自动合并。

因此，发现问题后应先停止外部入口，再依次停止自动备份和应用，避免继续扩大分叉：

```text
docker compose stop backup
docker compose stop app
docker compose run --rm --no-deps --entrypoint node maintenance dist/database/maintenance.js list-migration-backups
```

只有在明确接受活动库回到迁移前时点后，才使用列表中的精确文件名：

```text
docker compose run --rm --no-deps --entrypoint node maintenance dist/database/maintenance.js restore-migration-backup <MIGRATION_BACKUP_NAME> --confirm-replace-current-database
```

恢复工具会争用维护租约，拒绝路径穿越、链接和带 sidecar 的非自包含文件，校验源文件与 staging，并在替换主路径前持久化当前数据库的隔离副本。完成后将三处镜像引用改回兼容旧 schema 的同一版本，再启动并核对：

```text
docker compose --profile maintenance pull
docker compose up -d --wait --wait-timeout 900 app backup
```

如果恢复被中断、应用因维护锁拒绝启动或出现孤立 SQLite sidecar，不要手工删除现场，按 [恢复故障处置](RECOVERY.md) 操作。

## 平台边界

项目仅发布并支持 Linux `amd64`、`arm64` 容器；部署、更新、恢复和发布门禁均以 Linux Docker 为唯一基线。

## 不采用的方式

- 不使用 `latest` 作为正式部署版本。
- 不把 Docker Socket 挂入长期应用容器。
- 不使用常驻更新 sidecar 或无人确认的自动替换工具。
- 不在运行中的 SQLite WAL 数据库上用普通文件复制冒充在线备份。
- 不把“旧镜像启动成功”描述为数据库已经无损回滚。
