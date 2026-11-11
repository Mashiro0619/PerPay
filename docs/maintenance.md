<!-- SPDX-License-Identifier: MIT -->

# 维护与恢复

以下命令在 `docker-compose.yml` 所在目录执行。[返回部署说明](../README.md)。

| 当前任务 | 操作入口与完成结果 |
| --- | --- |
| 检查运行 | [查看状态](#查看状态)：应用及备份容器正常；后台展示收款与查账状态。 |
| 制作可恢复副本 | [启用与验证备份](#启用与验证备份) → [异地保存](#主密钥与备份的异地保存)：保存数据库、原主密钥、版本号和校验值。 |
| 更新 | [固定版本与回滚](#固定版本与回滚)：选择目标版本、备份、统一三个服务的镜像，再验证启动。 |
| 恢复 | [原服务器](#原服务器恢复)或[全新服务器](#全新服务器恢复)：导入原密钥、校验备份并恢复，核对原订单和网站后接管收款。 |

日常记录最近成功备份、最近异地副本和最近恢复演练的日期。后台的可用备份数量用于确认本机副本，异地保存和恢复演练按下文完成。

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

运行时要求数据卷至少保留 64 MiB 可用空间；备份另行检查备份目录是否能容纳当前数据库快照。

## 后台详情与配置编辑

当前后台从列表打开记录详情，从设置摘要的编辑入口修改配置。手机使用全屏弹层；标题和操作区保留在容器内，正文可以滚动。网站设置在同一个编辑窗口切换五个分组，默认模板仍只影响新建网站。

记录地址中的 `overlay` 参数是界面状态，复制地址可以重建父页条件和目标对象。旧详情路径继续兼容；`selected_site` 只记住导航选择，详情与写操作仍按实际资源路径执行管理员权限及网站范围校验。

保存冲突时先读取并核对最新配置。取消离开保留草稿；关闭页面不代表取消已提交请求，恢复网络不会自动重放写操作。账号或网站删除须以服务器成功结果为准，会话撤销和密码修改继续使对应登录失效。处理界面问题时保留完整页面地址、实际版本、浏览器及报错说明，不在故障材料中粘贴密钥明文。开发时需保持的规则见[后台交互约束](../web/README.md#后台交互约束)。

复现界面问题可使用[本地预览](development/ui-verification.md#本地预览)验证临时配置保存和校验反馈；演示健康状态及合成数据不能替代部署实例的维护检查。

## 外部监控

在独立于 PerPay 宿主的监控服务中配置告警，避免宿主失联时监控也一起停止。以 Uptime Kuma 为例，新建 **HTTP(s) - Keyword** 监控，URL 填实际公网 HTTPS 地址的 `/readyz`，关键字完整填写 `"status":"ready"`（包含双引号）。设置请求超时、检查间隔及通知渠道；响应不是成功状态、超时或缺少该关键字时均告警。

`degraded` 可能仍返回 HTTP 200，例如最近一次查账成功尚未过期，但后续任务已经失败。因此不能只检查 HTTP 状态码，也不能只匹配 `ready` 子串；`degraded` 和 `not_ready` 都应触发告警。首次配置、升级及计划维护期间，可在监控服务中设置有截止时间的静默。

`/readyz` 不包含自动备份的健康状态。还需在宿主上定期检查 `backup` 容器，并将非零退出码作为告警；外部监控同时检查这项定时任务是否按时上报。以下命令在部署目录执行，只有容器正在运行且 Docker 健康状态为 `healthy` 才成功：

```sh
backup_container="$(docker compose ps --all --quiet backup)" &&
test -n "$backup_container" &&
test "$(docker inspect --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$backup_container")" = 'true healthy'
```

容器不存在、已停止、缺少健康检查、处于 `starting` 或 `unhealthy` 时均不能视为备份正常。当前 Compose 每 5 分钟检查一次，超时为 10 秒，启动宽限为 10 分钟，连续失败 3 次标记为 `unhealthy`；监控侧应结合启动宽限设置告警延迟。

排查时可执行 `docker compose exec -T backup node dist/backup/runner.js health` 查看备份健康详情；返回 `ok: false` 时退出码为 1。保持 `backup` 的网络隔离，在宿主运行容器状态检查，不向应用或备份容器挂载 Docker Socket。

<a id="采集持续失败"></a>

## 查账持续失败

管理员面板的运行状态会显示最近失败属于正常查账还是历史查账、查询窗口、可读原因和计划下次尝试时间。账户级连续失败达到 3 次时显示“查账持续失败”；该计数不是同一张账单页的重复次数。历史查账失败不等于正常查账也停止，收款是否暂停仍以就绪状态为准。

1. 记录错误码、失败窗口和最近失败时间；任务及分段编号可在“运行技术信息”中查看。不要把原始账单、密钥或完整数据库公开分享。
2. 网络或超时错误先检查网络；身份或权限错误检查支付宝应用、当前密钥和授权。限流时等待已有退避，不反复重启或改间隔试图绕过保护。
3. 页面结构、重复流水编号或时间越界错误，保留现有错误证据和已验证备份，核实支付宝接口语义或上游变更。系统仍按原有调度重试原窗口；上游恢复并接受有效页面后，当前失败告警自动清除，历史证据不删除。
4. 持续不合规的页面不能通过刷新面板修复。需要程序修正时，使用匹配数据库版本的构建，并遵循下方升级、备份和停服流程处理。

可在 **运行状态 → 查账 → 手动查账** 请求一次查账。手动与自动查账共用当前账户的调度器，正在执行时合并请求，普通等待可提前到允许开始的时间；最小间隔、支付宝限流、失败退避和存储恢复保护仍然生效。页面会区分等待、执行中和本轮结果，接受请求不等于查账完成。刷新运行状态只读取状态，不发起查账。手动任务进度暂存于服务进程，页面刷新可继续查看；服务重启或运行配置更换后，应重新核对当前状态。

**禁止手改数据库、删除或重置游标、自动跳过失败页或强行完成分段。** 未证明数据完整就推进覆盖位置可能永久漏账。手动查账沿用正常查询窗口、验签和完整性检查，不跳过失败页、不修改账务事实，也不代表某笔订单已付款。未配置、查账任务不可用或只读演示时不能发起请求。

下一次尝试时间来自实际运行中的调度器，不从退避截止时间猜测；正在查账、任务停止、运行时切换、调度状态存储恢复或无法确定时不显示计划时间。存储恢复定时器不是支付宝查询计划，恢复成功后才显示实际查账时间，原有最小间隔和退避截止时间不变。重启后失败次数和证据来自持久化记录；“诊断暂不可用”不代表查账恢复。

## 历史重复收款关联的升级检查

当前版本按稳定收款账号、网关环境和支付宝流水号检查生效关联。旧版更换 App ID 后若曾将同一付款的来源副本确认给不同订单，新版的启动、备份及恢复完整性检查会拒绝这类数据。本项不改变数据库结构版本。

升级前保留原版本及已验证备份，并完成以下检查：

1. 暂停业务网站接收新订单，在原版本的 **对账 → 支付宝流水** 中将“关联状态”筛选为“多笔关联”。检查每笔流水的全部生效关联，核对支付宝实际收款及业务网站履约。
2. 确认哪条关联有误后，在原版本后台使用该记录的“撤销关联”处理。撤销会将对应订单置为收款有争议，并记录 `PAYMENT_DISPUTED` 事件，按通知配置投递；业务网站还需核对已经执行的充值、发货等操作。
3. 重新检查多笔关联结果，为纠错后的数据库创建新备份并另存主密钥，再升级。包含旧重复关联的历史备份不能通过新版完整性验证，应保留其来源版本和用途说明。

若已升级并因完整性检查无法启动，先停服、限制实例访问，使用与当前数据库结构兼容的原版本完成上述核对与纠错。不要直接修改数据库记录或关闭完整性校验，也不要把未经核对的订单自动撤销。

## 忘记管理员密码

在服务器上执行。使用与实例一致的镜像版本，先停止应用和备份：

```sh
docker compose stop app backup
docker compose --profile maintenance run --rm --no-deps --entrypoint node maintenance dist/identity/recover.js --confirm-reset-admin-password
```

按提示输入新密码两次（不回显）。密码至少 6 个字符；成功后再执行 `docker compose up -d`。

只修改管理员密码、注销旧会话并记录审计，订单、配置和各类密钥不变。不要删除数据卷。若提示数据库被占用或维护锁未释放，先确认相关进程已停止，再按[清理遗留维护锁](#清理遗留维护锁)区分占用类型并处理。不会自动迁移数据库或重新生成主密钥。

源码部署：停掉服务后，将 `PERPAY_DATA_DIR` 指向原数据目录，运行 `node dist/identity/recover.js --confirm-reset-admin-password`。自动化可加 `--password-stdin`，从标准输入传一行 UTF-8 密码；不要把密码写在命令参数、环境变量或 shell 历史中。

## 查看备份

备份保存在 `perpay-backups` 卷，周期和保留数量在后台“系统设置 → 自动备份”调整。

备份任务在正常等待时每 30 秒读取一次策略变化，持有备份锁完成保留数量对账后确认新策略。下一次备份时间和副本过期阈值随已采纳间隔调整，最近成功备份时间保留为实际完成时间。调长间隔后的正常等待会保持健康；对账或备份失败仍显示对应原因。

```sh
docker compose --profile maintenance run --rm maintenance list-backups
```

输出中的 `name` 和 `sha256` 用于恢复。数据库备份不包含主密钥，需另外保管 `perpay-secrets` 卷。

## 预发布版本与更新通道

支持正式版 `X.Y.Z` 和 SemVer 预发布版，例如 `0.3.0-alpha.1`、`0.3.0-beta.2`、`0.3.0-rc.1`（编号仅作格式示例，部署前请确认相应 Release 已发布）。预发布标识的纯数字部分不能有前导零，例如 `rc.01` 无效。发布版本最长 64 个字符；为保持容器标签一致，不使用 `+build` 元数据。

- 在 **运行状态 → 官方更新** 选择“仅稳定版”或“包含预发布版”（默认）。默认同时检查 GitHub 已公开的正式版与预发布版，和已安装版本无关；选择“仅稳定版”后只检查最新正式 Release。旧的“跟随当前版本”偏好按新默认值处理，已有“仅稳定版”和自动检查开关偏好会保留。
- 包含预发布版时，按 SemVer 优先级选择已公开版本中的最高版本，不按发布时间或字符串排序，也不限定当前主次版本。例如 `rc.2 < rc.10 < 同版本正式版`；更高基础版本的预发布版也可能成为更新目标。草稿、非法版本及预发布标记与版本号不符的 Release 不作为更新候选。
- 自动检查默认开启，登录后及后台页面可见且联网时每 6 小时检查；隐藏或离线时暂停，恢复后补查已到期的检查。失败遵守服务端冷却期，下一次自动尝试不早于正常检查间隔；可在冷却结束后手动重试。关闭自动检查后仍可手动检查。
- 自动检查可复用服务端 5 分钟内的成功结果；手动“检查更新”直接刷新官方结果，同一通道在上次成功检查后至少间隔 60 秒。GitHub 限流时遵守官方要求的等待时间，切换通道不能绕过限制；按钮会显示等待状态，到期后可再次点击。
- 发现新版本时显示更新弹窗，提供当前版本、新版本、发布说明及更新方法。同一浏览器对同一版本只自动弹出一次，刷新、重新登录或切换通道不会重复弹出；页面失焦、存在未保存修改、业务弹窗或工作区切换时暂缓显示。侧边栏“运行状态”旁以向上箭头圆形图标标记未忽略的新版本，折叠侧栏时以角标提示；运行图标继续反映暂停、告警等状态。悬浮或键盘聚焦可查看完整说明，点击进入运行状态页。手动检查发现新版或点击“查看更新”仍可再次打开弹窗。
- “知道了”、关闭按钮及 Esc 只关闭弹窗。可在弹窗或 **运行状态 → 官方更新** 点击“忽略此版本”，隐藏当前通道中该版本及更早版本的提醒和侧边栏标记；运行状态页显示“已忽略”，仍可查看更新，出现更高版本时再次提醒。“恢复此通道更新提醒”撤销忽略，但不清除已经自动展示过的记录。
- 自动检查、通道偏好及提醒记录仅保存在当前浏览器，同源标签页同步；浏览器禁止存储时在当前页面内生效，不会变更服务器配置，也不会修改 `app`、`backup`、`maintenance` 的镜像。
- 更新检查仍然只是提示，不自动安装，也不会建议降级。选择“包含预发布版”时，没有新正式版的 RC 实例仍能检查后续 RC；读不到完整结果时显示检查不可用，而不是“已是最新”。预发布目录最多读取 5 页、每页 100 项，并有响应大小及整体超时限制。
- 根目录源码模板使用稳定版 `latest`。新发布的正式版和预发布版 Compose 附件都固定为对应版本；升级时修改顶部 `x-perpay-image`，三个服务会使用同一镜像，再拉取并重启。已有的 `latest` 配置继续跟随稳定版；选择预发布目标时需要显式填写该标签。
- 预发布流水线仍执行原有测试、安全扫描及隔离部署/备份恢复验收，但只发布固定版本镜像，并将 GitHub Release 标为预发布；不会修改镜像或 GitHub 的 `latest`。紧急 latest 恢复流程也只接受正式版，并要求 verify 和全部三个 Release UI 分片成功；只有受支持的 latest 推广失败场景可继续恢复。

发布时 Git 标签使用 `vX.Y.Z[-预发布标识]`，`package.json`、锁文件根版本、`src/version.ts`、OpenAPI `info.version` 和 Dockerfile 版本必须一致。无需为了启用预发布支持修改数据库兼容范围；实际升级仍应按发布说明核对数据库兼容性，并先保管好数据库及主密钥。预发布版本不建议直接用于生产收款。

## 审计日志与采集状态

全局“审计日志”入口为 `/admin/audit`。核心审计记录管理与关键业务事实，活动记录本次接口或任务的执行结果；同一请求可能对应多条核心事实，通过内部活动编号关联。客户端提供的请求 ID 只用于检索，不作为唯一关联依据。

列表固定按发生时间倒序排列，可按来源、类别、动作、结果、操作者、网站、来源 IP、发生日期和关键词筛选。日期按北京时间处理，默认每页 20 条，最多 100 条；翻页保留首次读取的两类来源序号边界，刷新重新读取最新记录。“未关联网站”表示当时没有记录网站关联，不应将其等同于全局管理操作。历史网站仍可筛选；旧来源哈希不转换为真实 IP。

| 接口 | 用途 |
| --- | --- |
| `GET /api/admin/v1/audit-events` | 查询核心与活动记录，返回下一页游标及快照时间。 |
| `GET /api/admin/v1/audit-events/meta` | 读取动作、历史网站、当前采集状态及保留规则。 |
| `GET /api/admin/v1/audit-events/{source}/{event_id}` | 查看安全详情、字段变化、核心指纹及关联记录；`source` 为 `core` 或 `activity`。 |
| `POST /api/admin/v1/audit-events/export` | 按筛选与日期范围生成 CSV，另需同源及 CSRF 校验。 |

所有接口都需要管理员会话，并沿用管理员 IP 白名单；网站筛选不会将全局接口变为网站专属权限。导出最多包含 366 天内的 10,000 条记录，超限时应缩小范围，不会自动截断。CSV 生成后才写入 `audit.export_generated` 核心事件；该事件不混入本次导出快照，也不表示浏览器已完成下载。导出审计仅保存筛选摘要、搜索指纹和记录数，不保存整份 CSV。

核心审计与字段变化、IP、设备等上下文持续保留。接口与任务活动保留 30 天并分批清理：普通成功查询按分钟汇总，无变化的健康查账和对账按小时汇总；新流水、异常、人工操作、首次成功及失败恢复独立记录。汇总显示真实首末时间、次数和累计耗时，并使用独立组编号。活动已清理时，核心详情及原业务事实仍可读取。完整的数据范围见[数据收集与保留](privacy.md)。

新事件的上下文摘要进入现有审计哈希链，启动及完整性检查会核对链和上下文。旧事件不回填 IP、设备或变更前后值，也不重算原哈希。秘密只保存变更标记；较大的非敏感值可用带明确标记的预览、字节数和摘要表示，页面和 CSV 都会保留这个标记。

活动正常时采用批量写入，备份与维护事件由独立进程写入 `PERPAY_BACKUP_DIR/perpay-activity/v1`，主进程只读采集并按来源序号与事件编号去重。原有 `app` 对备份卷只读、`backup` 对数据卷只读及无网络配置保持有效。所有交接事件文件统一保留 30 天，包括异常退出的生产进程留下的过期事件；高风险维护事件成功导入后的核心审计与导入回执持续保留。来源序号与清理边界等小型交接元数据继续保留，用于识别缺口，不含事件详情。应在交接窗口内完成采集，未及时导入的历史会以 `source_retention_gap` 提示，不能用空记录证明期间没有维护操作。保管备份时同时保管该目录，其中可能还有未被主库采集的事件；恢复时沿用匹配实例的记录，不直接修改来源序号或导入回执。

采集状态中的缓冲条数表示尚未落库，丢弃、写入失败和来源缺口计数表示已检测到的不完整记录。检查数据库、备份卷的可用空间与权限，结合主进程和备份进程日志定位来源；修复后确认最近写入／采集时间继续前进。不要将失败期间没有记录解释为没有操作，也不要修改已有事件来补成成功。突然终止进程可能丢失尚未落库的活动；核心业务事实与其核心审计仍在原事务中保存。

## 数据库空间与压实

数据库体积还包括支付宝账单原始响应和采集记录。订单数量少时，高频空查账也会积累大量页面、观察记录与索引。

schema 43 起，成功单页查账中的空结果和重复流水副本保留 7 天。应用启动后自动分批回收，并每小时检查一次。首次入账证据、异常及各账号最近的查账记录继续保留。日志事件 `ingest_history_pruned` 给出每批清理数量。

已回收请求保留小型响应摘要。重新查询同一历史窗口时，变化的响应需要再次确认后才进入流水，确认进度跨重启和备份恢复保存。

查看主库、WAL、空闲页及主要表和索引占用：

```sh
docker compose run --rm --no-deps --entrypoint node maintenance dist/database/maintenance.js inspect-storage
```

输出中的 `usedBytes` 是已分配给数据和索引的页面空间，`reclaimableBytes` 是已释放、可复用的空间。`tables` 列出行数、表和索引字节数；SQLite 不支持 `dbstat` 时，表级字节数为 `null`。

新备份在空间允许时自动压实空闲页，空间不足时保留完整快照。需要立即缩小主数据库文件时，先让应用完成历史重复采集清理，再执行：

```sh
docker compose stop app backup
docker compose run --rm --no-deps --entrypoint node maintenance dist/database/maintenance.js compact-database --confirm-stopped-services
docker compose up -d app backup
```

压实命令校验主密钥与数据库，使用数据卷中的临时空间，输出压实前后大小及回收字节数。该操作需要数据卷额外提供约两倍数据库大小的可用空间；命令会先检查容量。原主密钥使用现有 secrets 卷或 `PERPAY_MASTER_KEY` 配置。

## 固定版本与回滚

当前源码版本为 `1.0.0`，最新数据库 schema 为 44，运行兼容范围为 24—44。使用 schema 44 的 RC5 构建升级无需新增迁移；从 rc.4 升级会应用迁移 43、44。应用启动时自动迁移旧结构，完整改动见[1.0.0 正式版说明](releases/v1.0.0.md)。

本版支付宝接入仅使用平台状态为“已上线”、具备对应收款账户账务明细查询权限的正式应用；“开发中”应用不能查账。旧沙箱账号停止配置保存、密钥生成与启用、连接检查、查账及新订单分配；旧沙箱流水不再自动对账，对应订单不再生成、投递或重发通知。升级保留原订单、流水、通知和来源身份，不自动转换环境或归属。原使用沙箱的实例须添加正式账号，完成连接检查后调整网站的新订单分配，详见[本版接入调整](releases/v1.0.0-rc.1.md#接入调整)。

升级前先使用旧构建完成备份，并单独保存原主密钥（`PERPAY_MASTER_KEY` 或 secrets 卷中的 `master-key`）。随后停止应用和自动备份：

```sh
docker compose stop app backup
```

将 Compose 顶部 `x-perpay-image` 改为目标[已发布版本](https://github.com/Mashiro0619/PerPay/releases)的完整镜像名，`app`、`backup`、`maintenance` 统一使用支持当前数据库结构的构建。旧配置没有此项时，将三个服务的 `image` 统一修改。然后执行：

```sh
docker compose pull
docker compose up -d
```

应用完成迁移后，验证健康状态、后台任务和备份恢复。备份、恢复与密码恢复工具不会代替应用迁移数据库。升级验证和恢复演练使用隔离数据库。

采集历史回收、备份压实及争议重新确认的升级说明见[1.0.0-rc.5 版本说明](releases/v1.0.0-rc.5.md)。易支付凭据、订单与通知结构的升级说明见[1.0.0-rc.4 版本说明](releases/v1.0.0-rc.4.md)，迁移前备份临时空间修复及重试说明见[1.0.0-rc.3 版本说明](releases/v1.0.0-rc.3.md)。审计日志、客户端 ID 更换及升级要求见[1.0.0-rc.2 版本说明](releases/v1.0.0-rc.2.md)，多账号及正式应用接入要求见[1.0.0-rc.1 版本说明](releases/v1.0.0-rc.1.md)。此前的多网站与设置拆分见[1.0.0-alpha.1 版本说明](releases/v1.0.0-alpha.1.md)，提醒忽略、退款标记及旧接口退役见[0.2.2 版本说明](releases/v0.2.2.md)。

近期数据结构变化如下。

| 迁移 | 作用与数据保留范围 |
| --- | --- |
| 27 | 允许人工关联理由缺省，保留其他管理员财务操作的理由要求；不改写已有理由或证据。 |
| 28 | 增加支付宝应用密钥变更表，加密保存待启用密钥及变更历史；不替换现有密钥。 |
| 29 | 分离 API 客户端身份和凭证，允许未生成 API 密钥的禁用客户端身份供管理员测试订单关联；保留已有客户端、密钥版本、订单外键和历史记录，不自动生成密钥或放行业务 API。 |
| 30 | 保存支付系统自定义名称，默认 PerPay；不改变订单、密钥或支付配置版本。 |
| 31 | 增加可选商家帮助链接，旧实例默认无链接；不改变支付配置版本。 |
| 32 | 增加管理员 IP 白名单，默认关闭且规则为空；不改变支付配置版本。 |
| 33 | 增加最小查账间隔和持久化查账等待状态；旧实例默认继承活跃间隔。 |
| 34 | 多网站身份、完整网站配置、默认模板和网站密文；事务内验证主密钥并重加密旧业务密钥，保留旧主键、密钥值、通知证据和订单快照。 |
| 35 | 支付宝流水查询索引，支持同环境历史来源归组、交易时间筛选及收款关联历史读取；不改写账本、订单或财务操作记录。 |
| 36 | 为管理员会话增加可空的登录 IP 和 User-Agent。旧会话继续有效且未知信息保持为空；仅新登录采集信息，普通活跃更新不会覆盖原登录来源。 |
| 37 | 增加支付宝账号、独立密钥与网站分配规则；迁移原账号、历史身份、订单二维码和金额占用。金额空间按稳定账号 ID 隔离，暂停账号不停止旧单查账。 |
| 38 | 为支付宝账号增加删除状态；删除未使用账号时保留历史身份与收款配置关联，清除当前密钥并停止使用该账号。修复删除账号后数据库完整性检查和重启失败。 |
| 39 | 增加不可改写的核心审计上下文、保留 30 天的活动记录及跨进程采集回执；上下文摘要进入新事件的既有哈希链，旧事件和哈希保持不变。 |
| 40 | 增加公开客户端 ID 映射与更换记录。现有网站用原 ID 初始化，内部身份继续关联订单、密钥及幂等记录，旧 ID 持续保留占用。 |
| 41 | 增加稳定易支付商户号、版本化加密凭据及订单协议元数据；启动时为尚未配置的网站原子初始化双协议和密钥，并追加审计，保留已有设置及历史订单。 |
| 42 | 支持易支付 GET 通知及签名请求证据；原生通知目标和尝试原列保持不变，历史尝试按原生 POST 协议补齐新增字段。 |
| 43 | 为重复查账记录增加保留状态、回收计数与查询索引；后台分批回收超过 7 天且不再被引用的重复采集历史。 |
| 44 | 允许已有争议订单在人工复核并提供流水和理由后重新确认，保留历史关联、撤销和通知证据。 |

若 schema 37 旧构建因删除账号而损坏了归属关联，升级前的完整性检查会拒绝该数据库。保留当前数据后，按[1.0.0-rc.1 的恢复说明](releases/v1.0.0-rc.1.md#升级与恢复)使用删除前通过验证的备份及原主密钥恢复，再升级。

仅当数据库处于目标构建支持的 schema 范围内，才可直接回滚程序。回退到只支持较低 schema 的版本，须恢复其兼容的升级前备份及原主密钥，不能手动修改 schema 版本号伪装降级。

**已有新增账务时，不要直接以旧备份覆盖当前数据库。** 旧备份缺少备份后的订单、入账和操作记录。先保留当前完整数据及原主密钥，限制新下单，再使用兼容当前结构的修正版处理。

## 启用与验证备份

在后台「系统设置 → 自动备份」的「备份文件」中，可以查看备份目录中各份备份文件的名称、生成时间和大小，按时间倒序排列；页面刷新会同时更新文件列表和任务状态。尚未生成备份时显示空列表，目录读取失败时显示错误。文件列表只读取元数据，恢复前仍需使用下述命令校验副本。

自动备份在等待下一轮任务期间，以不超过 30 秒的间隔重读后台保存的策略，按新间隔重新计算下一轮时间，并使用新保留数量。保存策略不会启动尚未运行的备份进程。请以运行状态中的最近成功和可用备份为准；主密钥需另行保存。

自动备份在空间允许时压实快照中的 SQLite 空闲页，空间不足时保留完整快照；完成最终完整性校验后再发布备份文件。运行中的数据库继续复用已释放的页。

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

命令及定时备份失败时，JSON 日志保留 `stage`，并通过 `message` 给出可公开的原因；文件系统错误另有已知的 `error_code`。例如可区分权限不足、空间不足、摘要不匹配、主密钥不匹配和活动租约。日志不会输出任意原始异常、文件路径、密钥或上游正文；未知异常仅给出通用说明，需在服务器本地按失败阶段核查。

成功备份不等于已完成恢复演练；恢复仍按下节在停服、保留当前数据后执行。

## 主密钥与备份的异地保存

数据库备份不包含部署主密钥。默认 Compose 将它们分别放在 `perpay-backups` 卷和 `perpay-secrets` 卷；后者的文件路径是 `/run/perpay-secrets/master-key`。只有数据库备份、没有原主密钥，不能恢复其中加密保存的配置。请将两者分别加密后保存到另一台机器或离线介质，不能只留在 PerPay 宿主上。

下面以 age 公钥加密为例。宿主安装 age，只需要接收方公钥；age 解密私钥应保存在可信工作站或离线介质，不复制到 PerPay 宿主，不与密文一起上传。首次准备接收方密钥时，在可信工作站执行一次：

```bash
umask 077
age-keygen -o perpay-recovery.agekey
age-keygen -y perpay-recovery.agekey
```

妥善保存 `perpay-recovery.agekey`，将最后输出的 `age1…` 公钥带到宿主。它与 PerPay 的 `master-key` 是两种不同的密钥：前者用于解密异地导出包，后者用于解开 PerPay 数据库内的加密配置。

以下命令在宿主 Bash、`docker-compose.yml` 所在目录执行。确认没有另行运行的备份、恢复或清理进程；脚本会暂停自动备份，先生成一次新备份，再导出完整备份目录及主密钥。应用可以继续运行。若自动备份原本正在运行，退出脚本时会将其重新启动。

```bash
(
  set -euo pipefail
  umask 077
  read -r -p 'age 接收方公钥（age1...）：' recipient
  test -n "$recipient"
  mkdir -p "$HOME/perpay-offsite"
  export_directory="$(mktemp -d "$HOME/perpay-offsite/export.XXXXXXXX")"
  backup_was_running="$(docker compose ps --status running --quiet backup)"
  resume_backup() {
    if [ -n "$backup_was_running" ]; then
      docker compose start backup >&2
    fi
  }
  trap resume_backup EXIT
  docker compose stop backup

  docker compose --profile maintenance run --rm --no-deps -T maintenance run-once
  docker compose --profile maintenance run --rm --no-deps -T --entrypoint node maintenance -p 'JSON.parse(require("node:fs").readFileSync("package.json","utf8")).version' > "$export_directory/perpay-version.txt"

  docker compose run --rm --no-deps -T --entrypoint tar backup \
    -C /backups -cf - . |
    age -r "$recipient" -o "$export_directory/perpay-backups.tar.age.part"
  mv "$export_directory/perpay-backups.tar.age.part" "$export_directory/perpay-backups.tar.age"

  docker compose --profile maintenance run --rm --no-deps -T --entrypoint tar maintenance \
    -C /run/perpay-secrets -cf - master-key |
    age -r "$recipient" -o "$export_directory/perpay-master-key.tar.age.part"
  mv "$export_directory/perpay-master-key.tar.age.part" "$export_directory/perpay-master-key.tar.age"

  (
    cd "$export_directory"
    sha256sum perpay-backups.tar.age perpay-master-key.tar.age perpay-version.txt > SHA256SUMS
  )
  printf '加密导出目录：%s\n' "$export_directory"
)
```

`tar` 的输出直接通过管道交给宿主上的 age，未加密的归档不落盘；`-T` 禁用终端转换，`--entrypoint tar` 不启动应用或维护脚本，`--no-deps` 不启动依赖服务。`pipefail` 会让读取失败或加密失败中止脚本；仅完整成功的文件才去掉 `.part` 后缀。失败后先检查 `docker compose ps backup`，确认自动备份已经恢复；不要把 `.part` 文件当作可恢复备份。

将两份 `.age` 密文、`perpay-version.txt` 及 `SHA256SUMS` 复制到已配置的独立备份主机或离线介质。例如，替换以下目录、账号及地址后，在宿主执行：

```bash
cd "$HOME/perpay-offsite/export.替换为实际目录"
scp perpay-backups.tar.age perpay-master-key.tar.age perpay-version.txt SHA256SUMS \
  backup-user@backup-host:/srv/private/perpay/
```

只传上述密文和校验文件，不传 `perpay-recovery.agekey`、明文 `master-key`、未加密数据库或完整环境变量文件。保留多代异地副本；重新生成主密钥不能替代已经丢失的原主密钥。

如果部署显式设置了 `PERPAY_MASTER_KEY`，代码会优先使用该环境变量，卷内 `master-key` 可能不是当前使用的值。此时应从实际部署的受控凭据来源另外加密保存这 64 位十六进制值，而不能只导出密钥卷。对于正在运行且通过 Compose 注入该变量的 `app`，可用下面的流式命令替代上面的主密钥 tar 导出；它不会把值放到终端或命令参数中：

```bash
set -euo pipefail
umask 077
read -r -p 'age 接收方公钥（age1...）：' recipient
mkdir -p "$HOME/perpay-offsite"
output_directory="$(mktemp -d "$HOME/perpay-offsite/env-key.XXXXXXXX")"
docker compose exec -T app node -e '
  const value = process.env.PERPAY_MASTER_KEY;
  if (!/^[0-9a-fA-F]{64}$/.test(value ?? "")) {
    console.error("app 未配置有效的 PERPAY_MASTER_KEY，请检查实际部署的凭据来源");
    process.exit(1);
  }
  process.stdout.write(value + "\n");
' | age -r "$recipient" -o "$output_directory/perpay-master-key.txt.age.part"
mv "$output_directory/perpay-master-key.txt.age.part" "$output_directory/perpay-master-key.txt.age"
```

环境变量方案的密文解开后是主密钥文本，不是 tar；将这份密文与对应数据库备份一起保存。源码部署同样保存实际生效的 `PERPAY_MASTER_KEY`，或 `PERPAY_SECRETS_DIR/master-key`，不要运行会打印整个环境的诊断命令。使用密码管理器或部署平台保管变量时，另行保留其受控恢复方式。

首次导出及定期检查时，在持有 age 私钥的可信工作站下载密文，验证传输摘要，再解密并只列出归档目录：

```bash
set -euo pipefail
sha256sum -c SHA256SUMS
age --decrypt -i /安全路径/perpay-recovery.agekey perpay-backups.tar.age | tar -tf -
age --decrypt -i /安全路径/perpay-recovery.agekey perpay-master-key.tar.age | tar -tf -
```

备份包应包含已经发布的备份及其清单，主密钥包应包含 `master-key`。这能检查密文可解密、归档可读；还需按恢复章节在隔离环境做恢复演练，确认备份与主密钥配对。恢复时使用明确的备份名称、SHA-256 和原主密钥，不在生产数据目录直接展开归档。

## 恢复数据库

### 原服务器恢复

恢复会覆盖当前数据库。先保留当前数据副本，并确认原 `perpay-secrets` 卷仍在。停止应用、自动备份及所有其他会打开该数据库的进程；`docker compose stop app backup` 不会停止另行启动的维护容器。

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

### 全新服务器恢复

准备 Linux、Docker Compose、age 解密身份，以及异地保存的 `perpay-backups.tar.age`、`perpay-master-key.tar.age`、`perpay-version.txt` 和 `SHA256SUMS`。使用备份时的 PerPay 版本恢复，成功后再单独升级。下例使用独立项目名 `perpay-recovery`，所有命令都保留该项目名。

1. 新建恢复目录，将上述文件放入其中。从原版本发布页下载 `docker-compose.yml`，核对镜像：

   ```sh
   mkdir -p perpay-recovery && cd perpay-recovery
   PERPAY_RELEASE="v$(cat perpay-version.txt)"
   curl -fsSLo docker-compose.yml "https://github.com/Mashiro0619/PerPay/releases/download/${PERPAY_RELEASE}/docker-compose.yml"
   sha256sum -c SHA256SUMS
   docker compose -p perpay-recovery --profile maintenance config --images
   ```

   三个镜像应全部是 `perpay-version.txt` 记录的版本；历史模板如为 `latest`，先修改为原版本。`SHA256SUMS` 的每项都应显示 `OK`。早期副本没有版本文件时，从原部署记录核对版本后填写 `PERPAY_RELEASE`。

2. 拉取镜像，创建独立数据卷并核对为空。这里以 `sh` 启动检查容器，不启动 PerPay，也不生成新主密钥：

   ```sh
   docker compose -p perpay-recovery --profile maintenance pull
   docker compose -p perpay-recovery run --rm --no-deps --entrypoint sh app -ceu 'test -w /data; test -w /run/perpay-secrets; test -r /backups; test -z "$(ls -A /data)"; test -z "$(ls -A /run/perpay-secrets)"; test -z "$(ls -A /backups)"; id -u'
   ```

   成功输出 UID `1000`；检查包含三个卷中的隐藏文件和数据库 sidecar。如果空卷检查失败，换一个未使用的项目名并在后续所有命令中同步修改。

3. 在 Bash 中启用管道失败检查，再导入主密钥和备份。密钥直接写入 secrets 卷，保留 UID 1000 的访问权限：

   ```bash
   set -o pipefail
   age --decrypt -i /安全路径/perpay-recovery.agekey perpay-master-key.tar.age |
     docker compose -p perpay-recovery run --rm --no-deps -T --entrypoint sh app -ceu 'umask 077; tar -xf - -C /run/perpay-secrets; chmod 600 /run/perpay-secrets/master-key; test -s /run/perpay-secrets/master-key'
   age --decrypt -i /安全路径/perpay-recovery.agekey perpay-backups.tar.age |
     docker compose -p perpay-recovery run --rm --no-deps -T --entrypoint sh backup -ceu 'umask 077; tar -xf - -C /backups; test -w /backups'
   ```

   两条管道都须退出成功。若保存的是环境变量方案的 `perpay-master-key.txt.age`，主密钥导入改用下列命令；恢复配置中不再设置另一份 `PERPAY_MASTER_KEY`：

   ```bash
   age --decrypt -i /安全路径/perpay-recovery.agekey perpay-master-key.txt.age |
     docker compose -p perpay-recovery run --rm --no-deps -T --entrypoint sh app -ceu 'umask 077; cat > /run/perpay-secrets/master-key; chmod 600 /run/perpay-secrets/master-key; test -s /run/perpay-secrets/master-key'
   ```

4. 列出备份，将目标的 `name` 和 `sha256` 代入恢复命令：

   ```sh
   docker compose -p perpay-recovery --profile maintenance run --rm --no-deps maintenance list-backups
   docker compose -p perpay-recovery --profile maintenance run --rm --no-deps maintenance restore BACKUP_NAME SHA256 --confirm-replace-current-database
   ```

   工具会校验备份摘要、数据库结构、原主密钥及恢复后的数据库。只有命令退出成功并输出恢复结果后才继续；失败时保留输出，按具体错误处理。

5. 在应用仍停止时，以只读方式核对恢复的实例和数据数量：

   ```sh
   docker compose -p perpay-recovery --profile maintenance run --rm --no-deps --entrypoint node maintenance --input-type=module -e 'import {DatabaseSync} from "node:sqlite"; const db=new DatabaseSync("/data/perpay.sqlite3",{readOnly:true}); try { console.log(JSON.stringify({instance:db.prepare("SELECT value FROM system_metadata WHERE key = ?").get("instance_id"),orders:db.prepare("SELECT count(*) AS count FROM payment_orders").get(),integrity:db.prepare("PRAGMA integrity_check").get()})); } finally { db.close(); }'
   ```

   核对实例编号、订单数量及 `integrity_check: "ok"`。恢复演练可在此结束，保留结果记录；要正式接管时，先确保原实例已停止，再按[反向代理部署](reverse-proxy.md)配置域名和可信代理，执行：

   ```sh
   docker compose -p perpay-recovery up -d
   docker compose -p perpay-recovery ps
   docker compose -p perpay-recovery logs --tail=100 app backup
   ```

   用原管理员密码登录，核对原网站、订单、支付宝账号及运行状态。已有账号和数据应直接恢复，不应再次创建管理员。最后确认新的成功备份，再将域名切换到恢复实例。

### 主库损坏时隔离原始文件

主库被确认损坏（SQLite `CORRUPT`、`NOTADB` 或完整性检查失败），或已变成零字节时，可以显式请求隔离后恢复：

```sh
docker compose --profile maintenance run --rm maintenance restore BACKUP_NAME SHA256 --confirm-replace-current-database --quarantine-unreadable-current
```

使用 `--quarantine-unreadable-current` 表示已经停止所有可能访问数据库的进程。损坏的库可能无法读取租约，工具无法据此证明进程已停止；可读取的活动应用租约仍会阻止恢复。权限、I/O 或数据库繁忙等错误不会被当成损坏来绕过。

工具先校验所选备份的摘要、schema 和原主密钥，在维护锁内复制当前主库及 `-wal`、`-shm`、`-journal` 到临时副本检查，避免 SQLite 探测改写原始文件。已校验的恢复文件落盘后，才将原文件逐个移入数据目录下独立的 `perpay-unreadable-before-restore-…` 私有目录。请预留复制当前数据库及恢复文件所需的磁盘空间。

成功结果的 `quarantinedDatabaseName` 是隔离目录名，请完整保留这个目录。已有的旧主库单文件清理不会删除它。若隔离或发布中断，原始文件可能分布在数据目录与隔离目录中，维护锁会继续阻止应用启动；保留两处文件与锁，先核对失败阶段和文件，再处理恢复，不能直接删锁或重启。

所有恢复命令均不读取当前库的备份策略，暂用启动配置中的间隔和保留份数，并输出警告，以免首次不带隔离参数的尝试就改动原文件。若备份状态文件也损坏或缺失，核对选中备份后另外添加 `--rebuild-state`；它与主库隔离是独立确认，可同时使用。恢复成功后检查后台备份设置和新的备份结果；定时备份仍读取恢复后数据库中的实际策略。

## 清理遗留维护锁

仅在维护操作异常中断、数据库持续被占用或提示锁未释放时使用。先停止应用和备份，并确认所有维护容器及进程已结束；`docker compose stop` 不会停止另行启动的维护容器：

```sh
docker compose stop app backup
```

普通应用停止续期后，数据库租约通常在 30 秒内到期；维护恢复的租约可能长达 24 小时。租约到期不会自动删除锁文件。下面两类锁的位置和清理条件不同，应按错误指向的路径分别检查。

### 数据库维护锁

锁文件位于数据目录的 `perpay.sqlite3.maintenance-lock`，由 `PERPAY_DATA_DIR` 定位；它会阻止应用启动和离线恢复。Compose 的 maintenance 服务默认运行备份工具，因此本节显式指定数据库维护脚本：

```sh
docker compose --profile maintenance run --rm --no-deps --entrypoint node maintenance dist/database/maintenance.js inspect-maintenance-lock
```

检查成功会直接返回锁记录的 `token`、`operation` 和 `createdAt`。核对操作已结束后，用返回的 `token` 执行常规清理：

```sh
# 用 inspect-maintenance-lock 返回的 token 替换 DATABASE_LOCK_TOKEN。
docker compose --profile maintenance run --rm --no-deps --entrypoint node maintenance dist/database/maintenance.js clear-stale-maintenance-lock DATABASE_LOCK_TOKEN --confirm-no-maintenance-process
```

数据库维护锁的常规清理要求精确 token，并检查当前租约；7 小时只用于显示过期提示。命令会核对锁身份，拒绝未到期的应用租约；匹配的维护租约尚未到期时，常规清理同样会拒绝。根据具体错误处理特殊情况：

- 提示 `maintenance lease is still live` 时，先确认对应维护进程确已退出，核对中断操作、备份与数据库状态。只有明确决定放弃该已中断进程的数据库占用时，才在上述数据库锁清理命令中显式增加 `--force-abandon-maintenance-lease`；它不能绕过仍有效的应用租约。
- 在新数据目录首次恢复中断、活动数据库仍与临时恢复文件保持硬链接时，保留原备份及临时文件。对应的 `--finalize-interrupted-fresh-restore` 只用于该状态，工具会核对恢复记录、文件关联、摘要和数据库完整性；不能与其他强制选项合用。
- 锁记录不可读时，先检查路径、权限和文件内容。仅在确认操作进程已经结束、普通锁文件确实损坏后，才考虑以 `--force-unreadable-lock` 替代 token；该路径仍拒绝有效数据库租约。不要手动删除锁或改写租约。

### 备份发布锁

锁文件位于备份目录的 `.perpay-source-publication.maintenance-lock`，由 `PERPAY_BACKUP_DIR` 定位。它与数据库维护锁独立，检查结果为 `missing` 只说明未找到这一类锁。

```sh
docker compose --profile maintenance run --rm maintenance inspect-publication-lock
```

本节使用 Compose 默认的 `dist/backup/runner.js` 入口，检查结果中的资格字段为 `cleanup_eligible`。内部 `inspectPublicationLock()` 返回 `cleanupEligible`，由该 CLI 转换为上述字段。

只有发布锁超过 7 小时、检查结果为 `status: "stale"` 且 `cleanup_eligible: true`，并已确认没有维护进程运行时，才执行：

```sh
# 仅在检查结果 cleanup_eligible 为 true 时清理。
# 用返回的 record.token 替换 PUBLICATION_LOCK_TOKEN。
docker compose --profile maintenance run --rm maintenance clear-stale-publication-lock PUBLICATION_LOCK_TOKEN --confirm-no-maintenance-process
```

发布锁不可读时不会返回清理资格；`--force-unreadable-lock` 仅用于已确认进程退出且普通锁文件损坏的情况，工具仍要求该文件超过 7 小时。

清理成功只表示对应锁已释放。按原维护流程重新执行失败的操作，或核验已完成的恢复；确认数据库和备份状态正常后再启动服务。

## 管理员 IP 白名单与离线恢复

**以下功能随 0.3.2 引入，部署前先确认对应 Release 和镜像已经发布。v0.3.1 镜像仅支持 schema 31，不包含此功能；不要使用该旧镜像操作 schema 33 数据库。**

安全设置中可启用 IPv4 / IPv6 / CIDR 白名单，默认关闭。保存立即生效，启用时必须包含当前客户端 IP；关闭后保留规则。白名单覆盖页面、资源及所有管理 API，不替代密码认证，不限制支付接口和健康检查。最多 100 条、合计 8192 字节（8 KiB，含换行分隔），不支持域名、端口或 /0 全网规则。

保存时若其他管理员已经更新配置，点击「重新读取配置」可保留本地草稿并取得最新版本。双方都修改了 IP 列表时，页面并列展示两份规则，选择保留哪份后再保存。

代理部署必须准确配置 `PERPAY_TRUSTED_PROXY_CIDRS` 并由可信代理设置转发头，不要信任任意来源。动态公网 IP 变化可能导致失去访问。升级到支持 schema 33 的构建前先备份，app、backup 和 maintenance 必须使用同版本镜像；恢复数据库后也会恢复该备份中的白名单。

如被锁在面板外，在服务器执行：

```sh
docker compose stop app backup
docker compose --profile maintenance run --rm --no-deps --entrypoint node maintenance dist/identity/disable-admin-allowlist.js --confirm-disable-admin-allowlist
```

命令成功后，再执行 `docker compose up -d app backup` 启动服务。

若恢复命令提示数据库被占用或维护锁未释放，保持停服并按[清理遗留维护锁](#清理遗留维护锁)判断占用类型；维护租约不能按普通应用的 30 秒时长推断。

源码部署先停止服务，再将 `PERPAY_DATA_DIR` 指向原数据目录，执行 `node dist/identity/disable-admin-allowlist.js --confirm-disable-admin-allowlist`。命令只关闭白名单、保留规则并记录审计，不修改密码、会话或支付数据；不会自动迁移数据库。不要用旧版本维护镜像操作升级后的数据库。

<a id="采集最小间隔"></a>

## 查账最小间隔

PerPay 查账设置中的“查账最小间隔（秒）”限定一轮完成后到下一轮开始的最短等待，不是浏览器状态刷新间隔。必须满足：5 ≤ 最小间隔 ≤ 活跃间隔 ≤ 常规间隔 ≤ 3600。新实例默认 8 秒；升级实例继承既有活跃间隔，旧 API 更新省略该字段会保留原值。自动与手动触发共用单轮执行，不能绕过限流、失败退避和查账延迟；分页及历史查账续行保留原调度语义。配置更新及进程重启不会清除已持久化的等待状态。

## 收银台手动核实

收银台自动 GET 约每 2.5 秒读取 PerPay 订单结果，不触发支付宝查账，不显示手动核实的加载状态。“查询付款状态”会提交独立的手动核实请求：等待最小间隔、复用或提前查账、对账完成后再读取订单。多人点击合并到同一账户查账任务；已结束订单不会新增查账。按钮最多等待 30 秒，之后页面继续自动查询状态，后台已有任务不会因此取消。

“本轮完成”不等于支付宝已提供刚发生的付款流水。原有查账延迟和查账窗口继续生效；查账失败、对账失败或运行时切换会显示核实未完成，而不是宣称未付款。进度仅暂存内存，服务重启后可能消失；不代表付款凭据。
