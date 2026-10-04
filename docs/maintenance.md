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

公开探针的深度数据库结构校验及就绪状态聚合结果最多缓存 1 秒，维护锁、租约、时钟和存储空间等运行条件仍逐次检查。该缓存不用于下单、管理操作或维护工具的严格数据库检查；探针正常不替代实际请求的收款准入校验。

## 采集持续失败

管理员面板的运行状态会显示最近失败属于正常采集还是历史补采、查询窗口、可读原因和计划下次尝试时间。账户级连续失败达到 3 次时显示“采集持续失败”；该计数不是同一张账单页的重复次数。历史补采失败不等于正常采集也停止，收款是否暂停仍以就绪状态为准。

1. 记录错误码、失败窗口和最近失败时间；任务及分段编号可在“运行技术信息”中查看。不要把原始账单、密钥或完整数据库公开分享。
2. 网络或超时错误先检查网络；身份或权限错误检查支付宝应用、当前密钥和授权。限流时等待已有退避，不反复重启或改间隔试图绕过保护。
3. 页面结构、重复流水编号或时间越界错误，保留现有错误证据和已验证备份，核实支付宝接口语义或上游变更。系统仍按原有调度重试原窗口；上游恢复并接受有效页面后，当前失败告警自动清除，历史证据不删除。
4. 持续不合规的页面不能通过刷新面板修复。需要程序修正时，使用匹配数据库版本的构建，并遵循下方升级、备份和停服流程处理。

**禁止手改数据库、删除或重置游标、自动跳过失败页或强行完成分段。** 未证明数据完整就推进覆盖位置可能永久漏账。此功能只提供诊断和恢复指引，不新增手动重试、跳过页面或修复数据的按钮。

下一次尝试时间来自实际运行中的调度器，不从退避截止时间猜测；正在采集、任务停止、运行时切换、调度状态存储恢复或无法确定时不显示计划时间。存储恢复定时器不是支付宝查询计划，恢复成功后才显示实际采集时间，原有最小间隔和退避截止时间不变。重启后失败次数和证据来自持久化记录；“诊断暂不可用”不代表采集恢复。

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

## 预发布版本与更新通道

支持正式版 `X.Y.Z` 和 SemVer 预发布版，例如 `0.3.0-alpha.1`、`0.3.0-beta.2`、`0.3.0-rc.1`（编号仅作格式示例，部署前请确认相应 Release 已发布）。预发布标识的纯数字部分不能有前导零，例如 `rc.01` 无效。发布版本最长 64 个字符；为保持容器标签一致，不使用 `+build` 元数据。

- **正式版实例**只检查 GitHub 最新正式 Release，不会提示测试版。
- **预发布版实例**检查已公开的正式版与预发布版，按 SemVer 优先级取最高版本，不按发布时间或字符串排序，也不限定当前主次版本。例如 `rc.2 < rc.10 < 同版本正式版`；更高基础版本的预发布版也可能成为更新目标。草稿、非法版本及预发布标记与版本号不符的 Release 不作为更新候选。
- 更新检查仍然只是提示，不自动安装，也不会建议降级。没有新正式版时，已安装的 RC 仍能检查后续 RC；读不到完整结果时显示检查不可用，而不是“已是最新”。预发布目录最多读取 5 页、每页 100 项，并有响应大小及整体超时限制。
- 根目录部署模板和正式 Release 附件继续使用稳定版 `latest`。预发布 Release 的 Compose 附件将 `app`、`backup`、`maintenance` 固定为同一预发布版本，**不会自动跟随下一版 RC**；升级时明确修改三个服务的镜像版本，再拉取并重启。
- 预发布流水线仍执行原有测试、安全扫描及隔离部署/备份恢复验收，但只发布固定版本镜像，并将 GitHub Release 标为预发布；不会修改镜像或 GitHub 的 `latest`。紧急 latest 恢复流程也只接受正式版。

发布时 Git 标签使用 `vX.Y.Z[-预发布标识]`，`package.json`、锁文件根版本、`src/version.ts`、OpenAPI `info.version` 和 Dockerfile 版本必须一致。无需为了启用预发布支持修改数据库兼容范围；实际升级仍应按发布说明核对数据库兼容性，并先保管好数据库及主密钥。预发布版本不建议直接用于生产收款。

## 固定版本与回滚

将 Compose 中 `app`、`backup`、`maintenance` 的镜像统一改成同一个[已发布版本](https://github.com/Mashiro0619/PerPay/releases)，再执行：

```sh
docker compose pull
docker compose up -d
```

回滚前先备份并查看版本说明。旧版本不一定兼容新版数据库；需要恢复时，使用目标版本兼容的备份。

当前源码（基于 `0.3.1`，白名单功能尚未发布）最新数据库 schema 为 33，运行兼容范围为 24—33，应用启动时会自动迁移旧结构。已发布 `0.3.1` 镜像最多支持 schema 31，不能打开 schema 33 数据库。正式 `0.3.0` 只支持到 schema 29，不能直接打开升级到 schema 31 的数据；已发布的 `0.3.0-alpha.1` 只支持到 schema 26，不能打开升级到 27—31 的数据。升级前请核对目标版本的发布说明和数据库兼容范围，不要只比较应用版本名称。

本轮数据结构变化：

| 迁移 | 作用与数据保留范围 |
| --- | --- |
| 27 | 允许人工关联理由缺省，保留其他管理员财务操作的理由要求；不改写已有理由或证据。 |
| 28 | 增加支付宝应用密钥变更表，加密保存待启用密钥及变更历史；不替换现有密钥。 |
| 29 | 分离 API 客户端身份和凭证，允许未生成 API 密钥的禁用客户端身份供管理员测试订单关联；保留已有客户端、密钥版本、订单外键和历史记录，不自动生成密钥或放行业务 API。 |
| 30 | 保存支付系统自定义名称，默认 PerPay；不改变订单、密钥或支付配置版本。 |
| 31 | 增加可选商家帮助链接，旧实例默认无链接；不改变支付配置版本。 |
| 32 | 增加管理员 IP 白名单，默认关闭且规则为空；不改变支付配置版本。 |
| 33 | 增加最小采集间隔和持久化采集等待状态；旧实例默认继承活跃间隔。 |

迁移 21（匿名密码验证预算）、22（金额复用冷却）、23（独立提醒忽略状态与管理员退款标记历史）、24（界面显示设置）及 25—26（管理员查询索引）继续保留。

升级前先使用旧构建完成备份，并另外保存主密钥；然后停掉应用和自动备份，将 `app`、`backup`、`maintenance` 切换为同一份支持 schema 33 的构建（固定标签或镜像摘要）。应用完成迁移后，再验证健康状态、后台任务和备份恢复。备份、恢复与密码恢复工具不会代替应用迁移数据库，不要将旧维护镜像或已发布的 alpha.1 镜像用于升级后的数据。

仅当数据库处于目标构建支持的 schema 范围内，才可直接回滚程序。退回只支持 schema 26 的已发布 alpha.1，需要与该版本兼容的升级前备份及原主密钥；**不能用旧镜像直接打开 schema 33，也不能手动修改 schema 版本号伪装降级**。`ghcr.io/mashiro0619/perpay:0.3.1` 仅适用于 schema 31 及以下，不包含本次未发布白名单功能；执行升级前应确认该版本的 Release 和镜像已实际发布，源码版本号变更不代表镜像已经可用。

迁移 23 不修改历史订单金额、退款状态、记账分录、异常证据、已生成通知或既有审计哈希，也不把旧退款登记自动转换为管理员标记。旧通知继续投递；提醒忽略状态与标记随数据库备份和恢复持久保存。普通支出及历史支出提示只从待处理视图排除，不删除原记录。旧退款登记写接口返回 `410 / refund_recording_retired`，外部退款后请使用订单详情中的管理员标记。

**没有待处理提醒不代表运行正常：** 批量忽略不会消除账本冲突或通知失败，真实运行计数与重试保持原规则。升级验证和恢复演练请使用隔离数据库，不要为测试而重写运行数据。

**不要为了回滚程序而直接覆盖已经产生新流水的数据库。** 旧备份不包含备份之后的订单、入账和操作记录。应先保留当前完整数据及主密钥；若升级后出现问题，先限制新下单，再使用兼容当前结构的修正版处理。

## 启用与验证备份

保存后台备份策略只更新间隔和保留数量，不会启动服务器进程。请以运行状态中的最近成功和可用备份为准；主密钥需另行保存。

Docker Compose 部署，在部署目录执行：

```sh
docker compose up -d backup
docker compose logs --tail=100 backup
docker compose --profile maintenance run --rm maintenance health
```

需要单次验证时，先停止定时备份进程，避免争用；应用可继续运行：

```sh
docker compose stop backup
docker compose --profile maintenance run --rm maintenance run-once
docker compose --profile maintenance run --rm maintenance list-backups
docker compose up -d backup
```

源码部署：使用与应用相同的构建、数据目录和备份目录，以相同用户运行。定时备份不读取主密钥；恢复时才需要原主密钥。

```sh
# 换成该实例的实际目录，不能指向另一实例。
export PERPAY_DATA_DIR=/srv/perpay/data
export PERPAY_BACKUP_DIR=/srv/perpay/backups
node dist/backup/runner.js schedule
```

前台运行时日志直接输出到终端。正式部署交给 systemd 等服务管理器；若自建服务名为 `perpay-backup`，用 `journalctl -u perpay-backup -n 100 --no-pager` 查看日志。单次验证前停止这份定时服务，执行以下命令，再恢复定时服务：

```sh
node dist/backup/runner.js run-once
node dist/backup/runner.js list-backups
node dist/backup/runner.js health
```

不要同时运行两份定时备份，也不要把不同实例指向同一目录。

成功备份不等于已完成恢复演练；恢复仍按下节在停服、保留当前数据后执行。

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

## 管理员 IP 白名单与离线恢复

**以下功能属于尚未发布的源码改动。已发布 v0.3.1 镜像仅支持 schema 31，不包含此功能；不要使用该旧镜像操作 schema 33 数据库。**

安全设置中可启用 IPv4 / IPv6 / CIDR 白名单，默认关闭。保存立即生效，启用时必须包含当前客户端 IP；关闭后保留规则。白名单覆盖页面、资源及所有管理 API，不替代密码认证，不限制支付接口和健康检查。最多 100 条、合计 8 KiB（含换行分隔），不支持域名、端口或 /0 全网规则。

代理部署必须准确配置 `PERPAY_TRUSTED_PROXY_CIDRS` 并由可信代理设置转发头，不要信任任意来源。动态公网 IP 变化可能导致失去访问。升级到支持 schema 33 的构建前先备份，app、backup 和 maintenance 必须使用同版本镜像；恢复数据库后也会恢复该备份中的白名单。

如被锁在面板外，在服务器执行：

```sh
docker compose stop app backup
docker compose --profile maintenance run --rm --no-deps --entrypoint node maintenance dist/identity/disable-admin-allowlist.js --confirm-disable-admin-allowlist
docker compose up -d app backup
```

异常退出后等待租约过期（约 30 秒）再试。源码部署先停止服务，再将 `PERPAY_DATA_DIR` 指向原数据目录，执行 `node dist/identity/disable-admin-allowlist.js --confirm-disable-admin-allowlist`。命令只关闭白名单、保留规则并记录审计，不修改密码、会话或支付数据；不会自动迁移数据库。不要用旧版本维护镜像操作升级后的数据库。

## 采集最小间隔

支付宝采集设置中的“采集最小间隔（秒）”限定一轮完成后到下一轮开始的最短等待，不是浏览器状态刷新间隔。必须满足：5 ≤ 最小间隔 ≤ 活跃间隔 ≤ 常规间隔 ≤ 3600。新实例默认 8 秒；升级实例继承既有活跃间隔，旧 API 更新省略该字段会保留原值。自动与手动触发共用单轮执行，不能绕过限流、失败退避和安全延迟；分页及补采续行保留原调度语义。配置更新及进程重启不会清除已持久化的等待状态。

## 收银台手动核实

收银台自动 GET 约每 2.5 秒读取 PerPay 订单结果，不触发支付宝采集，也不让手动按钮转圈。“查询付款状态”会提交独立的手动核实请求：等待最小间隔、复用或提前采集、对账完成后再读取订单。多人点击合并到同一账户采集任务；已结束订单不会新增采集。按钮最多等待 30 秒，之后继续静默更新，后台已有任务不会因此取消。

“本轮完成”不等于支付宝已提供刚发生的付款流水。原有安全延迟和采集窗口继续生效；采集失败、对账失败或运行时切换会显示核实未完成，而不是宣称未付款。进度仅暂存内存，服务重启后可能消失；不代表付款凭据。
