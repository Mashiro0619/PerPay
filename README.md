<!-- SPDX-License-Identifier: Apache-2.0 -->

# PerPay

PerPay 是面向个人开发者的开源、自托管经营码收款系统。目前只完成新工程底座：配置校验、SQLite 自动迁移、健康检查和容器部署已经建立，订单、账务采集、匹配、通知和管理页面尚未实现。

> 当前版本不能处理真实资金，也不应部署到公网。

本项目是独立开源项目，不由支付平台运营、维护或背书。接口权限、账户政策、备案、法律与税务要求可能变化，使用者必须自行核验。

## 部署

部署主路径只有一条：编辑根目录 [docker-compose.yml](docker-compose.yml)，至少修改管理员密码和宿主端口，然后执行：

```bash
docker compose up -d
```

镜像构建、配置校验、数据库初始化与迁移、健康检查、持久卷和异常重启均由 Compose 与应用自动处理。项目只支持 Linux 主机与 Linux 容器。

查看状态：

```bash
docker compose ps
docker compose logs app
```

停止服务但保留数据：

```bash
docker compose down
```

不要对生产环境执行 `docker compose down --volumes`，它会删除持久数据卷。

## 技术基线

- Node.js 24 LTS
- Hono 4
- TypeScript 6
- Node 内置 `node:sqlite`
- 单应用容器、单 SQLite 数据卷

`node:sqlite` 在当前 Node 24 中仍为 Stability 1.2。项目固定 Node 小版本，并以迁移、事务、备份恢复和升级兼容测试作为发布门禁。

SQLite 只支持一个应用容器写入，不支持扩容多个副本或共享网络文件系统。生产连接使用 WAL、`synchronous=FULL`、外键、busy timeout 和 defensive mode。

目前已实现强制 PRAGMA 读回、单实例租约、迁移 checksum、轻量 readiness、在线备份的临时文件写入、独立完整性验证、SHA-256 和原子发布。完整的恢复命令与定期备份调度仍未开放。

前端暂缓开发，等待零构建 CSS/JavaScript UI 库接入。

## 更新策略

正式版本采用带版本号和不可变摘要的多架构镜像。应用会记录当前应用版本与数据库 schema 兼容范围，拒绝用不兼容的旧镜像直接启动新数据库。

当前代码已经实现签名更新清单的纯校验核心：只接受受信 Ed25519 公钥、规范 JSON、合法版本范围、目标架构、固定镜像摘要、可达 schema 迁移链和足够磁盘空间。它不会自行访问 Docker Socket 或替换容器。

更新系统遵循以下规则：

- 后台检查新版本和安全公告，但默认不静默安装。
- 升级前自动完成配置预检和可恢复的 SQLite 在线备份。
- 数据库迁移只前向追加，并在新容器通过 `/readyz` 后才视为升级成功。
- 失败时保留旧镜像和升级前备份；涉及不向后兼容的 schema 时，通过恢复备份回退，而不是让旧程序打开新库。
- 更新检查、升级、迁移、恢复和回滚均写入审计记录。

根目录仍只保留一份用户配置文件。正式发布前会提供基于同一 `docker-compose.yml` 的受控升级命令和恢复演练；当前底座尚未开放真实升级操作。

## 开发

贡献者需要 Node.js 24 和 npm：

```bash
npm ci
npm run check
```

健康探针：

- `GET /livez`：进程存活。
- `GET /readyz`：数据库迁移完成且可访问。

开发流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。
