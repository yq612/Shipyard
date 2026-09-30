# Shipyard

在浏览器里完成「选国家 → 选环境 → 确认计划 → 执行」的构建与发布。每个环境在服务端依次执行「克隆代码 → 安装依赖 → 构建产物 → 上传发布」，进度和日志实时可见，发布记录可追溯，结束后可推送飞书通知。

- **新建发布**：按国家挑选环境，确认执行计划（分支、目标主机、命令）后开始
- **发布详情**：每个环境的阶段进度、实时日志；可取消执行中的环境，重试失败的环境或同样的环境再发一次
- **发布记录**：按国家筛选历史发布

界面遵循 [磷光设计体系](docs/design/README.md)。

## 结构

```
packages/shared   前后端共用：类型、ProgressEvent、reduceProgress（不依赖 node:*）
apps/server       Bun + Hono：REST + SSE、调度、环境锁、SQLite、日志、飞书通知
apps/web          Vite + React，构建后由 server 托管
deploy/           compose 用的 Caddyfile、服务器升级脚本
data/             运行时数据（不进 git）：config.yaml、ssh/deploy.pem、shipyard.db、logs/
```

## 开发

依赖 [Bun](https://bun.sh) 1.3+、Node.js 22 LTS、git、tar。Shipyard 自身由 Bun 运行；Nuxt 等带 Node shebang 的构建工具通过真实 Node 执行，避免 Bun 的兼容性差异。

```bash
bun install
mkdir -p data/ssh && cp config.example.yaml data/config.yaml
cp /path/to/deploy.pem data/ssh/ && chmod 600 data/ssh/deploy.pem
bun run dev          # API :8080 + Vite :5173，127.0.0.1 默认在白名单
bun test && bun run typecheck
```

## 部署

`docker compose` 起两个容器，都用 host 网络：`caddy` 占 80 / 443，自动申请、续签 Let's Encrypt 证书；`shipyard` 只监听 `127.0.0.1:8080`。

服务器要求：Docker（带 compose 插件）、git；域名 A 记录指向它；80 / 443 对全网开放（证书验证从多地发起），8080 不开。

运行镜像内同时包含 Bun 和 Node.js 22，宿主机不用安装它们。构建命令写 `bun install` / `bun run build` 即可，不要给 Nuxt 2 等工具加 `--bun` 强制切换运行时。

### 不在 git 里、要手工放到服务器的文件

| 文件 | 内容 |
|---|---|
| `.env` | `SHIPYARD_DOMAIN=<域名>`；可选 `FEISHU_WEBHOOK` / `FEISHU_SECRET` |
| `data/config.yaml` | 从 [config.example.yaml](config.example.yaml) 改，`access` 见下 |
| `data/ssh/deploy.pem` | 登录目标机的私钥，`chmod 600` |

其余（`shipyard.db`、`logs/`、证书）都是运行时生成的，新机器从空开始。

`data/config.yaml` 的 `access` 要这样填：

```yaml
access:
  allowIps: [203.0.113.10]      # 操作者访问该域名时的出口 IP；不放 127.0.0.1（请求都经 Caddy 进来）
  protectReads: true            # 白名单外看不到发布记录和日志
  trustProxy: true
  proxyIps: [127.0.0.1, ::1]
  allowedOrigins: [https://deploy.example.com]
```

开了 VPN 分流时，访问该域名的出口 IP 可能和访问海外网站的不同，以页面顶栏（或 `/api/whoami`）显示的为准。

### 首次

```bash
# 服务器上
git clone https://github.com/yq612/Shipyard.git /opt/shipyard && cd /opt/shipyard
echo 'SHIPYARD_DOMAIN=deploy.example.com' > .env
mkdir -p data/ssh              # 放入 config.yaml、ssh/deploy.pem
deploy/upgrade.sh
```

### 之后每次

```bash
# 本地，HEAD 必须等于 origin/main
echo 'DEPLOY_SSH=root@<服务器>' > .env.local     # 一次性；要求能免密 SSH 登录
bun run deploy
```

它在服务器上执行 `deploy/upgrade.sh`：`git pull` → 重建并等健康检查 → Caddyfile 有变化就 reload → 经 Caddy 验证 HTTPS → 清理旧镜像。终端只显示关键步骤；脚本在服务器上独立运行，SSH 断开也会跑完，完整输出在 `data/upgrade.log`。

执行中的发布会先跑完才切换（最多 11 分钟），期间 Caddy 让请求等后端最多 30 秒。

### 运维

- 日志：`docker compose logs -f shipyard`；证书：`docker compose logs caddy`
- 回滚：`git checkout <提交> && docker compose up -d --build --wait`，修好后 `git checkout main && deploy/upgrade.sh`
- 备份：`docker compose stop shipyard`，打包 `data/`，再 `start`（WAL 模式，运行中只拷 `.db` 会丢数据）
- 升级 Caddy：`docker compose pull caddy && docker compose up -d caddy`

### 不要做

- 改服务器上的 `compose.yaml` / `Caddyfile`：主机相关的值只放 `.env` 和 `data/`，否则 `git pull` 冲突
- `rsync` 代码目录（会带上本地 `data/`）、`git clean -x`（会删 `data/` 和 `.env`）
- `docker compose down -v`：会删证书卷，重新申请受 Let's Encrypt 频率限制（同一域名每周 5 张）
- 把 `network_mode: host` 改成 `ports:`：来源 IP 会变成 Docker 网关，白名单失效

## 配置

见 [config.example.yaml](config.example.yaml)。热加载：每次发起发布前重新读取；改坏了只暂停新发布，不影响执行中的任务。

## 行为

- **并发**：全局最多 `maxConcurrent` 个环境，其余排队
- **环境锁**：按「主机 + 发布目录」，被占用时返回 409
- **取消**：克隆 / 安装 / 构建阶段结束整个进程组；远端替换开始后不可取消
- **重试**：失败、取消、中断的环境用最新配置重新发起
- **重启恢复**：未完成的任务标记为「已中断」，清理临时目录
- **访问控制**：无登录。写操作要求白名单 IP + 同源 Origin / Host，不开 CORS
- **日志**：`data/logs/<任务号>/<环境序号>.log`，仓库凭据脱敏为 `***`

### 资源清理

- **本地**：每次发布结束（无论结果）删除克隆目录和上传包，启动时和每日定时再清一次残留
- **进程**：构建命令退出时结束同组子进程；取消先发 SIGTERM，5 秒后 SIGKILL
- **远端**：失败时尽力清理暂存包和解压目录，清不掉会在任务日志告警；替换结果未知时保留现场。`keepPrevious` 开启时保留一份 `dist.prev` 用于回滚
- **记录**：发布记录和日志保留 `logRetentionDays` 天（默认 30）。Bun 下载缓存和 Docker 构建缓存不会自动清理，需定期关注磁盘
- **存储故障**：数据库写入失败时暂停新发布并告警，历史记录可能不完整，先核对目标机实际结果再重试

## 上线检查

1. 目标机安全组放行服务器出口 IP 的 22 端口
2. `data/config.yaml` 的 `repos` 地址带 Codeup 只读令牌（容器读不到宿主机的 git 凭据）
3. 页面显示的 IP 是自己的出口 IP 且可执行；显示「未知」说明 `trustProxy` 没开
