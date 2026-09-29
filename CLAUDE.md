# Shipyard

Bun workspaces 单仓：`packages/shared`（前后端共用）、`apps/server`（Bun + Hono + bun:sqlite）、`apps/web`（Vite + React）。背景与设计决策见 `docs/web-migration-research.md`。

## 命令

- `bun run dev` — API :8080（--watch）+ Vite :5173（代理 /api）
- `bun test` — 所有单测；`bun run typecheck` — 三个包分别 tsc
- `bun run build` — 前端产物到 `apps/web/dist`，由 server 托管

## 约定

- `packages/shared` 必须能在浏览器里跑：不许引用 `node:*`、Bun API 或任何终端库。
- 进度状态只从事件推导：服务端和前端都用 `reduceProgress` 回放 `ProgressEvent`，不要另写一套状态映射。新增状态先改 reducer 和它的测试。
- `runPipeline` 永不抛异常，失败和取消都折叠进 `EnvOutcome`。
- 仓库地址可能带凭据：写日志、写库、返回接口前都要过 `redactUrl`。`/api/config` 永远不返回 ssh / notify / access。
- 所有会改变状态的接口都是 POST + JSON，并挂 `guardWrite`（Origin / Host + IP 白名单）。不要开 CORS。
- 前端样式遵守磷光设计体系（`docs/design/`）：颜色只用 `--c-*` 变量，绿色文字和线条用 `--c-accent-ink`，像素字号只用 12 的倍数，间距用 6 的倍数，不用圆角和投影。`apps/web/src/styles/phosphor.css` 是设计体系原文件，不要改；页面样式写在 `app.css`。
