import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type {
  ApiErrorBody,
  CreateDeploymentRequest,
  DeploymentListQuery,
  DeploymentStatus,
  ErrorCode,
  LogChunk,
  LogLine,
  LogTail,
  RetryDeploymentRequest,
  WhoAmI,
} from "@shipyard/shared";
import type { ConfigStore } from "../core/config.ts";
import type { AccessConfig } from "../core/types.ts";
import type { DeploymentService } from "../service/deployments.ts";
import { ServiceError } from "../service/errors.ts";
import type { LogStore } from "../store/logs.ts";
import { clientIp, isHostAllowed, isIpAllowed, isOriginAllowed } from "./access.ts";
import { sse, writeQueue } from "./sse.ts";

export interface AppDeps {
  service: DeploymentService;
  logs: LogStore;
  config: ConfigStore;
  // Socket peer address; Bun gives it via server.requestIP. Tests inject one.
  socketIp: (c: Context) => string;
  webDist?: string; // built SPA to serve; omitted in dev (Vite serves it)
}

type Env = { Variables: { ip: string; access: AccessConfig } };

const LOG_TAIL_LINES = 500;
const DEPLOYMENT_STATUSES: DeploymentStatus[] = ["queued", "running", "succeeded", "partial", "failed", "cancelled", "interrupted"];

function fail(c: Context, status: ServiceError["status"], code: ErrorCode, message: string, details?: unknown) {
  const body: ApiErrorBody = { code, message, ...(details !== undefined ? { details } : {}) };
  return c.json(body, status);
}

function intParam(value: string | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}

async function jsonBody<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new ServiceError("BAD_REQUEST", 400, "请求体不是合法的 JSON");
  }
}

function operatorName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().slice(0, 40);
  return name || null;
}

export function createApp(deps: AppDeps): Hono<Env> {
  const { service, logs, config } = deps;
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof ServiceError) return fail(c, err.status, err.code, err.message, err.details);
    console.error("[http] unhandled error:", err);
    return fail(c, 500, "INTERNAL", "服务器内部错误");
  });

  // Resolve the client IP once per request, against the latest access config.
  app.use("*", async (c, next) => {
    const access = config.refresh().access;
    c.set("access", access);
    c.set("ip", clientIp(deps.socketIp(c), c.req.header("x-forwarded-for"), access));
    await next();
  });

  // DNS rebinding: every API request must carry a Host we actually serve.
  // The health check is exempt so monitors can probe by IP.
  app.use("/api/*", async (c, next) => {
    if (c.req.path !== "/api/health" && !isHostAllowed(c.req.header("host"), c.get("access"))) {
      return fail(c, 403, "ORIGIN_REJECTED", "Host 不在允许列表中");
    }
    await next();
  });

  const logRejection = (c: Context<Env>, reason: string) =>
    console.warn(`[access] 拒绝 ${c.req.method} ${c.req.path} · IP ${c.get("ip")} · ${reason}`);

  // Writes: JSON only (forces a CORS preflight cross-site, which we never
  // answer), same-origin only, and the caller's IP must be allowlisted.
  const guardWrite: MiddlewareHandler<Env> = async (c, next) => {
    const access = c.get("access");
    const type = c.req.header("content-type") ?? "";
    if (!type.toLowerCase().startsWith("application/json")) {
      return fail(c, 415, "UNSUPPORTED_MEDIA_TYPE", "只接受 Content-Type: application/json");
    }
    if (!isOriginAllowed(c.req.header("origin"), c.req.header("host"), access)) {
      logRejection(c, `Origin ${c.req.header("origin") ?? "(无)"}`);
      return fail(c, 403, "ORIGIN_REJECTED", "请求来源（Origin）不被允许");
    }
    if (!isIpAllowed(c.get("ip"), access)) {
      logRejection(c, "IP 不在白名单");
      return fail(c, 403, "IP_NOT_ALLOWED", `当前 IP ${c.get("ip")} 不在白名单，请联系管理员添加`);
    }
    await next();
  };

  const guardRead: MiddlewareHandler<Env> = async (c, next) => {
    const access = c.get("access");
    if (access.protectReads && !isIpAllowed(c.get("ip"), access)) {
      logRejection(c, "查看类接口，IP 不在白名单");
      return fail(c, 403, "IP_NOT_ALLOWED", `当前 IP ${c.get("ip")} 不在白名单，无权查看`);
    }
    await next();
  };

  const api = new Hono<Env>();

  api.get("/health", (c) => c.json({ ok: true, ...service.status() }));

  api.get("/whoami", (c) => {
    const access = c.get("access");
    const body: WhoAmI = { ip: c.get("ip"), allowed: isIpAllowed(c.get("ip"), access), protectReads: access.protectReads };
    return c.json(body);
  });

  api.get("/status", guardRead, (c) => c.json(service.status()));

  api.get("/config", guardRead, (c) => c.json(service.configView()));

  // Pure computation — anyone who can read may preview the plan.
  api.post("/deployments/plan", guardRead, async (c) => {
    const body = await jsonBody<CreateDeploymentRequest>(c);
    if (typeof body?.countryCode !== "string" || !Array.isArray(body.envNames)) {
      throw new ServiceError("BAD_REQUEST", 400, "需要 countryCode 和 envNames");
    }
    return c.json(service.plan(body.countryCode, body.envNames.map(String)));
  });

  api.post("/deployments", guardWrite, async (c) => {
    const body = await jsonBody<CreateDeploymentRequest>(c);
    if (typeof body?.countryCode !== "string" || !Array.isArray(body.envNames)) {
      throw new ServiceError("BAD_REQUEST", 400, "需要 countryCode 和 envNames");
    }
    const created = service.create(body.countryCode, body.envNames.map(String), {
      ip: c.get("ip"),
      name: operatorName(body.operatorName),
      userAgent: c.req.header("user-agent")?.slice(0, 300) ?? null,
    });
    return c.json(created, 201);
  });

  api.get("/deployments", guardRead, (c) => {
    const q = c.req.query();
    const status = q.status as DeploymentStatus | undefined;
    const query: DeploymentListQuery = {
      page: intParam(q.page) ?? 1,
      pageSize: intParam(q.pageSize) ?? 20,
      ...(q.country ? { country: q.country } : {}),
      ...(q.env ? { env: q.env } : {}),
      ...(status && DEPLOYMENT_STATUSES.includes(status) ? { status } : {}),
      ...(intParam(q.from) !== undefined ? { from: intParam(q.from) } : {}),
      ...(intParam(q.to) !== undefined ? { to: intParam(q.to) } : {}),
    };
    return c.json(service.list(query));
  });

  const deploymentId = (c: Context) => {
    const id = intParam(c.req.param("id"));
    if (id === undefined || id <= 0) throw new ServiceError("NOT_FOUND", 404, "任务不存在");
    return id;
  };

  api.get("/deployments/:id", guardRead, (c) => {
    const id = deploymentId(c);
    const detail = service.detail(id);
    if (!detail) throw new ServiceError("NOT_FOUND", 404, `任务 #${id} 不存在`);
    return c.json(detail);
  });

  api.get("/deployments/:id/events", guardRead, (c) => {
    const id = deploymentId(c);
    if (!service.detail(id)) throw new ServiceError("NOT_FOUND", 404, `任务 #${id} 不存在`);
    return sse(c, async (stream, closed) => {
      const send = writeQueue(stream);
      // Subscribe first and buffer, then take the snapshot, then drop whatever
      // the snapshot already covers — no event is lost or applied twice.
      let snapshotSeq: number | null = null;
      const buffered: Parameters<Parameters<DeploymentService["subscribe"]>[1]>[0][] = [];
      let ended = false;
      let resolveEnd!: () => void;
      const endPromise = new Promise<void>((r) => (resolveEnd = r));
      const deliver = (msg: (typeof buffered)[number]) => {
        if (msg.type === "progress") {
          if (snapshotSeq !== null && msg.seq <= snapshotSeq) return;
          void send("progress", { seq: msg.seq, event: msg.event }, msg.seq);
        } else if (msg.type === "deployment") {
          void send("deployment", msg.summary);
        } else if (!ended) {
          ended = true;
          void send("end", {}).then(resolveEnd);
        }
      };
      const unsubscribe = service.subscribe(id, (msg) => {
        if (snapshotSeq === null) buffered.push(msg);
        else deliver(msg);
      });
      try {
        const detail = service.detail(id)!;
        snapshotSeq = detail.lastSeq;
        await send("snapshot", detail, detail.lastSeq);
        for (const msg of buffered.splice(0)) deliver(msg);
        if (!service.hasPendingEnd(id) && !ended) {
          // Finished before we connected: the snapshot is final.
          ended = true;
          await send("end", {});
          resolveEnd();
        }
        await Promise.race([closed, endPromise]);
      } finally {
        unsubscribe();
      }
    });
  });

  const envIdx = (c: Context, id: number) => {
    const idx = intParam(c.req.param("idx"));
    const detail = service.detail(id);
    if (!detail) throw new ServiceError("NOT_FOUND", 404, `任务 #${id} 不存在`);
    if (idx === undefined || !detail.envs.some((e) => e.idx === idx)) throw new ServiceError("NOT_FOUND", 404, "环境不存在");
    return { idx, detail };
  };

  api.get("/deployments/:id/envs/:idx/logs", guardRead, (c) => {
    const id = deploymentId(c);
    const { idx } = envIdx(c, id);
    const follow = c.req.query("follow") === "1";

    if (c.req.query("download") === "1") {
      const text = logs.readAll(id, idx).map((l) => `${new Date(l.ts).toISOString()} [${l.stream}]${l.stage ? ` [${l.stage}]` : ""} ${l.text}`).join("\n");
      c.header("Content-Disposition", `attachment; filename="deployment-${id}-env-${idx}.log"`);
      return c.text(text + "\n");
    }

    if (!follow) {
      const all = logs.readAll(id, idx);
      const offset = Math.max(0, intParam(c.req.query("offset")) ?? 0);
      const limit = Math.min(Math.max(intParam(c.req.query("limit")) ?? 2000, 1), 10000);
      const lines = all.slice(offset, offset + limit);
      const body: LogChunk = {
        lines,
        offset,
        nextOffset: offset + lines.length,
        total: all.length,
        done: !logs.isOpen(id, idx) && isSettled(service, id, idx),
      };
      return c.json(body);
    }

    return sse(c, async (stream, closed) => {
      const send = writeQueue(stream);
      let resolveEnd!: () => void;
      const endPromise = new Promise<void>((r) => (resolveEnd = r));
      const pending: LogLine[] = [];
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        flushTimer = undefined;
        if (pending.length) void send("lines", pending.splice(0));
      };
      // Log writes are synchronous, so subscribing and then reading the file in
      // the same tick sees every line exactly once.
      const unsubscribe = logs.subscribe(id, idx, (msg) => {
        if (msg.type === "line") {
          pending.push(msg.line);
          flushTimer ??= setTimeout(flush, 100);
        } else {
          if (flushTimer) clearTimeout(flushTimer);
          flush();
          void send("end", {}).then(resolveEnd);
        }
      });
      try {
        const all = logs.readAll(id, idx);
        const tail: LogTail = { lines: all.slice(-LOG_TAIL_LINES), skipped: Math.max(0, all.length - LOG_TAIL_LINES) };
        await send("tail", tail);
        if (!logs.isOpen(id, idx) && isSettled(service, id, idx)) {
          await send("end", {});
          return;
        }
        await Promise.race([closed, endPromise]);
      } finally {
        if (flushTimer) clearTimeout(flushTimer);
        unsubscribe();
      }
    });
  });

  api.post("/deployments/:id/cancel", guardWrite, async (c) => {
    const id = deploymentId(c);
    const env = c.req.query("env");
    const idx = env === undefined ? undefined : intParam(env);
    if (env !== undefined && idx === undefined) throw new ServiceError("BAD_REQUEST", 400, "env 参数必须是环境序号");
    return c.json(service.cancel(id, idx));
  });

  api.post("/deployments/:id/retry", guardWrite, async (c) => {
    const id = deploymentId(c);
    const body = await jsonBody<RetryDeploymentRequest>(c).catch(() => ({}) as RetryDeploymentRequest);
    const created = service.retry(id, {
      ip: c.get("ip"),
      name: operatorName(body?.operatorName),
      userAgent: c.req.header("user-agent")?.slice(0, 300) ?? null,
    });
    return c.json(created, 201);
  });

  api.all("*", (c) => fail(c, 404, "NOT_FOUND", `接口不存在：${c.req.method} ${c.req.path}`));

  app.route("/api", api);

  if (deps.webDist && existsSync(join(deps.webDist, "index.html"))) {
    mountSpa(app, deps.webDist);
  } else {
    app.get("/", (c) =>
      c.text("Ease-Deploy API 已启动。前端未构建：开发时运行 `bun run dev`，部署前运行 `bun run build`。\n"),
    );
  }

  return app;
}

function isSettled(service: DeploymentService, id: number, idx: number): boolean {
  const detail = service.detail(id);
  const status = detail?.envs.find((e) => e.idx === idx)?.status;
  return status !== undefined && status !== "queued" && status !== "running";
}

// Static assets from the Vite build; every other GET falls back to index.html
// so client-side routes (/deployments/42) survive a refresh.
function mountSpa(app: Hono<Env>, dist: string): void {
  const indexFile = join(dist, "index.html");
  app.get("*", async (c) => {
    let rel = "";
    try {
      rel = decodeURIComponent(c.req.path).replace(/^\/+/, "");
    } catch {
      // malformed escape — fall through to index.html
    }
    if (rel && !rel.split("/").includes("..")) {
      const file = Bun.file(join(dist, rel));
      if (await file.exists()) {
        const immutable = rel.startsWith("assets/");
        c.header("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
        return c.body(await file.arrayBuffer(), 200, { "Content-Type": file.type });
      }
    }
    c.header("Cache-Control", "no-cache");
    return c.html(await Bun.file(indexFile).text());
  });
}
