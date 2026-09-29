# Ease-Deploy（Web 版）

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
data/             运行时数据（不进 git）：config.yaml、ssh/deploy.pem、ease-deploy.db、logs/
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

## 构建与运行

```bash
bun run build     # 构建前端到 apps/web/dist
bun run start     # 一个端口同时提供 API 和页面：http://localhost:8080
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DATA_DIR` | `./data` | 数据库、日志所在目录 |
| `CONFIG_PATH` | `$DATA_DIR/config.yaml` | 配置文件 |
| `PORT` | `server.port` | 覆盖配置里的端口 |
| `FEISHU_WEBHOOK` / `FEISHU_SECRET` | — | 覆盖配置里的飞书机器人 |
| `SHUTDOWN_TIMEOUT_MS` | 600000 | 收到 SIGTERM 后等待执行中环境的最长时间 |

Docker：见 [Dockerfile](Dockerfile) 和 [deploy/docker-compose.example.yml](deploy/docker-compose.example.yml)；前面有 nginx 时参考 [deploy/nginx.conf.example](deploy/nginx.conf.example)（SSE 需要关缓冲）。

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
2. 服务器上的 Codeup 拉取凭据（建议只读部署令牌）。
3. 迁移完成后**轮换 SSH 私钥**，回收旧的 CLI 二进制文件（里面有旧私钥明文）。
