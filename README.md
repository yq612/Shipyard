# Shipyard

在浏览器里完成「选项目（国家） → 选环境 → 确认计划 → 执行」的构建与发布。每个环境在服务端依次执行「克隆代码 → 安装依赖 → 构建产物 → 上传发布」，进度和日志实时可见，发布记录可追溯，结束后可推送飞书通知。

- **新建发布**：先选项目（充值网站、官网、定制商城……），按国家分组的项目再选国家，然后挑选环境，确认执行计划（分支、目标主机、命令、node 版本）后开始
- **发布详情**：每个环境的阶段进度、实时日志；可取消执行中的环境，重试失败的环境或同样的环境再发一次
- **发布记录**：按项目、国家、环境、状态筛选历史发布

界面遵循 [磷光设计体系](docs/design/README.md)。

## 结构

```
packages/shared   前后端共用：类型、ProgressEvent、reduceProgress（不依赖 node:*）
apps/server       Bun + Hono：REST + SSE、调度、环境锁、SQLite、日志、飞书通知
apps/web          Vite + React，构建后由 server 托管
deploy/           compose 用的 Caddyfile、服务器升级脚本
data/             运行时数据（不进 git）：config.yaml、projects/、ssh/deploy.pem、shipyard.db、logs/
```

## 开发

依赖 [Bun](https://bun.sh) 1.3+、Node.js 22 LTS、git、tar。Shipyard 自身由 Bun 运行；Nuxt 等带 Node shebang 的构建工具通过真实 Node 执行，避免 Bun 的兼容性差异。

```bash
bun install
mkdir -p data/ssh data/projects   # 按下面「配置」写 data/config.yaml 和 data/projects/*.yaml
cp /path/to/deploy.pem data/ssh/ && chmod 600 data/ssh/deploy.pem
bun run dev          # API :8080 + Vite :5173，127.0.0.1 默认在白名单
bun test && bun run typecheck
```

## 部署

`docker compose` 起两个容器，都用 host 网络：`caddy` 占 80 / 443，自动申请、续签 Let's Encrypt 证书；`shipyard` 只监听 `127.0.0.1:8080`。

服务器要求：Docker（带 compose 插件）、git；域名 A 记录指向它；80 / 443 对全网开放（证书验证从多地发起），8080 不开。

运行镜像内同时包含 Bun 和 Node.js，版本固定在 Dockerfile 的 `BUN_VERSION` / `NODE_VERSION`（升级就改这两行），宿主机不用安装它们。构建命令写 `bun install` / `bun run build` 即可，不要给 Nuxt 2 等工具加 `--bun` 强制切换运行时。每个环境的日志开头会记录实际用的 node 和 bun 版本。

个别项目需要别的 node 版本时，把官方的 `node-vXX-linux-x64.tar.xz` 解压到 `data/runtimes/`，在 `data/config.yaml` 的 `runtimes.node` 里起个名字，再在项目或环境的 `build.node` 里引用它。不用重建镜像。

### 不在 git 里、要手工放到服务器的文件

| 文件 | 内容 |
|---|---|
| `.env` | `SHIPYARD_DOMAIN=<域名>`；可选 `FEISHU_WEBHOOK` / `FEISHU_SECRET` |
| `data/config.yaml` | 全局配置，见「配置」；`access` 见下 |
| `data/projects/*.yaml` | 每个项目一个文件，见「配置」 |
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

开了 VPN 分流时，访问该域名的出口 IP 可能和访问海外网站的不同，以 `/api/whoami` 返回的为准（不在白名单时，页面顶栏会显示「只读」，悬停可看到 IP）。

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

两层，都在 `data/`（`CONFIG_PATH` 可指定 `config.yaml` 的位置，`projects/` 放在它旁边）：

- `config.yaml`：所有项目共用的服务设置、访问控制、SSH 身份、Git 令牌、node 版本和默认构建命令
- `projects/<项目>.yaml`：每个项目一个文件。文件名就是项目 key，会写进发布记录，定了不要改

热加载：每次发起发布前重新读取，改环境、白名单、增删项目都不用重启。`config.yaml` 改坏了暂停所有新发布，某个项目文件改坏了只暂停这个项目，都不影响执行中的任务。

### config.yaml

```yaml
server:
  port: 8080
  publicUrl: https://deploy.example.com  # 可选，飞书卡片「查看详情」的链接前缀
  maxConcurrent: 3            # 所有项目加起来同时执行的环境数
  logRetentionDays: 30        # 发布记录和日志保留天数

access:                       # 线上怎么填见「部署」
  allowIps: [127.0.0.1, ::1]  # 能发起 / 取消 / 重试的 IP，支持 CIDR
  protectReads: false         # true：查看也要在白名单内
  trustProxy: false           # 前面有反向代理时 true，只信任 proxyIps 转发的 X-Forwarded-For
  proxyIps: [127.0.0.1, ::1]
  allowedOrigins: []          # 空 = 只允许同源；上线填对外地址，防 DNS 重绑定

ssh:                          # 所有项目共用
  user: root
  port: 22
  privateKeyPath: ssh/deploy.pem  # 相对本文件所在目录，权限 0600
  keepPrevious: true          # 替换时旧版本留作 <目录>.prev，方便手工回滚

git:
  credentials:                # 私有仓库的只读令牌，按主机；公开仓库不用配
    - { host: codeup.aliyun.com, username: oauth2, token: <令牌> }             # read_repository
    - { host: github.com, username: x-access-token, token: <细粒度令牌> }      # Contents: Read-only

runtimes:
  node: {}                    # 可选，见「部署」里的 node 版本
  # node20: /data/runtimes/node-v20.20.2-linux-x64/bin

build:                        # 默认值；项目和单个环境都能按字段覆盖
  install: bun install
  build: bun run build
  dist: dist
  # node: node20              # 不写 = 镜像自带的 node

notify:
  feishu:
    webhook: ""               # 空 = 不推送；也可以用环境变量 FEISHU_WEBHOOK / FEISHU_SECRET
```

令牌经临时凭据助手交给 `git clone`，不出现在仓库地址、进程参数、日志和数据库里。某个主机配了令牌，就只用它；没配的主机走 git 自己的凭据（本机开发时是钥匙串，容器里没有）。

### 项目文件 projects/*.yaml

按国家分组，发布目录用模板拼：

```yaml
# projects/topup.yaml
name: 充值网站
order: 10                     # 侧栏里的顺序，小的在前
icon: wallet                  # 侧栏图标：wallet / coin / globe / cart / bag / case / job / folder，不写或写错显示 folder
grouping: country
remotePathTemplate: "/home/topup-web/{server}/dist"
repos:
  out: "https://codeup.aliyun.com/<组织>/topupasean-out/topupasean-game-website.git"
countries:
  - name: 巴基斯坦
    code: PK                  # 国旗和地图按它匹配（scripts/gen-country-art.ts）
    environments:
      - { name: QuickBuy 环境, branch: PK-QuickBuy, server: quickbuypk, host: 47.245.116.22, repo: out }
```

不分组，直接写发布目录，按需覆盖构建设置：

```yaml
# projects/official.yaml
name: 官网
order: 20
icon: globe
build: { build: "bun run build --mode production" }   # 参数会接到脚本最后一条命令后面
repos:
  site: "https://codeup.aliyun.com/<组织>/future-harvest.git"
environments:
  - { name: Future Harvest, branch: main, repo: site, host: 47.236.196.237, remotePath: /home/future-harvest-web/dist }
  - name: 后台
    branch: main
    repo: site
    host: 47.236.196.237
    remotePath: /home/future-harvest-admin/dist
    build: { build: vite build }
```

- `remotePath` 是线上目录本身：至少两级的绝对路径，末尾的 `/` 会去掉。`server`（暂存文件名）不写时取它的上一级目录名
- 任何两个环境，包括不同项目的，都不能发布到同一台主机的同一个目录
- 构建设置按字段合并：`config.yaml` 的 `build` ← 项目的 `build` ← 环境的 `build`；`node: default` 表示改回镜像自带的 node

旧的单文件格式（`repos` / `countries` / `ssh.remotePathTemplate` 直接写在 `config.yaml` 里）仍然能读，会当作「充值网站」项目（key `topup`）。迁移时把它们挪到 `projects/topup.yaml`、仓库地址里的令牌挪到 `git.credentials` 即可，发布记录会沿用。

## 行为

- **并发**：全局最多 `maxConcurrent` 个环境，其余排队
- **环境锁**：按「主机 + 发布目录」，被占用时返回 409
- **取消**：克隆 / 安装 / 构建阶段结束整个进程组；远端替换开始后不可取消
- **重试**：失败、取消、中断的环境用最新配置重新发起
- **重启恢复**：未完成的任务标记为「已中断」，清理临时目录
- **访问控制**：无登录。写操作要求白名单 IP + 同源 Origin / Host，不开 CORS
- **日志**：`data/logs/<创建日期-时间>-<任务号>/<环境序号>.log`（如 `20260930-143025-12/0.log`，服务器本地时间），仓库凭据脱敏为 `***`

### 资源清理

- **本地**：每次发布结束（无论结果）删除克隆目录和上传包，启动时和每日定时再清一次残留
- **进程**：构建命令退出时结束同组子进程；取消先发 SIGTERM，5 秒后 SIGKILL
- **远端**：失败时尽力清理暂存包和解压目录，清不掉会在任务日志告警；替换结果未知时保留现场。`keepPrevious` 开启时保留一份 `dist.prev` 用于回滚
- **记录**：发布记录和日志保留 `logRetentionDays` 天（默认 30）。Bun 下载缓存和 Docker 构建缓存不会自动清理，需定期关注磁盘
- **存储故障**：数据库写入失败时暂停新发布并告警，历史记录可能不完整，先核对目标机实际结果再重试

## 上线检查

1. 目标机安全组放行服务器出口 IP 的 22 端口
2. `data/config.yaml` 的 `git.credentials` 填了 Codeup / GitHub 的只读令牌（容器读不到宿主机的 git 凭据）；私有 GitHub 仓库也需要
3. 页面显示的 IP 是自己的出口 IP 且可执行；显示「未知」说明 `trustProxy` 没开
