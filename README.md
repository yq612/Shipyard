# Shipyard

在浏览器里完成「选国家 → 选环境 → 确认执行计划 → 执行 → 完成」的构建与发布。旧版 CLI（Ease-Deploy 终端工具）的流水线原样复用，改为由服务端统一执行：过程能实时看（进度 + 日志），事后能追溯（发布记录、当时的执行参数、发布的提交号）。

方案背景见 [docs/web-migration-research.md](docs/web-migration-research.md)，界面使用 [磷光 Phosphor 设计体系](docs/design/README.md)。

## 结构

```
packages/shared   前后端共用：类型、ProgressEvent、reduceProgress、接口契约（不依赖 node:*）
apps/server       Bun + Hono：REST + SSE、调度器、环境锁、SQLite、日志、飞书通知
  src/core          流水线：git / builder / deployer / pipeline / notify / config（由旧 CLI 迁移）
  src/service       DeploymentService、Scheduler
  src/store         SQLite（bun:sqlite）与日志文件
  src/http          路由、IP 白名单、Origin / Host 校验、SSE
apps/web          Vite + React + TanStack Query，托管在 server 上，同源访问
data/             运行时数据（不进 git）：config.yaml、ssh/deploy.pem、shipyard.db、logs/
```

## 本地开发

依赖：[Bun](https://bun.sh) 1.3+、git、tar。

```bash
bun install
mkdir -p data/ssh
cp config.example.yaml data/config.yaml     # 按需修改
cp /path/to/deploy.pem data/ssh/deploy.pem && chmod 600 data/ssh/deploy.pem
bun run dev                                  # API :8080 + Vite :5173
```

打开 http://localhost:5173 。`127.0.0.1` 默认在白名单里，本机可以直接发布。

想在本地看构建后的效果（一个端口同时提供 API 和页面）：`bun run build && bun run start`，打开 http://localhost:8080 。这只用于本地预览，不是部署方式。

## 部署

生产环境只用 [compose.yaml](compose.yaml) 部署：`shipyard` 只监听本机 8080，前面的 `caddy` 占用 80 / 443，自动申请并续签 Let's Encrypt 证书。服务器需要 Docker（带 compose 插件）和 git，不需要装 Bun；域名要先解析到服务器，80 / 443 要对全网开放（证书验证从 Let's Encrypt 的多个地点发起，不能只放行自己的 IP）。

**首次部署**

```bash
git clone <本仓库> shipyard && cd shipyard
echo 'SHIPYARD_DOMAIN=deploy.example.com' > .env
mkdir -p data/ssh
cp config.example.yaml data/config.yaml     # 按需修改，access 按下文「网络」填
cp /path/to/deploy.pem data/ssh/deploy.pem && chmod 600 data/ssh/deploy.pem
docker compose up -d --build --wait
```

**升级**

```bash
deploy/upgrade.sh
```

脚本做的事：`git pull`，重建并等新容器通过健康检查，Caddyfile 有变化时让 Caddy 重新加载，清理旧镜像。旧容器收到 SIGTERM 后不再接受新发布，等执行中的环境跑完（最多 10 分钟）再退出，新容器随后启动；这期间 Caddy 会让请求等后端起来，最多 30 秒，更久才返回 502。服务日志用 `docker compose logs -f shipyard` 查看，证书申请和续签看 `docker compose logs caddy`。

Caddy 镜像不会跟着升级，要升级时 `docker compose pull caddy && docker compose up -d caddy`。

回滚：`git checkout <提交号> && docker compose up -d --build --wait`，修好后 `git checkout main` 再执行升级脚本。数据库迁移只会往前加，如果中间的版本改过表结构，先按下文备份。

**数据**

运行时数据全在仓库根目录的 `data/` 里：`config.yaml`、`ssh/deploy.pem`、`shipyard.db`、`logs/`；域名在 `.env`；证书在 `caddy-data` 卷里。这些都不进 git，也不进镜像，重建容器、升级都不会动它们；数据库表结构靠启动时的增量迁移升级，不会重建。所以：

- 服务器特有的值只写在 `.env` 和 `data/` 里，不要改 `compose.yaml` / `Caddyfile`，否则 `git pull` 会冲突。
- 不要用 `rsync` / `scp` 整目录同步代码，会把本地的 `data/` 带过去。更新只用 `git pull`。
- 不要在服务器上执行 `git clean -x`，会删掉 `data/` 和 `.env`。
- 不要 `docker compose down -v`，会删掉证书卷；反复重新申请会撞上 Let's Encrypt 的频率限制（同一域名每周 5 张）。
- 备份：`docker compose stop shipyard`，打包整个 `data/`，再 `docker compose start shipyard`。数据库开了 WAL，运行中只拷 `shipyard.db` 一个文件会丢最近的写入。

**网络**

两个服务都用 `network_mode: host`：`shipyard` 看到的来源地址就是 Caddy 的 `127.0.0.1`，真实 IP 由 Caddy 写进 X-Forwarded-For。不要改成 `ports:` 端口映射，否则请求会变成 Docker 网关地址（如 `172.18.0.1`），白名单失效。[deploy/caddy/Caddyfile](deploy/caddy/Caddyfile) 的默认行为正好满足服务端的要求：X-Forwarded-For 用真实来源覆盖（不信任客户端自带的）、Host 原样转发、SSE 不缓冲。

`data/config.yaml` 的 `access` 要配合填：

```yaml
access:
  allowIps: [203.0.113.10]                    # 操作者的出口 IP；去掉 127.0.0.1 / ::1，请求都经 Caddy 进来
  protectReads: true                          # 服务在公网上，白名单外看不到发布记录和日志
  trustProxy: true
  proxyIps: [127.0.0.1, ::1]
  allowedOrigins: [https://deploy.example.com]  # 与 .env 的 SHIPYARD_DOMAIN 一致
```

**环境变量**（写在仓库根目录的 `.env` 里）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `SHIPYARD_DOMAIN` | — | 必填。对外域名，Caddy 用它申请证书 |
| `FEISHU_WEBHOOK` / `FEISHU_SECRET` | — | 覆盖配置里的飞书机器人 |

端口固定为 8080（Caddyfile 反代到这里）；`SHUTDOWN_TIMEOUT_MS`（默认 600000）、`DATA_DIR` / `CONFIG_PATH` 在镜像里已设好，一般不用改。

## 配置

完整示例见 [config.example.yaml](config.example.yaml)。在旧配置基础上新增：

- `server`：端口、`maxConcurrent`（同时执行的环境数，默认 3）、`logRetentionDays`、`publicUrl`（飞书卡片「查看详情」链接）。
- `access`：`allowIps`（可以发起 / 取消 / 重试的 IP，支持 CIDR）、`protectReads`、`trustProxy` + `proxyIps`、`allowedOrigins`。
- `ssh.privateKeyPath`：代替旧版编译时内嵌私钥；`ssh.keepPrevious`：替换时保留 `dist.prev` 方便手工回滚。

配置是**热加载**的：每次发起发布前重新读取并校验。改坏了不会影响正在执行的任务，只是暂停发起新发布，页面上会提示原因。

## 行为要点

- **并发**：全局最多 `maxConcurrent` 个环境同时执行，其余排队，先来先执行。
- **环境锁**：按「主机 + 发布目录」加锁；目录正被别的任务占用时直接拒绝（409），向导第 ② 步会置灰并显示占用的任务号。
- **取消**：排队中的直接取消；克隆 / 安装 / 构建会结束整个进程组；上传在远端替换开始前可以取消，替换开始后会执行完。
- **重试**：把失败、取消、中断的环境重新发起一个新任务（用最新配置、重新克隆）。
- **重启恢复**：服务启动时把上次没跑完的任务标记为「已中断」，并清理残留临时目录。
- **访问控制**：不做登录。执行类接口只接受白名单 IP + 同源 JSON 请求（校验 Origin / Host、不开 CORS），防止白名单网络里的浏览器被恶意网页利用。前端按钮的禁用只是体验，是否放行只由后端判定。
- **日志**：`data/logs/<任务号>/<环境序号>.log`，仓库地址里的凭据会被替换成 `***`；单行超过 4KB 截断，单个环境超过 20MB 停止写入。

## 测试

```bash
bun test          # shared + server：流水线、调度、环境锁、取消 / 重试 / 恢复、白名单、跨站拦截、SSE
bun run typecheck
```

## 上线前检查

1. 目标机安全组放行本服务出口 IP 的 22 端口。
2. Codeup 拉取凭据（只读令牌）写进 `data/config.yaml` 的 `repos` 地址里，格式见 [config.example.yaml](config.example.yaml)。容器里读不到宿主机的 `~/.git-credentials` 或 credential helper。
3. 打开 `https://<域名>`，页面显示的 IP 应该是自己的真实出口 IP；显示「未知」说明 `access.trustProxy` 没开，服务日志里有具体提示。在服务器上直连 `curl -s -H 'Host: <域名>' http://127.0.0.1:8080/api/whoami` 不带 X-Forwarded-For，返回空 IP，这是预期的。
4. 迁移完成后**轮换 SSH 私钥**，回收旧的 CLI 二进制文件（里面有旧私钥明文）。
