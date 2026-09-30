import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigStore } from "./core/config.ts";
import { spawnRunner } from "./core/process.ts";
import { createApp } from "./http/app.ts";
import { cleanTmp, realPipelineDeps } from "./service/deps.ts";
import { DeploymentService } from "./service/deployments.ts";
import { openDatabase } from "./store/db.ts";
import { LogStore } from "./store/logs.ts";
import { Repository } from "./store/repo.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(ROOT, "data"));
const CONFIG_PATH = resolve(process.env.CONFIG_PATH ?? join(DATA_DIR, "config.yaml"));
const WEB_DIST = resolve(process.env.WEB_DIST ?? join(ROOT, "apps/web/dist"));
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10 * 60 * 1000);
const DAY_MS = 24 * 3600 * 1000;

async function assertTools(): Promise<void> {
  const missing: string[] = [];
  for (const tool of ["git", "tar", "bun", "node"]) {
    try {
      await spawnRunner(tool, ["--version"]);
    } catch {
      missing.push(tool);
    }
  }
  if (missing.length) console.warn(`[startup] 缺少命令：${missing.join(", ")}，发布会失败，请先安装`);
  if (!missing.includes("node")) {
    try {
      const { stdout } = await spawnRunner("node", ["-p", "process.versions.bun ?? ''"]);
      if (stdout.trim()) console.warn("[startup] node 实际指向 Bun；Nuxt 等构建工具需要真实 Node.js，请更新部署镜像");
    } catch {
      console.warn("[startup] 无法验证 Node.js 运行时，请检查 node 命令及部署镜像");
    }
  }
}

async function main(): Promise<void> {
  let config: ConfigStore;
  try {
    config = new ConfigStore(CONFIG_PATH);
  } catch (e) {
    console.error(`[startup] ${e instanceof Error ? e.message : String(e)}`);
    console.error(`[startup] 请把配置文件放到 ${CONFIG_PATH}（可参考 config.example/），或用 CONFIG_PATH 指定路径`);
    process.exit(1);
  }
  const cfg = config.get();
  if (!existsSync(cfg.ssh.privateKeyPath)) {
    console.warn(`[startup] SSH 私钥不存在：${cfg.ssh.privateKeyPath}，发起发布时会被拒绝`);
  }
  for (const [label, bin] of Object.entries(cfg.runtimes.node)) {
    if (!existsSync(join(bin, "node"))) console.warn(`[startup] runtimes.node.${label} 指向的 ${bin} 下没有 node，用到它的环境会构建失败`);
  }
  for (const p of cfg.projects) {
    if (p.error) console.warn(`[startup] 项目「${p.name}」配置有误，暂不能发布：${p.error}`);
  }
  if (cfg.access.allowIps.length === 0) {
    console.warn("[startup] access.allowIps 为空：所有人都只能查看，不能执行发布");
  }
  await assertTools();

  const repo = new Repository(openDatabase(join(DATA_DIR, "shipyard.db")));
  const logs = new LogStore(join(DATA_DIR, "logs"));
  const service = new DeploymentService({ repo, logs, config, pipeline: realPipelineDeps() });

  service.recover();
  const cleaned = await cleanTmp();
  if (cleaned) console.log(`[startup] 清理了 ${cleaned} 个残留临时目录`);
  const expired = service.cleanupOld();
  if (expired) console.log(`[startup] 清理了 ${expired} 条过期发布记录`);

  // Daily housekeeping. Temp dirs younger than a day may belong to running jobs.
  const housekeeping = setInterval(() => {
    service.cleanupOld();
    void cleanTmp(DAY_MS);
  }, DAY_MS);
  housekeeping.unref();

  const port = Number(process.env.PORT ?? cfg.server.port);
  const app = createApp({
    service,
    logs,
    config,
    socketIp: (c) => server.requestIP(c.req.raw)?.address ?? "",
    webDist: WEB_DIST,
  });
  const server = Bun.serve({
    port,
    hostname: process.env.HOST ?? "0.0.0.0",
    // SSE streams send a heartbeat every 5s; this only reaps truly dead sockets.
    idleTimeout: 30,
    fetch: app.fetch,
  });
  console.log(`[startup] Shipyard 已启动：http://localhost:${server.port}（配置 ${CONFIG_PATH}，数据 ${DATA_DIR}）`);
  if (!existsSync(join(WEB_DIST, "index.html"))) {
    console.log("[startup] 前端未构建，只提供 API；开发时请用 `bun run dev`");
  }

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) {
      console.warn("[shutdown] 再次收到信号，立即退出");
      process.exit(1);
    }
    stopping = true;
    console.log(`[shutdown] 收到 ${signal}，不再接受新发布，等待执行中的环境完成（最多 ${Math.round(SHUTDOWN_TIMEOUT_MS / 60000)} 分钟）…`);
    await service.shutdown(SHUTDOWN_TIMEOUT_MS);
    logs.closeAll();
    await server.stop(true);
    repo.db.close();
    console.log("[shutdown] 已退出");
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

await main();
