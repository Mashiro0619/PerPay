# 发布维护指南

普通部署者不需要执行本页步骤。他们只需从 GitHub Release 下载附带的 `docker-compose.yml`，填写其中的配置，然后运行 `docker compose up -d`。本页只面向正式版本维护者。

## 发布边界

- 每个正式版本发布不可变的 `X.Y.Z` 标签，并把 `latest` 更新到同一份多架构镜像。
- 工作流只使用 GitHub 自动提供的 `GITHUB_TOKEN`。仓库必须允许该令牌写入 GHCR package 和创建 GitHub Release；不需要额外的发布 secret。
- 支持的镜像平台为 `linux/amd64` 和 `linux/arm64`。
- 应用不会访问 Docker Socket、修改自己的镜像引用或自动替换用户容器。升级和回滚由部署者根据 Release 说明执行。
- 默认 Compose 使用 `latest` 简化更新；固定版本标签和 OCI digest 用于审计、复现和手动回滚。

## 首次 GHCR 发布

GHCR package 首次由工作流推送时通常是私有的，而正式版本必须能够被部署者匿名拉取。因此首次发布分两步完成：

1. 正常推送 `vX.Y.Z` Git 标签。工作流会构建并推送两个平台的无业务标签镜像 digest，从而创建 GHCR package；它不会在 package 尚不可匿名读取时创建正式版本标签。
2. 维护者在 GitHub package 设置中将该 package 改为 `Public`，然后重新运行同一次 Release workflow。工作流会重新检查标签占用和镜像内容，再继续创建正式版本标签。

不需要手工推送任何占位镜像，也不要手工创建或覆盖同名容器版本标签。为缩小标签竞争面，应只允许正式发布工作流和必要的维护者拥有该 package 的写权限。

## 准备版本

1. 同步更新以下版本位置：

   - `package.json`
   - `package-lock.json`
   - `src/version.ts`
   - `Dockerfile`
   - `docker-compose.yml` 中 `app`、`backup` 与 `maintenance` 的三处镜像引用仍为同一个 `latest`

   数据库兼容范围只在 `src/version.ts` 维护。

2. 新建或更新 `docs/releases/vX.Y.Z.md`。该文件必须准确说明 schema 迁移、升级与回滚风险，以及 Compose、环境变量、卷、端口、健康检查和容器安全约束的变化。

3. 在发布提交上执行本地门禁：

   ```text
   npm ci --ignore-scripts
   npm run check
   npm audit --audit-level=high
   ```

4. 将版本提交合入 `main`。创建并推送与 `package.json` 完全一致的 `vX.Y.Z` 标签，例如版本 `0.1.0` 对应 `v0.1.0`。

工作流只接受不带预发布或构建后缀的 `vX.Y.Z`。标签解析到的提交必须仍可从 `main` 到达，远程标签必须解析到工作流实际检出的同一提交。工作流不要求某一种 Git 标签对象或签名形式，因此维护者不能把仓库自身的标签权限纪律误写成流水线已强制执行的保证。

一次只推送一个正式版本标签，并等待该 Release workflow 完成后再推送下一个；GitHub concurrency 只保留一个等待中的任务，连续推送多个标签可能替换尚未开始的中间任务。

## 正式发布流水线

推送版本标签后，`.github/workflows/release.yml` 按以下顺序执行：

1. 校验 Git 标签、`package.json`、lockfile、源码版本、Dockerfile、根 Compose、数据库兼容范围和版本说明相互一致。
2. 确认发布提交属于 `main` 历史，并在该提交上重新运行类型检查、全量测试、构建和高危依赖审计。
3. 使用固定版本的 QEMU、Buildx 和 BuildKit，分别构建 `linux/amd64` 与 `linux/arm64`。新构建先以无业务标签 digest 推送，不提前占用正式版本标签。
4. 分别用 Trivy 扫描两个平台镜像的操作系统和应用依赖；发现 `HIGH` 或 `CRITICAL` 漏洞时停止发布。
5. 再次检查远程 Git 标签与 GHCR 版本标签。首次发布只有匿名查询明确返回“版本标签不存在”时，才把两个已扫描的平台 digest 组成 `X.Y.Z` 多架构镜像；重跑时仍会从当前 checkout 重新构建并扫描两个平台，只有既有版本标签的两个平台 digest 与本次构建逐一相同才允许复用。
6. 匿名读取正式版本标签，复核顶层 digest、两个平台、OCI 版本标签和源提交标签。
7. 从根 Compose 生成使用 `latest` 的 Release 附件；附件通过 `docker compose config --quiet` 和三服务镜像一致性检查。
8. 在 GitHub 托管的 Linux runner 上使用固定版本 digest 实际验证应用健康、付款未就绪状态、非 root 与只读容器约束、SQLite 备份、备份列表、数据库恢复、容器重建和两个命名卷的持久化。
9. 只有完整验收通过后，才把 `latest` 更新到同一组平台 digest；流水线拒绝将 `latest` 移到更旧版本，或移到同版本的不同 digest。
10. 最后创建 GitHub Release，附加 `docker-compose.yml`，在说明中记录固定版本、镜像 digest、`latest` 更新、支持平台、数据库 schema 范围和 Compose SHA-256。

两个平台镜像都会被构建、元数据校验和漏洞扫描。Compose 功能验收运行在 GitHub 托管 Linux runner 的原生架构上；这不等于实际执行了 `arm64` 容器。首次宣称某个架构可用前，仍应在对应的干净 Linux 主机完成一次真实部署验收。

`.github/workflows/container-validation.yml` 提供手工触发的单架构容器验收。普通 PR 和 `main` 推送的 CI 只执行 Node 检查与依赖审计，不重复消耗 Docker 构建和恢复演练资源。

## 失败与重跑

- 正式版本标签尚未创建时可以重跑同一次 workflow。工作流会重新构建平台 digest，并在写正式标签前重新检查匿名可读性和标签占用。
- 正式版本标签已经存在时，工作流不会主动重写它。它会先重新构建当前 checkout；只有既有标签的 `linux/amd64`、`linux/arm64` 平台 digest 与本次构建逐一相同，才会复用并继续发布；任一不一致都会失败关闭。
- 正式镜像已经创建但后续 Compose 验收或 Release 创建失败时，可以重跑。若失败来自镜像本身，必须修复代码并发布新的补丁版本，不能用相同版本重打镜像。
- `latest` promotion 使用全局串行锁和单调版本门禁：当前版本更高，或同版本 digest 不同，都会拒绝发布。
- 同名 GitHub Release 已存在时，创建命令会失败，不会主动改写既有 Release 或附件。维护者应先核对现有 Release 是否已完整发布，再决定后续处理。

## 标签并发与不可变性边界

GHCR 没有被本流程依赖的原子 create-if-absent/CAS 标签写入。在“确认 `X.Y.Z` 不存在”与“创建 `X.Y.Z`”之间，外部 package writer 理论上仍可抢占或移动该标签。全局 workflow 并发组只能串行化本发布流程，不能约束工作流之外的写入者。

因此，本项目对“版本标签不移动”的保证依赖以下共同约束：

- package 写权限保持最小且不被其他自动化共用；
- 观察到既有正式标签时，发布工作流拒绝主动覆盖；
- 已公布版本不得删除、重打或移动，修复必须使用新版本；
- 部署、审计和回滚始终以 Release 公布的 OCI digest 为权威，而不是单独信任可变标签。

Git 标签与 GitHub Release 同样是仓库权限控制的名称和记录，不是 OCI 内容寻址对象。工作流会在关键写入前重复核对 Git 标签，但无法把外部写权限变成 registry 或 GitHub API 的原子锁。

## 发布后验证

1. 在没有 GHCR 登录状态的干净 Linux 主机下载 Release 附件，并使用 Release 说明中的 SHA-256 校验 `docker-compose.yml`。
2. 确认三处 `image:` 完全相同且均为官方 `latest`；同时记录 Release 给出的固定版本和顶层 digest。
3. 填写配置，运行：

   ```text
   docker compose config --quiet
   docker compose pull
   docker compose up -d
   ```

4. 核对实际镜像 digest、容器 UID、只读根文件系统、`/healthz`、`/readyz`、备份健康、备份列表、恢复流程和容器重建后的双卷持久化。
5. 分别在受支持的干净 `linux/amd64` 与 `linux/arm64` 环境至少完成一次真实部署验收，并保存 workflow、digest、扫描结果和恢复演练记录。

OCI digest 一经公布即为固定版本的字节权威。`latest` 可以随新 Release 移动；需要修复时发布新的补丁版本，不得重打同版本镜像，也不得删除仍受支持版本的 Compose、版本说明或恢复资料。
