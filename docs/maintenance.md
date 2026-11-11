<!-- SPDX-License-Identifier: MIT -->

# 维护与恢复

[文档导航](README.md) · [部署说明](../README.md)

以下命令都在 `docker-compose.yml` 所在目录执行。默认使用 `latest`，日常更新不需要手动挑版本。如果你曾用 `-p` 指定项目名，后续命令继续带上同一个名字；新服务器恢复示例使用独立的 `perpay-recovery`。

| 当前任务 | 从这里开始 |
| --- | --- |
| 检查运行或配置告警 | [查看状态](#查看状态) · [外部监控](#外部监控) |
| 设置或核对备份 | [开启并检查备份](#启用与验证备份) · [查看备份](#查看备份) |
| 保存到其他机器或离线介质 | [主密钥与备份的异地保存](#主密钥与备份的异地保存) |
| 恢复或迁移服务器 | [原服务器恢复](#原服务器恢复) · [全新服务器恢复](#全新服务器恢复) |
| 更新或回退版本 | [更新与回退版本](#固定版本与回滚) · [更新提醒](#预发布版本与更新通道) |
| 查账或付款查询异常 | [查账持续失败](#查账持续失败) · [手动核实](#收银台手动核实) |
| 无法登录管理后台 | [重设密码](#忘记管理员密码) · [关闭 IP 白名单](#管理员-ip-白名单与离线恢复) |
| 磁盘不足或维护受阻 | [查看空间并缩小数据库](#数据库空间与压实) · [清理遗留维护锁](#清理遗留维护锁) |
| 查找操作与任务记录 | [审计日志与采集状态](#审计日志与采集状态) |

平时记下最近一次成功备份、复制到其他机器和尝试恢复的日期。这样服务器出问题时，你能知道可以恢复到什么时候。

## 查看状态

在部署目录查看服务、近期日志和备份状态：

```sh
docker compose ps
docker compose logs --tail=100 app backup
docker compose --profile maintenance run --rm maintenance health
```

| 检查入口 | 关注结果 |
| --- | --- |
| `/healthz` | 程序和数据库是否正常。 |
| `/readyz` | 现在能否接收新订单；支付宝配置、首次查账和自动确认都要正常。 |
| 后台 **运行状态** | 收款、正常查账、历史查账及其他后台任务的状态和具体原因。 |
| 备份 `health` 命令 | `ok: true` 表示检查通过；失败时查看 `last_error_stage` 指出的步骤，并检查已有备份和日志。 |

数据卷至少需要 64 MiB 可用空间，备份目录还要放得下一份完整数据库。空间不足时先[查看数据库占用](#数据库空间与压实)，不要直接删除账务表或数据库文件。

## 外部监控

把监控放在另一台机器或外部监控服务上，分别检查收款和备份，并设置告警通知。PerPay 所在服务器断网或停机时，监控仍能通知你。

**收款就绪：检查 `/readyz` 的状态内容。** 以 Uptime Kuma 为例，选择 **HTTP(s) - Keyword**，URL 填公网 HTTPS 地址的 `/readyz`，关键字完整填写 `"status":"ready"`，包含双引号。设置超时、检查间隔和告警通知。

不要只检查 HTTP 200 或单独的 `ready` 字样。`degraded` 表示已有任务异常，但最近的成功查账结果可能暂时仍可用，因此也可能返回 HTTP 200。`degraded`、`not_ready`、超时或缺少完整关键字时都应告警。安装和维护期间可以暂时关闭提醒，并设好恢复提醒的时间。

**备份：检查备份容器是否正常。** `/readyz` 不检查备份。在服务器上定期执行下面的命令；命令失败或服务器没有按时上报结果时发出告警：

```sh
backup_container="$(docker compose ps --all --quiet backup)" &&
test -n "$backup_container" &&
test "$(docker inspect --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$backup_container")" = 'true healthy'
```

容器正在运行且状态为 `healthy` 时，命令才成功；容器不存在、停止、仍在启动或检查失败都会报错。默认每 5 分钟检查一次备份，每次最多等 10 秒；启动后的前 10 分钟作为准备时间，之后连续失败 3 次会标为 `unhealthy`。外部告警的等待时间要考虑这些间隔。

需要看失败原因时，执行 `docker compose exec -T backup node dist/backup/runner.js health`；`ok: false` 时退出码为 1。上述容器检查在服务器上执行即可，备份容器继续保持无网络访问，也不需要接入 Docker Socket。

<a id="启用与验证备份"></a>

## 开启自动备份并检查结果

在 **系统设置 → 自动备份** 设置多久备份一次、保留多少份。默认每 24 小时一份、保留 7 份。保存设置后，还要确保负责备份的程序一直运行。

**Compose 部署：** 在部署目录启动备份并检查结果：

```sh
docker compose up -d backup
docker compose logs --tail=100 backup
docker compose --profile maintenance run --rm maintenance health
```

需要立即生成一份时，先停止定时备份，应用可继续运行：

```sh
docker compose stop backup
docker compose --profile maintenance run --rm maintenance run-once
docker compose --profile maintenance run --rm maintenance list-backups
docker compose up -d backup
```

确认最近一次备份成功、文件已经出现在列表中，再按[异地保存](#主密钥与备份的异地保存)复制数据库和原主密钥。想试着恢复时，使用[另一份数据目录](#全新服务器恢复)，避免覆盖正在使用的数据。

**源码部署：** 使用与应用同一版本的程序，由同一个系统用户运行，并填写这套 PerPay 的数据和备份目录。两个目录要分开，多套 PerPay 也不能共用目录：

```sh
export PERPAY_DATA_DIR=/srv/perpay/data
export PERPAY_BACKUP_DIR=/srv/perpay/backups
node dist/backup/runner.js schedule
```

长期运行时，用 systemd 等工具管理备份进程，确保退出后能重新启动。例如服务名是 `perpay-backup`，可以用 `journalctl -u perpay-backup -n 100 --no-pager` 查看日志。要手动备份，先停止这份定时服务，执行下面的命令，完成后再启动定时服务：

```sh
node dist/backup/runner.js run-once
node dist/backup/runner.js list-backups
node dist/backup/runner.js health
```

定时备份不读取主密钥，恢复才需要原主密钥。每个实例只运行一份定时备份。

修改设置后，正在等待的备份程序每 30 秒检查一次，并按新间隔安排下一次备份。最近成功时间仍以实际完成备份的时间为准。备份或文件校验失败后，会较快重试；清理旧备份失败不会延后原定重试，也不会让程序反复生成额外备份。

备份会先复制完整数据库，空间足够时再整理文件中的空闲部分，减小文件体积；空间不够整理时，仍保留完整副本。文件检查通过后才列为可用备份。失败时，日志里的 `stage` 表示失败步骤，`message` 和 `error_code` 说明原因；不要把密钥或账单原文附在公开的排错记录中。

## 查看备份

打开 **系统设置 → 自动备份 → 备份文件**，查看按时间倒序排列的名称、生成时间和大小。刷新页面会更新文件列表及任务状态；目录读取失败会显示错误。

页面显示文件名称、时间和大小。真正准备恢复时，再运行下面的命令检查文件，记下要恢复的 `name`（文件名）和 `sha256`（用于确认文件未改变的校验值）：

```sh
docker compose --profile maintenance run --rm maintenance list-backups
```

默认副本保存在 `perpay-backups` 卷，主密钥另在 `perpay-secrets` 卷。没有备份时先[启用并验证](#启用与验证备份)；提示其他备份操作正在运行时，等待该操作结束。导出或恢复前按对应步骤停止定时备份。

## 主密钥与备份的异地保存

恢复需要这套 PerPay 的数据库备份和原主密钥。默认 Compose 把备份放在 `perpay-backups` 卷，主密钥放在 `perpay-secrets` 卷中的 `/run/perpay-secrets/master-key`。如果另外设置了 `PERPAY_MASTER_KEY`，实际使用的是环境变量里的值，需要导出这一份。

把数据库和原主密钥分别加密，复制到另一台机器、移动硬盘等位置，并一起保存版本号和文件校验值。下面使用 age 文件加密工具；解密所需的私钥要单独保存在可信电脑或离线介质上，不要与加密文件放在同一处。

<a id="准备-age-恢复身份"></a>

### 准备加密备份的密钥

在可信工作站执行一次：

```bash
umask 077
age-keygen -o perpay-recovery.agekey
age-keygen -y perpay-recovery.agekey
```

`perpay-recovery.agekey` 是解密文件，留在可信电脑上；把最后输出的 `age1…` 公钥复制到 PerPay 服务器，用来加密备份。这里有两把用途不同的密钥：age 私钥解开备份包，PerPay 原主密钥解开数据库里的配置，恢复时两者都要用到。

### 导出数据库和实际主密钥

在 PerPay 服务器安装 age，确认没有其他备份、恢复或清理操作正在进行，再在部署目录用 Bash 执行下面的脚本。脚本会暂停定时备份、制作新备份，然后分别加密备份目录和原主密钥。原本正在运行的定时备份会在脚本退出时重新启动。

按实际配置选择主密钥来源：默认 Compose 输入 `secrets`；通过 Compose 给 `app` 设置了 `PERPAY_MASTER_KEY` 时输入 `env`，此时 `app` 须保持运行。应用可以在整个导出期间继续提供服务。

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
    sha256sum perpay-backups.tar.age "$key_file" perpay-version.txt > SHA256SUMS
  )
  printf '加密导出目录：%s\n' "$export_directory"
)
```

成功完成的文件没有 `.part` 后缀，明文会通过管道直接交给 age 加密。脚本失败后，用 `docker compose ps backup` 确认定时备份已经恢复；带 `.part` 的文件尚未完成，不能拿来恢复数据。

源码部署也要保存实际使用的 `PERPAY_MASTER_KEY` 或 `PERPAY_SECRETS_DIR/master-key`。从密码管理器或部署平台导出时，直接加密保存，不要打印整个环境，也不要把密钥明文写进命令参数。

### 传送与检查异地副本

将脚本输出的完整目录复制到独立位置，保留每次生成的目录名。例如，替换目录、账号及地址后执行：

```bash
set -euo pipefail
export_directory="$HOME/perpay-offsite/export.替换为实际目录"
(cd "$export_directory" && sha256sum -c SHA256SUMS)
scp -r "$export_directory" backup-user@backup-host:/srv/private/perpay/
```

导出目录应只有两份加密文件、版本号和校验文件。每次保留一个新目录，给自己留下多个可以恢复的时间点；age 私钥、主密钥明文、数据库原文件和环境配置文件不要放进去。丢失原主密钥后，重新生成一把也无法解开原来的配置。

第一次导出后，以及之后定期检查时，把导出目录下载到保存 age 私钥的可信电脑，检查文件是否完整、能否解密：

```bash
set -euo pipefail
sha256sum -c SHA256SUMS
age --decrypt -i /安全路径/perpay-recovery.agekey perpay-backups.tar.age | tar -tf -
if [ -f perpay-master-key.tar.age ]; then
  age --decrypt -i /安全路径/perpay-recovery.agekey perpay-master-key.tar.age | tar -tf -
else
  age --decrypt -i /安全路径/perpay-recovery.agekey perpay-master-key.txt.age > /dev/null
fi
```

备份包里应有可用的备份文件和清单；默认主密钥包应包含 `master-key`，环境变量方案解开后则是主密钥文本。接着按[全新服务器恢复](#全新服务器恢复)在独立目录试一次恢复，确认备份和主密钥能配合使用。不要直接解压到正在收款的数据目录。

## 恢复数据库

**恢复会用备份替换当前数据库。** 先另存当前完整数据和原主密钥，再停止应用、自动备份及其他正在使用数据库的维护程序。原服务器沿用当前程序的维护工具；恢复到新服务器时，按下面的步骤使用备份中记录的版本。如果备份之后已经有新交易，先看[回退版本时的数据处理](#固定版本与回滚)，避免丢失新增记录。

### 原服务器恢复

1. 确认原 `perpay-secrets` 卷仍在；使用环境密钥的部署须向恢复工具提供实际的原 `PERPAY_MASTER_KEY`。停止应用和自动备份，再列出副本：

   ```sh
   docker compose stop app backup
   docker compose --profile maintenance run --rm maintenance list-backups
   ```

   `stop app backup` 不会停止另行运行的维护容器，继续前确认这些进程也已结束。

2. 用选中副本的 `name`、`sha256` 替换占位值，并按主密钥来源选择命令。

   **使用 secrets 卷：**

   ```sh
   docker compose --profile maintenance run --rm maintenance restore BACKUP_NAME SHA256 --confirm-replace-current-database
   ```

   **使用 `PERPAY_MASTER_KEY`：** 维护容器不会自动取得 `app` 的环境变量。先从自己的密码管理器或部署配置中，将原主密钥放入当前终端的同名环境变量，再按变量名传给命令：

   ```bash
   : "${PERPAY_MASTER_KEY:?请先从密码管理器或部署配置中设置原主密钥}"
   export PERPAY_MASTER_KEY
   docker compose --profile maintenance run --rm -e PERPAY_MASTER_KEY maintenance restore BACKUP_NAME SHA256 --confirm-replace-current-database
   ```

   不要把密钥明文写进命令参数或终端历史。漏传环境变量时，工具会改用 secrets 卷里的文件，那可能不是原数据库使用的密钥。

3. 命令成功并输出恢复结果后，再启动并核对原网站、订单、账号和新的成功备份：

   ```sh
   docker compose up -d
   ```

   失败时保持停服，保留输出和恢复前文件，按具体错误处理后再继续。

### 全新服务器恢复

准备 Linux、Docker Compose、age 私钥，以及同一次导出的两份加密文件、`perpay-version.txt` 和 `SHA256SUMS`。这里先按文件记录的版本恢复，避免在抢修时同时升级；成功后再按[日常更新](#固定版本与回滚)使用 `latest`。下面使用独立项目名 `perpay-recovery`，每条 Compose 命令都要保留这个名字。

1. 新建恢复目录：

   ```sh
   mkdir -p perpay-recovery && cd perpay-recovery
   ```

   把导出文件复制进这个目录，下面的命令会读取保存的版本号并下载当时的配置：

   ```sh
   PERPAY_RELEASE="v$(cat perpay-version.txt)"
   curl -fsSLo docker-compose.yml "https://github.com/Mashiro0619/PerPay/releases/download/${PERPAY_RELEASE}/docker-compose.yml"
   sha256sum -c SHA256SUMS
   docker compose -p perpay-recovery --profile maintenance config --images
   ```

   文件检查结果应全部为 `OK`，三个服务列出的镜像版本应与 `perpay-version.txt` 一致。如果旧配置仍写着 `latest`，在这次恢复中先改为记录的版本。早期备份没有版本文件时，从原服务器或部署记录查到版本号后再填写 `PERPAY_RELEASE`。

2. 下载镜像，并检查这次恢复使用的数据卷是空的。下面不会启动 PerPay，也不会生成另一把主密钥：

   ```sh
   docker compose -p perpay-recovery --profile maintenance pull
   docker compose -p perpay-recovery run --rm --no-deps --entrypoint sh app -ceu 'test -w /data; test -w /run/perpay-secrets; test -r /backups; test -z "$(ls -A /data)"; test -z "$(ls -A /run/perpay-secrets)"; test -z "$(ls -A /backups)"; id -u'
   ```

   成功时会显示 `1000`，表示用容器内的运行用户完成了检查，三个目录也都为空。检查失败时，换一个没有使用过的项目名，后续命令一起改用新名字，避免覆盖已有数据。

3. 在 Bash 中导入原主密钥与备份。先按实际文件类型选择主密钥分支，再导入完整备份目录：

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

   确认每条命令都成功退出。原主密钥已经写入 secrets 卷，恢复配置里不要再设置另一份 `PERPAY_MASTER_KEY` 覆盖它。

4. 列出副本，使用目标 `name` 和 `sha256` 恢复：

   ```sh
   docker compose -p perpay-recovery --profile maintenance run --rm --no-deps maintenance list-backups
   docker compose -p perpay-recovery --profile maintenance run --rm --no-deps maintenance restore BACKUP_NAME SHA256 --confirm-replace-current-database
   ```

   工具会检查备份文件、数据库结构版本和原主密钥，并检查恢复结果。看到成功结果后再继续；失败时保留文件和报错输出。

5. 应用仍停止时，查询恢复的实例与数据数量：

   ```sh
   docker compose -p perpay-recovery --profile maintenance run --rm --no-deps --entrypoint node maintenance --input-type=module -e 'import {DatabaseSync} from "node:sqlite"; const db=new DatabaseSync("/data/perpay.sqlite3",{readOnly:true}); try { console.log(JSON.stringify({instance:db.prepare("SELECT value FROM system_metadata WHERE key = ?").get("instance_id"),orders:db.prepare("SELECT count(*) AS count FROM payment_orders").get(),integrity:db.prepare("PRAGMA integrity_check").get()})); } finally { db.close(); }'
   ```

   确认实例编号和订单数量符合预期，完整性检查显示 `integrity_check: "ok"`。如果这次只是试着恢复，到这里就可以结束并记下结果。

6. 准备用新服务器接收付款时，先确认原服务器上的 PerPay 已停止，再按[反向代理部署](reverse-proxy.md)配置域名。可以先在自己的电脑上临时把同一域名指向新服务器，用原来的 HTTPS 地址检查，确认无误后再切换公网 DNS：

   ```sh
   docker compose -p perpay-recovery up -d
   docker compose -p perpay-recovery ps
   docker compose -p perpay-recovery logs --tail=100 app backup
   ```

   用原管理员密码登录，检查网站、订单、支付宝账号和运行状态。确认新备份成功后，再切换公网 DNS，并取消自己电脑上的临时解析。恢复后应能直接使用原管理员；如果旧 IP 白名单拦住了当前地址，按[白名单离线恢复](#管理员-ip-白名单与离线恢复)处理。

<a id="主库损坏时隔离原始文件"></a>

### 数据库损坏时保留原文件再恢复

按[原服务器恢复](#原服务器恢复)确认停服和原主密钥后，若主库被确认损坏（SQLite `CORRUPT`、`NOTADB` 或完整性检查失败）或已变成零字节，沿用与密钥来源匹配的恢复命令，在末尾增加 `--quarantine-unreadable-current`。以下为默认 secrets 卷形式；环境变量方式仍须按上文传入 `-e PERPAY_MASTER_KEY`：

```sh
docker compose --profile maintenance run --rm maintenance restore BACKUP_NAME SHA256 --confirm-replace-current-database --quarantine-unreadable-current
```

添加 `--quarantine-unreadable-current` 前，要确认所有使用数据库的进程都已停止。程序通常会在数据库里记录自己仍在运行；库损坏后，恢复工具可能读不到这条记录，因此需要你手动确认停服。如果还能读到有效占用，工具仍会拒绝恢复。权限不足、磁盘读写失败或数据库正忙，也不能用这个参数跳过。

工具会先检查备份文件、数据库结构版本和原主密钥，再复制当前数据库及 `-wal`、`-shm`、`-journal` 附属文件进行检查。新的恢复文件准备好后，原文件才会移到数据目录下的 `perpay-unreadable-before-restore-…` 文件夹。需要为当前数据库的副本和恢复文件都预留磁盘空间。

成功结果中的 `quarantinedDatabaseName` 是保存原文件的目录名，请完整保留。恢复中断时，原文件可能分散在数据目录和这个目录中，系统会继续阻止应用启动。保留两处文件和维护锁，先查看失败步骤再处理，不能直接删锁或重启应用。

恢复时会提示暂时使用启动配置中的备份间隔和保留份数，这是为了避免读取或改动当前数据库。恢复成功并启动定时备份后，会重新使用数据库里保存的设置。如果备份状态文件也损坏或丢失，确认所选备份后可另加 `--rebuild-state` 重建记录；它与隔离损坏数据库的参数可以一起使用。最后检查后台备份设置，并确认能生成新备份。

<a id="固定版本与回滚"></a>

## 更新与回退版本

默认配置使用 `ghcr.io/mashiro0619/perpay:latest`，跟随稳定版。日常更新沿用这个配置即可，不需要先挑选版本号。

1. 查看[更新说明](releases/README.md)，确认有没有需要先处理的事项。旧版本曾将同一笔付款关联到多个订单时，先完成[历史关联检查](#历史重复收款关联的升级检查)。
2. 用当前程序[生成一份备份](#启用与验证备份)，单独保存原主密钥。
3. 在部署目录下载新镜像、停止旧服务，再启动：

   ```sh
   docker compose pull
   docker compose stop app backup
   docker compose up -d
   docker compose ps
   ```

4. 等待启动完成，打开 **运行状态**，检查查账、通知和备份。旧数据库需要更新结构时，应用会在启动时自动处理。

如果你以前固定过版本，想改为默认的稳定版更新方式，将 `x-perpay-image` 改为 `ghcr.io/mashiro0619/perpay:latest`。没有该项的旧配置，要把 `app`、`backup`、`maintenance` 三个服务的镜像一起修改。

**需要停留在某一版或试用预发布版时，才固定版本。** 从[发布页](https://github.com/Mashiro0619/PerPay/releases)找到完整镜像标签，填写到 `x-perpay-image`，再执行上面的更新命令。三个服务应使用同一标签。

**回退旧版本前，先确认它能读取当前数据库。** 数据库结构版本（schema）用来区分订单、配置等数据在库里的组织方式。旧程序如果不支持当前结构版本，需要同时恢复升级前的备份和原主密钥，不能只更换镜像，也不能手动修改结构版本号。

**备份后已有新交易时，不要直接用旧备份覆盖当前数据库。** 旧备份里没有之后新增的订单、收款和操作记录。先保留当前完整数据及原主密钥，暂停新下单，再用能够读取当前数据库的修复版本处理。

<details>
<summary>从旧版本升级前需要知道的事</summary>

旧沙箱账号只能查看历史，不能再保存收款配置、更换密钥、检查连接、查账或接收新订单。相关流水不再自动对账，订单也不再发送通知。要继续收款，添加已上线且具有对应账号账务查询权限的正式应用，完成连接检查后，把业务网站改为使用新账号。原订单、流水、通知和归属仍保留，详见[接入调整](releases/v1.0.0-rc.1.md#接入调整)。

1.0.0 的数据库结构版本为 44，兼容的结构版本为 24—44。旧数据库在启动时自动升级。从 RC4 的结构版本 42 升级时，会完成两次更新；已经使用结构版本 44 的开发构建无需再次更新结构。具体变化见[1.0.0 版本说明](releases/v1.0.0.md)。

其他旧版的操作差异可按原版本查阅：[RC4 易支付接入](releases/v1.0.0-rc.4.md)、[RC3 升级前备份](releases/v1.0.0-rc.3.md)、[RC2 审计与客户端 ID](releases/v1.0.0-rc.2.md)、[RC1 多账号与正式应用](releases/v1.0.0-rc.1.md)、[多网站设置](releases/v1.0.0-alpha.1.md)和[退款标记与旧接口](releases/v0.2.2.md)。

使用数据库结构版本 37 的旧程序，如果曾因删除账号造成关联损坏，新版会拒绝启动。先保留当前数据，再按[RC1 恢复说明](releases/v1.0.0-rc.1.md#升级与恢复)恢复删除前检查通过的备份和原主密钥，然后升级。

</details>

<a id="历史重复收款关联的升级检查"></a>

## 升级前检查重复确认的付款

同一笔支付宝付款不能同时当作两张订单的收款。旧版本更换 App ID 后，如果把再次查到的同一笔流水认给了另一张订单，新版在启动、备份或恢复时会发现重复关联并拒绝继续。升级前需要先把错误关联纠正。

升级前保留原版本及已验证备份，并完成以下检查：

1. 暂停业务网站接收新订单，在原版本的 **对账 → 支付宝流水** 中将“关联状态”筛选为“多笔关联”。检查每笔流水的全部生效关联，核对支付宝实际收款，以及业务网站是否已发货、充值或开通服务。
2. 确认哪条关联有误后，在原版本后台点击该记录的“撤销关联”。对应订单会变为“收款有争议”，并按网站配置发送争议通知（`PAYMENT_DISPUTED`）。业务网站还要处理已经完成的充值、发货等操作。
3. 再次检查多笔关联结果，给纠正后的数据库做一份新备份，并单独保存主密钥，然后升级。仍含重复关联的旧备份不能通过新版检查，保存时注明它来自哪个版本、留作什么用途。

如果已经升级，程序因数据检查失败而无法启动，先停服并限制访问，再用能够读取当前数据库的原版本完成上述核对。不要直接改数据库或关闭检查，也不要在没有核对付款和业务结果之前批量撤销订单。

## 预发布版本与更新通道

默认安装的 `latest` 跟随稳定版。后台更新提示也可以包含预发布版，在 **运行状态 → 官方更新** 选择：

| 检查范围 | 会提示什么 |
| --- | --- |
| 仅稳定版 | 已正式发布的新版本，适合日常使用。 |
| 包含预发布版（当前默认） | 同时查看正式版和预发布版，提示其中版本号最高的一个。 |

普通使用可以选“仅稳定版”。版本按编号比较，例如同一版本的 `rc.10` 比 `rc.2` 新，正式版又比该版本的所有预发布版新；更高版本号的预发布版也可能被提示。看到提示后，先阅读更新说明，再决定是否安装。

自动检查默认开启：登录后会检查一次，页面打开且联网时每 6 小时检查。切到后台或断网时暂停，回来后补查。关闭自动检查仍可手动检查；手动检查成功后至少等 60 秒再查。程序可能使用 5 分钟内的检查结果，遇到 GitHub 限流时按页面提示等待。

发现新版本后，会显示版本号、更新说明和安装方法，侧栏“运行状态”也会出现提醒。同一浏览器对同一版本只自动弹出一次；正在编辑或有其他弹窗时，会等这些操作结束。点击“查看更新”可以重新打开。

点击“知道了”、关闭按钮或按 Esc，都会关闭弹窗。“忽略此版本”会隐藏当前检查范围内这个版本及更早版本的提醒，新版本仍会提示；点击“恢复此通道更新提醒”可以撤销忽略。设置保存在当前浏览器，同一地址的其他标签页会同步；浏览器禁止保存数据时，关闭页面后这些设置就不会保留。

更新提示不会自动安装程序。稳定版继续按[日常更新](#固定版本与回滚)使用 `latest`；想安装预发布版时，再把 `x-perpay-image` 改为该版本的完整标签，并确保三个服务一致。检查失败时，页面会说明当前无法取得版本信息。

<details>
<summary>怎么看版本号</summary>

正式版写作 `X.Y.Z`；带 `alpha`、`beta`、`rc` 等后缀的是预发布版，例如 `X.Y.Z-rc.N`。GitHub 下载标签前面还有一个 `v`，镜像标签则没有。

`latest` 只跟随稳定版，安装预发布版需要填写完整标签。不同程序支持的数据库结构版本可能不同，所以回退前仍要检查版本说明。

</details>

<a id="采集持续失败"></a>

## 查账持续失败

先打开 **运行状态**，看是最近账单的正常查询失败，还是补查历史账单失败。记下错误码、查询时间范围、最近失败时间和下一次尝试时间。同一账号连续失败 3 次会显示“查账持续失败”；历史补查失败时，正常查账仍可能继续，是否能收新单看页面上的收款状态。

| 原因 | 处理步骤 |
| --- | --- |
| 网络或超时 | 检查宿主到支付宝的网络和代理配置，再观察重试结果。 |
| 应用身份、签名或权限 | 核对应用上线状态、当前密钥和账务明细查询权限，按[支付宝配置](alipay-setup.md)修正。 |
| 支付宝限制请求频率 | 等到页面显示的下一次尝试时间，不通过重启或调短间隔反复请求。 |
| 返回格式异常、流水编号重复、账单时间超出查询范围 | 保存失败的时间范围和原始响应，检查支付宝接口是否变化、程序是否需要更新。原文放在私有位置，不公开账单、密钥或完整数据库。 |

需要重查时，点击 **运行状态 → 查账 → 手动查账**。如果这个账号已经在查账，会使用现有任务；否则会在允许的时间开始。页面会显示等待、执行和结果。刷新“运行状态”只是查看进度，不会额外发起查询；重启服务或改过配置后，要重新查看结果。

**不要手改数据库、重置查询进度或跳过失败的账单页，这会造成漏账。** 手动查账也要检查支付宝签名、账单时间和数据是否完整，点击查询本身不等于收款已经确认。账号尚未配置、任务不可用或处于只读演示时，不能发起查询。

重新收到有效账单后，当前失败提醒会清除，历史记录仍保留。下一次尝试时间能确定时才会显示；如果任务已停止或配置正在切换，先处理页面上的具体原因。确认需要更新程序时，按[更新步骤](#固定版本与回滚)操作。

<a id="采集最小间隔"></a>

## 查账最小间隔

在 **系统设置 → 查账设置** 调整一次查账结束后，至少等多久才能开始下一次。单位是秒，须满足 **5 ≤ 最小间隔 ≤ 活跃间隔 ≤ 常规间隔 ≤ 3600**。新安装默认最短等 8 秒，升级会保留原设置。

自动和手动查账共用这个限制。遇到支付宝限流或查询失败，实际等待可能更长；改设置或重启服务不会清除已经安排的等待。浏览器刷新付款状态的间隔另行计算。

通过 API 修改时，调用 `PUT /api/admin/v1/settings/collection-policy`，带上刚读取到的 `revision`（配置版本号）和完整设置，不能只传要修改的一个字段。参数见[查账节奏](../USAGE.md#查账节奏)。

## 收银台手动核实

收银台约每 2.5 秒读取一次 PerPay 已记录的付款结果。点击“查询付款状态”后，还会等待或请求一次支付宝查账，再核对流水和订单。这个过程仍要遵守查账最小间隔。

同一收款账号被多人连续点击时，会共用已有的查账任务；已经结束的订单只查看现有结果。按钮最多等待 30 秒，之后页面继续自动刷新，已经开始的后台查询也会继续。

支付宝可能还没返回刚发生的付款，因此查完后仍需要等待。查账、对账失败或配置正在切换时，会显示核实未完成。服务重启后，页面可能无法继续显示刚才的查询进度，但已经保存的订单和付款结果仍然保留。

<a id="数据库空间与压实"></a>

## 查看占用并缩小数据库文件

数据库除了订单，还保存支付宝返回的账单原文和查询记录。程序每小时分批清理超过 7 天、符合条件的空结果和重复副本，日志 `ingest_history_pruned` 会显示清理数量。首次入账、异常、各账号最近一次查询，以及其他记录仍在使用的证据会继续保留。

先查看数据库文件、WAL 写入日志、可以复用的空间，以及哪些表占用最多：

```sh
docker compose run --rm --no-deps --entrypoint node maintenance dist/database/maintenance.js inspect-storage
```

`usedBytes` 是数据和索引已经分配的空间，`reclaimableBytes` 是可以再次使用的空闲空间，`tables` 列出各表的行数和大小。如果 SQLite 没有提供按表统计的能力，大小会显示为 `null`。

删除旧记录后，SQLite 通常会把空位留给后续数据使用，文件不会立即变小。“压实”就是重新整理这些空位，缩小文件；新备份在空间足够时会自动这样处理。要缩小正在使用的数据库，先完成[备份](#启用与验证备份)，等待旧记录清理结束，并在数据卷准备约两倍数据库大小的额外空间，然后停服：

```sh
docker compose stop app backup
```

使用默认 secrets 卷时执行：

```sh
docker compose run --rm --no-deps --entrypoint node maintenance dist/database/maintenance.js compact-database --confirm-stopped-services
```

应用通过环境变量设置主密钥时，按[原服务器恢复](#原服务器恢复)的方式，从密码管理器或部署配置中取得原值，改用：

```bash
: "${PERPAY_MASTER_KEY:?请先从密码管理器或部署配置中设置原主密钥}"
export PERPAY_MASTER_KEY
docker compose run --rm --no-deps -e PERPAY_MASTER_KEY --entrypoint node maintenance dist/database/maintenance.js compact-database --confirm-stopped-services
```

命令会检查原主密钥、数据库和剩余空间，在数据卷中整理文件，完成后显示处理前后的大小及释放了多少空间。确认成功后再启动：

```sh
docker compose up -d app backup
```

失败时保持停服，按输出排查；主密钥沿用现有 secrets 卷或 `PERPAY_MASTER_KEY`。

清理后的历史查询仍保留响应摘要。如果再次查询同一时间段时结果变了，程序会先重新确认，再将变化记入流水；确认进度会随数据库保留。

## 忘记管理员密码

在 PerPay 服务器的部署目录执行，沿用当前应用的镜像。先停止应用和备份：

```sh
docker compose stop app backup
docker compose --profile maintenance run --rm --no-deps --entrypoint node maintenance dist/identity/recover.js --confirm-reset-admin-password
```

按提示输入新密码两次（不回显）。密码至少 6 个字符；成功后再执行 `docker compose up -d`。

成功后会设置新密码、退出所有旧登录，并留下操作记录，订单、配置和密钥保持不变。不要为重设密码删除数据卷。若提示数据库被占用或维护锁未释放，先确认相关进程已停止，再按[清理遗留维护锁](#清理遗留维护锁)处理。

源码部署：停掉服务后，将 `PERPAY_DATA_DIR` 指向原数据目录，运行 `node dist/identity/recover.js --confirm-reset-admin-password`。自动化可加 `--password-stdin`，从标准输入传一行 UTF-8 密码；不要把密码写在命令参数、环境变量或 shell 历史中。

## 管理员 IP 白名单与离线恢复

在 **系统设置 → 密钥与安全 → 管理员 IP 白名单** 管理规则。默认关闭；启用时须包含“当前识别 IP”，保存立即生效。先按[反向代理部署](reverse-proxy.md)核对可信代理，再启用白名单。

可以填写单个 IPv4、IPv6 地址或 CIDR 网段，最多 100 条，合计 8192 字节（含换行）；不能填域名、端口或允许全网的 `/0`。白名单限制后台页面和管理 API，允许的地址仍须密码登录。付款接口和健康检查不受它影响。

保存发生版本冲突时，点击“重新读取配置”核对服务器内容与草稿；双方都修改规则时，选择保留哪份后再保存。动态公网 IP 变化或恢复旧备份中的白名单后，可能需要离线关闭规则。

如果已经无法进入后台，在服务器上沿用当前应用的维护镜像，停服后关闭白名单：

```sh
docker compose stop app backup
docker compose --profile maintenance run --rm --no-deps --entrypoint node maintenance dist/identity/disable-admin-allowlist.js --confirm-disable-admin-allowlist
```

成功后执行 `docker compose up -d app backup`，重新登录并修正规则。命令关闭白名单、保留原规则并记录审计，密码、会话和支付数据保持原值。

提示数据库被占用或维护锁未释放时，保持停服，按[锁处理步骤](#清理遗留维护锁)核对。源码部署也先停服，把 `PERPAY_DATA_DIR` 指向原目录，再执行 `node dist/identity/disable-admin-allowlist.js --confirm-disable-admin-allowlist`。这些恢复工具不会自动更新数据库结构，要沿用当前程序的版本。

## 清理遗留维护锁

“锁”是一份正在备份或维护的标记，用来防止两个操作同时改数据。如果上一次操作突然退出，这个标记可能留下来。先停止应用、备份，以及另行启动的维护容器和程序；下面这条命令只停止 `app` 和 `backup`：

```sh
docker compose stop app backup
```

数据库还保存程序的占用记录，称为“租约”。正常应用停止更新这条记录后，通常 30 秒内到期；维护或恢复的占用记录可能保留 24 小时。到期不会自动删除锁文件，仍要按报错中的文件位置选择工具：

| 锁 | 位置 | 清理条件 |
| --- | --- | --- |
| 备份任务锁 | 备份目录 `perpay-local-backup.lock` | 没有备份进程运行，锁超过 7 小时，工具也确认可以清理。 |
| 数据库维护锁 | 数据目录 `perpay.sqlite3.maintenance-lock` | 维护进程已结束，数据库中的占用检查通过。 |
| 备份发布锁 | 备份目录 `.perpay-source-publication.maintenance-lock` | 没有维护进程运行，锁超过 7 小时，工具也确认可以清理。 |

### 备份任务锁

检查备份任务锁：

```sh
docker compose --profile maintenance run --rm maintenance inspect-lock
```

只有确认没有备份进程运行，且返回 `status: "stale"`、`cleanup_eligible: true` 时，才使用返回的 `record.token` 清理：

```sh
docker compose --profile maintenance run --rm maintenance clear-lock BACKUP_LOCK_TOKEN --confirm-no-backup-process
```

如果锁文件无法读取，先检查文件是否存在、权限是否正确。只有确认文件损坏、备份进程已经结束、文件也超过 7 小时后，才在同一命令里用 `--force-unreadable-lock` 替代 token。不要直接删除锁来打断仍在运行的备份。

### 数据库维护锁

数据库维护锁会阻止应用启动或恢复数据库。下面直接调用数据库维护工具查看它：

```sh
docker compose --profile maintenance run --rm --no-deps --entrypoint node maintenance dist/database/maintenance.js inspect-maintenance-lock
```

查看返回的 `operation`（操作类型）和 `createdAt`（开始时间），确认对应程序已结束，再把返回的 `token` 填入清理命令。这个 token 用来确认清理的是刚才查看的同一份锁：

```sh
# 用 inspect-maintenance-lock 返回的 token 替换 DATABASE_LOCK_TOKEN。
docker compose --profile maintenance run --rm --no-deps --entrypoint node maintenance dist/database/maintenance.js clear-stale-maintenance-lock DATABASE_LOCK_TOKEN --confirm-no-maintenance-process
```

工具会检查数据库是否仍被占用。这里的“超过 7 小时”只是提示锁已经很旧，不代表可以强行删除。特殊情况按报错处理：

- `maintenance lease is still live`：表示维护程序的占用记录还有效。确认程序确实已经退出，核对中断的操作、备份和数据库后，才可加 `--force-abandon-maintenance-lease` 放弃这条占用记录；应用仍在运行时，这个参数也不能清锁。
- 首次恢复到空目录中断，数据库与临时恢复文件仍通过硬链接指向同一份数据：保留备份和临时文件，使用 `--finalize-interrupted-fresh-restore` 完成收尾。工具会检查恢复记录、文件关系和数据完整性；不要与其他强制参数一起使用。
- 锁文件损坏：确认程序已退出、路径和权限正确后，才用 `--force-unreadable-lock` 替代 token。数据库仍被有效占用时，工具会继续拒绝。

### 备份发布锁

备份发布锁用于保护备份文件和清单的写入，放在 `PERPAY_BACKUP_DIR` 下。下面检查的是这一份锁，返回 `missing` 表示它不存在，其他锁仍需按各自位置检查：

```sh
docker compose --profile maintenance run --rm maintenance inspect-publication-lock
```

确认没有维护进程运行、锁超过 7 小时，并且返回 `status: "stale"`、`cleanup_eligible: true` 后，使用 `record.token` 清理：

```sh
# 用返回的 record.token 替换 PUBLICATION_LOCK_TOKEN。
docker compose --profile maintenance run --rm maintenance clear-stale-publication-lock PUBLICATION_LOCK_TOKEN --confirm-no-maintenance-process
```

无法读取锁文件时，工具不会直接允许清理。只有确认程序已退出、锁文件确实损坏且超过 7 小时，才用 `--force-unreadable-lock` 替代 token。

清理后回到原来的维护步骤，重新执行失败操作，或确认恢复已经完成。数据库和备份状态正常后再启动服务，不要手动修改占用记录或锁文件内容。

## 后台详情与配置编辑

在列表中点击记录可以看详情，点击设置项可以编辑。手机上弹窗正文可以滚动，标题和操作按钮留在弹窗内。复制完整页面地址会保留筛选条件和正在查看的记录，方便下次继续查看。

保存时提示配置已被修改，先重新读取并核对。请求超时或没有明确结果时，先查看服务器上的实际状态，再决定是否重试；关闭页面不会取消已经发出的请求。删除账号或网站后，也要确认服务器已经返回成功。

报告界面问题时，提供页面地址、版本、浏览器和报错内容，先去掉密钥等敏感信息。界面操作规则见[前端说明](../web/README.md#后台交互约束)，需要用示例数据重现问题时，可以打开[本地预览](development/ui-verification.md#本地预览)。

## 审计日志与采集状态

在全局 **审计日志**（`/admin/audit`）查看谁做了什么、后台任务是否成功。这里有两类记录：“核心审计”保存收款确认、配置修改等重要操作；“活动记录”保存接口请求和后台任务的执行情况。

1. 按发生日期、来源、类别、动作、结果、操作者、网站、IP 或关键词筛选。日期按北京时间处理，列表按发生时间倒序，每页默认 20 条、最多 100 条。
2. 打开详情，查看关联的订单、字段修改和执行记录。可以用请求 ID 搜索，一次请求可能留下多条记录。“未关联网站”表示这次操作当时没有记录所属网站。
3. 导出时，所选范围不能超过 366 天和 10,000 条。超限会报错，不会悄悄少导出一部分。CSV 包含页面中可见的 IP、客户端信息和字段变化，下载后要妥善保管。
4. 如果采集状态提示写入失败、记录被丢弃或有缺失，检查数据卷和备份卷的空间、权限，以及应用和备份日志。修复后，确认最近写入或读取的时间又开始更新。

核心审计长期保留，接口和任务活动保留 30 天。活动记录会分批写入，普通查询和没有变化的任务会合并统计。进程异常退出时，尚未写入的活动可能丢失，可以再查看相关订单、核心审计和运行日志。完整规则见[数据收集与保留](privacy.md)。

备份和维护程序先把记录写到 `PERPAY_BACKUP_DIR/perpay-activity/v1`，主程序再读入审计日志。这些文件保留 30 天；如果超过保留时间还没被读入，会提示 `source_retention_gap`，表示有一段记录缺失。异地保存时复制完整备份目录，让还没读入的记录一并保留。恢复时使用同一套 PerPay 的文件，不要手改序号或记录来补写“成功”。

<details>
<summary>管理 API 与记录规则</summary>

| 接口 | 用途 |
| --- | --- |
| `GET /api/admin/v1/audit-events` | 查询两类记录，返回获取下一页所需的游标和本次查询时间。 |
| `GET /api/admin/v1/audit-events/meta` | 查询动作、历史网站、采集状态和保留规则。 |
| `GET /api/admin/v1/audit-events/{source}/{event_id}` | 查看详情、字段变化、记录校验值和相关记录；`source` 为 `core` 或 `activity`。 |
| `POST /api/admin/v1/audit-events/export` | 按筛选生成 CSV，需要有效的管理会话、请求来源和 CSRF 信息。 |

这些接口需要管理员登录，并遵守管理员 IP 白名单。连续翻页时以第一次查询时已有的记录为准，刷新后才重新读取最新内容。生成 CSV 后会记一条 `audit.export_generated`，保存筛选条件摘要、搜索摘要和条数，不保存整份 CSV。

程序把重要操作前后的校验值串联保存，在启动和数据检查时核对。旧记录不会补填当时没有采集的信息。密钥等机密字段只记录发生过变化；较长的普通字段会标明内容已缩略，并保留原大小和摘要。页面和 CSV 都保留这些说明。重要业务变更与对应审计会一起保存。

</details>
