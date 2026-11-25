<!-- SPDX-License-Identifier: MIT -->

# 维护、升级与恢复

> 相关文档：[文档目录](README.md) · [快速部署](../README.md#部署) · [反向代理部署](reverse-proxy.md)

除特别说明外，以下 `docker compose` 命令均在 `docker-compose.yml` 所在目录执行。若部署时通过 `-p` 指定了自定义项目名，每条命令均须附带相同的 `-p <项目名>` 参数。

## 目录索引

| 运维场景 | 章节 |
| --- | --- |
| 版本更新、固定版本与回滚 | [更新与回滚](#固定版本与回滚) · [在线一键更新](#在线一键更新) · [预发布版本与更新通道](#预发布版本与更新通道) |
| 数据库备份、恢复与迁移 | [备份与恢复](#启用与验证备份) · [恢复数据库](#恢复数据库) · [异地保存与新服务器恢复](#主密钥与备份的异地保存) |
| 管理员账号与访问恢复 | [忘记管理员密码](#忘记管理员密码) · [管理员 IP 白名单与离线恢复](#管理员-ip-白名单与离线恢复) |
| 查账异常排查与核实 | [采集持续失败](#采集持续失败) · [收银台手动核实](#收银台手动核实) |
| 运行监控、空间维护与审计 | [状态与外部监控](#查看状态) · [数据库空间与压实](#数据库空间与压实) · [历史归档](#历史归档) · [审计日志](#审计日志与采集状态) |
| 异常中断后的维护锁处理 | [清理遗留维护锁](#清理遗留维护锁) |

---

<a id="固定版本与回滚"></a>

## 1. 更新与回滚

默认配置使用镜像 `ghcr.io/mashiro0619/perpay:latest`（指向最新稳定版）。后台 **运行状态 → 官方更新** 点击 **立即更新** 时，会根据当前部署形态自动适配以下两种方案：

- **标准手动更新（默认）**：在后台执行备份后，于服务器运行 `docker compose` 升级命令。
- **在线一键更新（可选）**：启用伴生更新器后，由后台直接触发备份、镜像拉取、容器切换与失败自动回滚。

### 标准手动更新

1. 查阅 [版本说明](releases/README.md)，确认当前版本与目标版本间是否存在升级注意事项。
2. 在后台 **系统设置 → 备份与恢复** 执行 **立即备份**，并确认已单独妥善保存原主密钥。
3. 在部署目录执行升级：

   ```sh
   docker compose pull
   docker compose stop app backup
   docker compose up -d
   docker compose ps
   ```

4. 登录后台检查 **运行状态**，确认查账、通知和备份均处于正常状态。若涉及数据库 Schema 升级，服务启动时会自动执行迁移。

### 固定版本、预发布版本与回滚

- **固定版本或使用预发布版本**：在 [GitHub Releases](https://github.com/Mashiro0619/PerPay/releases) 获取目标版本号（镜像标签**不含**前缀 `v`，如 `1.0.0` 或 `1.0.0-rc.5`），修改 `docker-compose.yml` 顶部的 `x-perpay-image` 后执行上述升级命令。如需恢复跟随稳定版，改回 `ghcr.io/mashiro0619/perpay:latest`。
- **版本回滚条件**：
  - 若目标旧版本仍兼容当前数据库 Schema，可直接切回旧版本镜像。
  - 若升级过程已提升数据库 Schema 版本，仅回退镜像无法启动，必须同步使用升级前的备份和原主密钥恢复数据库。
  - 若备份时间点之后已产生新订单，不应直接使用旧备份覆盖，建议先暂停新下单并保留现有数据，待修复版本发布后升级。

<a id="在线一键更新"></a>

### 在线一键更新（可选伴生更新器）

如需在后台直接完成升级而无需登录服务器执行命令，可启用仓库根目录提供的 [docker-compose.updater.yml](../docker-compose.updater.yml)：

1. 将 `docker-compose.updater.yml` 放置于 `docker-compose.yml` 同级目录。
2. 合并启动服务：

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.updater.yml up -d
   ```

3. 后续在后台点击 **立即更新 → 确认开始更新**，伴生更新器会依次执行：**在线备份数据库 → 拉取目标镜像 → 切换并重启 `app` → 检查 `/healthz` → 同步升级 `backup`**。若新容器启动失败或健康检查超时，自动回退并恢复旧容器。

> **安全架构说明**：
> - `app` 主容器保持只读根文件系统、非 root 运行且不挂载 `docker.sock`。
> - 仅内网隔离的 `updater` 容器持有 `docker.sock`，不对外暴露端口，不挂载业务数据卷与主密钥卷，并限定仅拉取 `ghcr.io/mashiro0619/perpay` 官方仓库镜像且拒绝降级。
> - 若 `docker-compose.yml` 中的 `x-perpay-image` 固定为旧标签，通过在线更新升级后如再次手动执行 `docker compose up -d`，需同步修改该标签（或使用 `latest`）。

### 预发布版本与更新通道

在后台 **运行状态 → 官方更新** 可调整更新检查行为（偏好保存于当前浏览器）：

- **更新通道**：支持 **仅稳定版** 或 **包含预发布版**（默认）。
- **自动检查**：默认开启，登录后检查一次，之后每 6 小时检查；页面切至后台或离线时自动暂停。点击 **检查更新** 可立即查询。
- **忽略版本**：点击 **忽略此版本** 后，该版本及更早版本不再提示，出现更新版本时仍会提醒；可随时点击 **恢复此通道更新提醒**。

<a id="历史重复收款关联的升级检查"></a>

### 旧版本升级注意事项（0.3.2 / RC1–RC5）

- **重复收款关联检查**：同一笔支付宝付款仅允许确认一张订单。若旧版本更换过 App ID 并导致同一笔流水关联至多张订单，新版启动会拒绝继续。升级前需在旧版 **对账 → 支付宝流水** 筛选「多笔关联」，撤销重复关联并重新备份后再升级。
- **旧版沙箱账号**：升级后仅保留历史查询能力，无法继续收款；请新建正式已上线应用的收款账号并切换站点绑定。
- **数据库兼容范围**：1.0.0 的数据库结构版本为 51，兼容的结构版本为 24—51。若曾使用结构版本 37 且因删除账号导致关联损坏，请先按 [RC1 发布说明](releases/v1.0.0-rc.1.md#升级与恢复) 完成恢复再升级。

---

<a id="启用与验证备份"></a>

## 2. 备份与恢复

> **警告**：完整恢复数据必须同时具备 **数据库备份文件** 与 **原主密钥**。默认配置中，备份位于 `perpay-backups` 卷，主密钥位于 `perpay-secrets` 卷；若通过环境变量 `PERPAY_MASTER_KEY` 提供主密钥，须另行妥善保存。原主密钥丢失后，重新生成的密钥无法解密既有配置。

### 开启与检查备份

- **后台操作**：进入 **系统设置 → 备份与恢复**，点击 **立即备份** 即可创建并校验副本；同页可配置自动备份间隔与保留份数（默认每 24 小时备份一次，保留 7 份）。
- **命令行检查与手动执行**：

  ```sh
  # 确认定时备份服务运行并检查健康状态（返回 ok: true 表示正常）
  docker compose up -d backup
  docker compose --profile maintenance run --rm maintenance health
  ```

  ```sh
  # 命令行手动触发一次备份
  docker compose stop backup
  docker compose --profile maintenance run --rm maintenance run-once
  docker compose --profile maintenance run --rm maintenance list-backups
  docker compose up -d backup
  ```

### 查看备份

在后台 **系统设置 → 备份与恢复 → 备份文件** 可按时间倒序查看、恢复或删除备份（恢复操作前自动创建的「恢复前备份」长期保留，需手动删除）。命令行查看列表及 SHA-256 校验值：

```sh
docker compose --profile maintenance run --rm maintenance list-backups
```

### 恢复数据库

> **注意**：恢复操作会使用所选备份覆盖当前数据库，备份时间点之后的新订单与配置变更将被清除。

#### 原服务器恢复

- **通过后台恢复**：进入 **系统设置 → 备份与恢复 → 备份文件**，选择目标副本并点击 **恢复**，核对时间后输入「恢复备份」确认。系统会自动暂停业务、保留「恢复前备份」、完成替换并恢复服务，操作结束后重新登录即可。
- **通过命令行恢复**（后台无法访问时）：

  1. 停止 `app` 与 `backup` 容器，列出可用备份的 `name` 与 `sha256`：

     ```sh
     docker compose stop app backup
     docker compose --profile maintenance run --rm maintenance list-backups
     ```

  2. 执行恢复（替换 `BACKUP_NAME` 与 `SHA256`）：

     ```sh
     # 默认使用 perpay-secrets 卷时：
     docker compose --profile maintenance run --rm maintenance restore BACKUP_NAME SHA256 --confirm-replace-current-database

     # 使用环境变量 PERPAY_MASTER_KEY 时（先在当前 shell export 后加 -e 传入）：
     docker compose --profile maintenance run --rm -e PERPAY_MASTER_KEY maintenance restore BACKUP_NAME SHA256 --confirm-replace-current-database
     ```

  3. 确认命令返回成功后重启服务：`docker compose up -d`。

<a id="主库损坏时隔离原始文件"></a>

#### 主数据库损坏时的强制恢复

当主数据库文件损坏（如 `CORRUPT` 或 0 字节）导致常规恢复无法读取旧库时，确认所有相关容器已停止后，在 `restore` 命令末尾附加 `--quarantine-unreadable-current`：

```sh
docker compose --profile maintenance run --rm maintenance restore BACKUP_NAME SHA256 --confirm-replace-current-database --quarantine-unreadable-current
```

维护工具会先校验备份文件、Schema 版本与主密钥，将损坏的原库文件移至数据目录下的 `perpay-unreadable-before-restore-...` 保留，再执行替换。若备份状态文件一并损坏，可同时附加 `--rebuild-state`。过程中若报错，请保持停服并保留输出日志排查，切勿手动删除锁文件。

### 主密钥与备份的异地保存

为防范单机故障，建议定期使用 [age](https://github.com/FiloSottile/age) 将备份、历史归档和原主密钥加密导出至异地设备或离线介质。

<a id="准备-age-恢复身份"></a>

#### 1. 生成离线 age 密钥对（仅执行一次）

在个人可信终端执行：

```bash
umask 077
age-keygen -o perpay-recovery.agekey
age-keygen -y perpay-recovery.agekey
```

将私钥 `perpay-recovery.agekey` 保留在离线介质中（不要上传至服务器），仅将输出的 `age1...` 公钥用于服务器侧加密导出。

#### 2. 服务器加密导出脚本

在服务器安装 `age`，于部署目录运行以下脚本（支持 `secrets` 卷与 `PERPAY_MASTER_KEY` 两种模式；导出期间 `app` 照常运行）：

```bash
(
  set -euo pipefail
  umask 077
  read -r -p 'age 接收方公钥（age1...）：' recipient
  test -n "$recipient"
  read -r -p 'PerPay 主密钥来源（secrets 或 env）：' key_source
  case "$key_source" in
    secrets|env) ;;
    *) printf '请按实际配置选择 secrets 或 env。\n' >&2; exit 1 ;;
  esac

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

  docker compose --profile maintenance run --rm --no-deps -T --entrypoint sh maintenance \
    -ceu 'mkdir -p /data/archives; tar -cf - -C /data archives' |
    age -r "$recipient" -o "$export_directory/perpay-archives.tar.age.part"
  mv "$export_directory/perpay-archives.tar.age.part" "$export_directory/perpay-archives.tar.age"

  if [ "$key_source" = secrets ]; then
    key_file=perpay-master-key.tar.age
    docker compose --profile maintenance run --rm --no-deps -T --entrypoint tar maintenance \
      -C /run/perpay-secrets -cf - master-key |
      age -r "$recipient" -o "$export_directory/$key_file.part"
  else
    key_file=perpay-master-key.txt.age
    docker compose exec -T app node -e '
      const value = process.env.PERPAY_MASTER_KEY;
      if (!/^[0-9a-fA-F]{64}$/.test(value ?? "")) {
        console.error("app 未配置有效的 PERPAY_MASTER_KEY，请检查实际凭据来源");
        process.exit(1);
      }
      process.stdout.write(value + "\n");
    ' | age -r "$recipient" -o "$export_directory/$key_file.part"
  fi
  mv "$export_directory/$key_file.part" "$export_directory/$key_file"

  (
    cd "$export_directory"
    sha256sum perpay-backups.tar.age perpay-archives.tar.age "$key_file" perpay-version.txt > SHA256SUMS
  )
  printf '加密导出目录：%s\n' "$export_directory"
)
```

导出完成后将整个目录传输至异地存储，并定期使用 `sha256sum -c SHA256SUMS` 与 `age --decrypt` 抽检完整性与可用性。

### 全新服务器恢复

迁移至新服务器或演练恢复时，将同一次导出的 5 个文件（`perpay-backups.tar.age`、`perpay-archives.tar.age`、主密钥 `.age`、`perpay-version.txt`、`SHA256SUMS`）放入新服务器的空目录。先以备份对应的原版本恢复，验证无误后再升级。以下以项目名 `perpay-recovery` 为例：

1. **下载对应版本配置并校验文件**：

   ```sh
   mkdir -p perpay-recovery && cd perpay-recovery
   PERPAY_RELEASE="v$(cat perpay-version.txt)"
   curl -fsSLo docker-compose.yml "https://github.com/Mashiro0619/PerPay/releases/download/${PERPAY_RELEASE}/docker-compose.yml"
   sha256sum -c SHA256SUMS
   ```

2. **拉取镜像并确认 3 个数据卷均为空**（末尾输出 `1000` 表示权限正常）：

   ```sh
   docker compose -p perpay-recovery --profile maintenance pull
   docker compose -p perpay-recovery run --rm --no-deps --entrypoint sh app -ceu 'test -w /data; test -w /run/perpay-secrets; test -r /backups; test -z "$(ls -A /data)"; test -z "$(ls -A /run/perpay-secrets)"; test -z "$(ls -A /backups)"; id -u'
   ```

3. **解密导入原主密钥与备份文件**（替换 `/安全路径/perpay-recovery.agekey`）：

   ```bash
   set -euo pipefail
   if [ -f perpay-master-key.tar.age ]; then
     age --decrypt -i /安全路径/perpay-recovery.agekey perpay-master-key.tar.age |
       docker compose -p perpay-recovery run --rm --no-deps -T --entrypoint sh app -ceu 'umask 077; tar -xf - -C /run/perpay-secrets; chmod 600 /run/perpay-secrets/master-key; test -s /run/perpay-secrets/master-key'
   else
     age --decrypt -i /安全路径/perpay-recovery.agekey perpay-master-key.txt.age |
       docker compose -p perpay-recovery run --rm --no-deps -T --entrypoint sh app -ceu 'umask 077; cat > /run/perpay-secrets/master-key; chmod 600 /run/perpay-secrets/master-key; test -s /run/perpay-secrets/master-key'
   fi
   age --decrypt -i /安全路径/perpay-recovery.agekey perpay-backups.tar.age |
     docker compose -p perpay-recovery run --rm --no-deps -T --entrypoint sh backup -ceu 'umask 077; tar -xf - -C /backups; test -w /backups'
   ```

4. **恢复数据库并导入历史归档**：

   ```sh
   docker compose -p perpay-recovery --profile maintenance run --rm --no-deps maintenance list-backups
   docker compose -p perpay-recovery --profile maintenance run --rm --no-deps maintenance restore BACKUP_NAME SHA256 --confirm-replace-current-database
   age --decrypt -i /安全路径/perpay-recovery.agekey perpay-archives.tar.age |
     docker compose -p perpay-recovery run --rm --no-deps -T --entrypoint sh app -ceu 'umask 077; tar -xf - -C /data; test -d /data/archives'
   ```

5. **停服状态下检查数据库完整性**（核对 `integrity_check` 为 `ok` 且订单数与预期一致）：

   ```sh
   docker compose -p perpay-recovery --profile maintenance run --rm --no-deps --entrypoint node maintenance --input-type=module -e 'import {DatabaseSync} from "node:sqlite"; const db=new DatabaseSync("/data/perpay.sqlite3",{readOnly:true}); try { console.log(JSON.stringify({instance:db.prepare("SELECT value FROM system_metadata WHERE key = ?").get("instance_id"),orders:db.prepare("SELECT count(*) AS count FROM payment_orders").get(),integrity:db.prepare("PRAGMA integrity_check").get()})); } finally { db.close(); }'
   ```

6. **切换上线**：确认旧实例已停止运行，配置好 [反向代理](reverse-proxy.md) 后启动 `docker compose -p perpay-recovery up -d`，使用原管理员密码登录验证无误再切换公网 DNS。

---

## 3. 管理员访问恢复

### 忘记管理员密码

可通过离线维护脚本重置密码，无需删除数据。在部署目录执行以下命令并按提示输入两次新密码（至少 6 位）：

```sh
docker compose stop app backup
docker compose --profile maintenance run --rm --no-deps --entrypoint node maintenance dist/identity/recover.js --confirm-reset-admin-password
docker compose up -d
```

重置后所有已有登录会话自动失效，订单、配置与密钥保持不变。源码部署方式下，停服后设置 `PERPAY_DATA_DIR` 并运行 `node dist/identity/recover.js --confirm-reset-admin-password`（非交互场景支持 `--password-stdin`）。

### 管理员 IP 白名单与离线恢复

后台 **系统设置 → 密钥与安全 → 管理员 IP 白名单** 默认关闭。启用前请确认 [反向代理](reverse-proxy.md) 已正确传递客户端真实 IP，且规则中包含当前管理 IP（最多 100 条 IPv4/IPv6/CIDR，不支持域名及 `/0`）。该白名单仅限制管理后台与管理 API，不影响公开收银台与业务支付接口。

若因公网 IP 变更或误配导致无法访问后台，可在服务器离线关闭白名单：

```sh
docker compose stop app backup
docker compose --profile maintenance run --rm --no-deps --entrypoint node maintenance dist/identity/disable-admin-allowlist.js --confirm-disable-admin-allowlist
docker compose up -d app backup
```

该命令仅关闭白名单开关，保留已配置的规则条目；重新登录调整规则后再启用即可。源码部署停服后设置 `PERPAY_DATA_DIR` 运行同路径脚本。

---

<a id="采集持续失败"></a>

## 4. 查账故障排查与收银台核实

同一收款账号连续查账失败 3 次时，后台 **运行状态** 会告警「查账持续失败」并暂停该账号接收新订单。根据具体报错分类排查：

| 报错类型 | 处理方式 |
| --- | --- |
| 网络连接或超时 | 检查宿主机/容器至支付宝开放平台的网络连通性、DNS 与防火墙规则，恢复后触发手动查账 |
| 身份、签名或权限错误 | 核对 App ID、应用上线状态、应用公钥与支付宝公钥配置及账务明细查询权限（详见 [支付宝配置指南](alipay-setup.md)） |
| 支付宝限流 | 等待页面显示的下一次重试时间，避免通过频繁重启或过度调低查账间隔加重限流 |
| 响应格式异常 | 保留故障时间段日志（注意脱敏密钥与账单信息），排查接口变更或版本升级需求 |

故障排除后，点击 **运行状态 → 查账 → 手动查账**（或多账号页面的 **立即查账**）。手动查账不受退避等待与最小间隔限制，查账成功获取有效账单后告警立即解除。

> **警告**：切勿直接修改 SQLite 数据库、手工重置查询游标或跳过失败账单页，否则可能导致漏账。

<a id="采集最小间隔"></a>

### 查账最小间隔与收银台手动核实

- **查账最小间隔**：在 **系统设置 → 查账设置** 调整，须满足 `5 ≤ 最小间隔 ≤ 活跃间隔 ≤ 常规间隔 ≤ 3600`（新安装默认 `8` 秒）。自动查账与收银台触发查账共享该限制，详见 [查账节奏](../USAGE.md#查账节奏)。
- <a id="收银台手动核实"></a>**收银台手动核实**：收银台页面每约 `2.5` 秒自动轮询订单状态；付款人点击 **查询付款状态** 会请求后端排队查账（同账号并发请求合并，单次最长等待 `30` 秒）。受支付宝账单同步延迟影响，付款后需数秒方能自动确认。

---

## 5. 监控、磁盘维护与审计

### 查看状态

```sh
docker compose ps
docker compose logs --tail=100 app backup
docker compose --profile maintenance run --rm maintenance health
```

- `/healthz`：检查进程与数据库连接存活状态。
- `/readyz`：检查服务接单就绪状态（支付宝配置完整、首次查账完成且自动确认正常时返回 `"status":"ready"`）。

### 外部监控

建议在独立监控节点（如 Uptime Kuma）配置两项检测：

1. **接单就绪检查**：监控 `https://你的域名/readyz`，使用关键字完整匹配 `"status":"ready"`（含双引号，不仅依赖 HTTP `200`）。
2. **备份容器健康检查**（`/readyz` 不覆盖 `backup` 容器）：在宿主机定时执行以下命令，退出码非 0 即触发告警：

   ```sh
   backup_container="$(docker compose ps --all --quiet backup)" &&
   test -n "$backup_container" &&
   test "$(docker inspect --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$backup_container")" = 'true healthy'
   ```

<a id="数据库空间与压实"></a>

### 数据库空间检查与压实

PerPay 会自动去重并压缩账单原文，同时每小时清理 7 天前的冗余空查询记录。由于 SQLite 删除数据后不会自动收缩文件体积，可按需检查占用并压实数据库：

1. **查看各表空间占用**（在线执行，无需停服）：

   ```sh
   docker compose run --rm --no-deps --entrypoint node maintenance dist/database/maintenance.js inspect-storage
   ```

2. **压实数据库文件**（操作前先完成一次备份，并预留约 2 倍数据库大小的磁盘空闲空间）：

   ```sh
   docker compose stop app backup
   docker compose run --rm --no-deps --entrypoint node maintenance dist/database/maintenance.js compact-database --confirm-stopped-services
   docker compose up -d app backup
   ```

   使用环境变量 `PERPAY_MASTER_KEY` 时，需在命令中附加 `-e PERPAY_MASTER_KEY`。

### 历史归档

如需减小在线数据库体积，可进入 **系统设置 → 备份与恢复 → 历史归档**：

1. 选择截止日期（北京时间，不含当日），点击 **创建历史归档**。
2. 系统短暂暂停业务，将截止日期前已完全完结的订单、流水和通知归档至数据目录的 `archives` 子目录，并压实在线库（未付款、争议或未决异常记录保留在在线库）。
3. 历史归档永久保存、不会自动清理，可在后台查看、下载或通过输入「永久删除」手动移除。命令行支持 `archive-history --before YYYY-MM-DD --confirm-stopped-services`（前提与压实一致）。

### 审计日志与采集状态

在全局 **审计日志**（`/admin/audit`）可查询系统配置变更、账务确认及后台任务记录：

- **核心审计**（收款确认、密钥与配置变更等）：长期保留并维护防篡改哈希链。
- **活动记录**（常规查询与后台任务）：保留 30 天，高频重复记录自动合并。
- 支持按时间范围（单次最多 366 天）、动作、操作者、网站与 IP 筛选，并支持导出 CSV（单次最多 10,000 条）。若页面提示采集异常或 `source_retention_gap`，需检查数据卷与备份卷的可用空间和权限，详情见 [数据与隐私](privacy.md) 及 [OpenAPI](../openapi.yaml)。

---

<a id="清理遗留维护锁"></a>

## 6. 清理遗留维护锁

仅当备份、恢复或压实进程异常崩溃，导致服务提示维护锁未释放而无法启动时执行本节操作。

操作前须先确认所有相关容器已停止：`docker compose stop app backup`。常规租约 30 秒过期，维护租约最长 24 小时；遗留锁文件须按报错路径使用对应维护工具检查并清理（严禁手动 `rm` 删除锁文件或直接修改数据库租约表）：

### 备份任务锁

文件位于备份目录 `perpay-local-backup.lock`。先检查锁状态，确认对应备份进程已退出后再填入返回的 `TOKEN` 清理：

```sh
docker compose --profile maintenance run --rm maintenance inspect-lock
docker compose --profile maintenance run --rm maintenance clear-lock TOKEN --confirm-no-backup-process
```

若锁文件损坏无法读取，确认进程已退出且存在超过 7 小时后可用 `--force-unreadable-lock` 替代 `TOKEN`。

### 数据库维护锁

文件位于数据目录 `perpay.sqlite3.maintenance-lock`。检查与清理命令如下：

```sh
docker compose --profile maintenance run --rm --no-deps --entrypoint node maintenance dist/database/maintenance.js inspect-maintenance-lock
docker compose --profile maintenance run --rm --no-deps --entrypoint node maintenance dist/database/maintenance.js clear-stale-maintenance-lock TOKEN --confirm-no-maintenance-process
```

若提示 `maintenance lease is still live`，仅在确认维护进程已退出并核对中断状态后方可附加 `--force-abandon-maintenance-lease`；若首次空目录恢复中途中断，使用 `--finalize-interrupted-fresh-restore` 完成收尾。

### 备份发布锁

文件位于备份目录 `.perpay-source-publication.maintenance-lock`。检查输出确认 `cleanup_eligible: true` 且对应进程已退出后再执行清理：

```sh
docker compose --profile maintenance run --rm maintenance inspect-publication-lock
docker compose --profile maintenance run --rm maintenance clear-stale-publication-lock TOKEN --confirm-no-maintenance-process
```

若锁文件损坏无法读取，确认进程已退出且存在超过 7 小时后可用 `--force-unreadable-lock` 替代 `TOKEN`。
