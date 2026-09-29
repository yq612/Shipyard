import { readFileSync } from "node:fs";
import type {
  CancelResult,
  ConfigView,
  CreatedDeployment,
  DeploymentDetail,
  DeploymentList,
  DeploymentListQuery,
  DeploymentStatus,
  DeploymentSummary,
  EnvBusyDetail,
  EnvHolder,
  EnvOutcome,
  Environment,
  LogStream,
  PlanResponse,
  ProgressEvent,
  ProgressState,
  ServerStatus,
  Stage,
} from "@ease-deploy/shared";
import {
  deploymentStatusOf,
  initialProgressState,
  isTaskSettled,
  redactUrl,
  reduceProgress,
  replayProgress,
} from "@ease-deploy/shared";
import { envSpecOf, findCountry, lockKey, type ConfigStore } from "../core/config.ts";
import { buildCardInput } from "./notify-card.ts";
import { buildFeishuCard, sendFeishu, type FeishuCard, type SendResult } from "../core/notify.ts";
import { buildCloneArgs } from "../core/git.ts";
import { buildRemoteScript, buildTarArgs, stagingDir } from "../core/deployer.ts";
import { runPipeline, type PipelineDeps } from "../core/pipeline.ts";
import type { AppConfig, EnvSpec, SshCredentials } from "../core/types.ts";
import type { LogStore } from "../store/logs.ts";
import type { Repository } from "../store/repo.ts";
import { ServiceError } from "./errors.ts";
import { Scheduler } from "./scheduler.ts";

export type DeploymentMessage =
  | { type: "progress"; seq: number; event: ProgressEvent }
  | { type: "deployment"; summary: DeploymentSummary }
  | { type: "end" };

export type DeploymentListener = (msg: DeploymentMessage) => void;

export interface Operator {
  ip: string;
  name: string | null;
  userAgent: string | null;
}

export interface ServiceDeps {
  repo: Repository;
  logs: LogStore;
  config: ConfigStore;
  pipeline: PipelineDeps;
  readKey?: (path: string) => string;
  notify?: (webhook: string, card: FeishuCard, secret?: string) => Promise<SendResult>;
  clock?: () => number; // wall clock, ms
}

// In-memory state of a deployment that still has queued or running envs.
interface Runtime {
  id: number;
  countryName: string;
  specs: EnvSpec[];
  creds: SshCredentials;
  state: ProgressState;
  seq: number;
  status: DeploymentStatus;
  started: boolean;
  controllers: Map<number, AbortController>;
  interrupted: Set<number>; // envs aborted by shutdown: recorded as interrupted, not cancelled
}

const ERROR_SUMMARY_MAX = 4000;

function errorSummary(text: string | undefined): string | null {
  if (!text) return null;
  const clean = redactUrl(text);
  return clean.length > ERROR_SUMMARY_MAX ? "…" + clean.slice(-ERROR_SUMMARY_MAX) : clean;
}

function jobId(deploymentId: number, idx: number): string {
  return `${deploymentId}:${idx}`;
}

export class DeploymentService {
  private readonly repo: Repository;
  private readonly logs: LogStore;
  private readonly config: ConfigStore;
  private readonly pipeline: PipelineDeps;
  private readonly readKey: (path: string) => string;
  private readonly notify: (webhook: string, card: FeishuCard, secret?: string) => Promise<SendResult>;
  private readonly clock: () => number;

  readonly scheduler: Scheduler;
  private runtimes = new Map<number, Runtime>();
  private locks = new Map<string, EnvHolder>();
  private listeners = new Map<number, Set<DeploymentListener>>();
  private finalizing = new Set<Promise<void>>();
  private closing = new Set<number>();
  private shuttingDown = false;

  constructor(deps: ServiceDeps) {
    this.repo = deps.repo;
    this.logs = deps.logs;
    this.config = deps.config;
    this.pipeline = deps.pipeline;
    this.readKey = deps.readKey ?? ((path) => readFileSync(path, "utf8"));
    this.notify = deps.notify ?? ((webhook, card, secret) => sendFeishu(webhook, card, { secret }));
    this.clock = deps.clock ?? Date.now;
    this.scheduler = new Scheduler(this.config.get().server.maxConcurrent);
  }

  // ---------------------------------------------------------------- queries

  status(): ServerStatus {
    return {
      runningEnvs: this.scheduler.runningCount,
      queuedEnvs: this.scheduler.queuedCount,
      activeDeployments: [...this.runtimes.keys()],
      maxConcurrent: this.scheduler.maxConcurrent,
      shuttingDown: this.shuttingDown,
    };
  }

  holderOf(host: string, remotePath: string): EnvHolder | null {
    return this.locks.get(lockKey(host, remotePath)) ?? null;
  }

  configView(): ConfigView {
    const config = this.config.refresh();
    this.scheduler.setMax(config.server.maxConcurrent);
    return {
      countries: config.countries.map((country) => {
        const environments = country.environments.map((env) => {
          const spec = envSpecOf(config, env);
          return {
            ...env,
            remotePath: spec.remotePath,
            busy: this.holderOf(spec.host, spec.remotePath),
            last: this.repo.lastDeployOf(spec.host, spec.remotePath),
          };
        });
        return {
          code: country.code,
          name: country.name,
          environments,
          busyCount: environments.filter((e) => e.busy).length,
        };
      }),
      repos: Object.fromEntries(Object.entries(config.repos).map(([k, v]) => [k, redactUrl(v)])),
      build: config.build,
      maxConcurrent: config.server.maxConcurrent,
      configError: this.config.error,
    };
  }

  plan(countryCode: string, envNames: string[]): PlanResponse {
    const config = this.config.refresh();
    const { country, envs } = this.pick(config, countryCode, envNames);
    const { user, port, keepPrevious } = config.ssh;
    return {
      countryCode: country.code,
      countryName: country.name,
      maxConcurrent: config.server.maxConcurrent,
      envs: envs.map((env) => {
        const spec = envSpecOf(config, env);
        const repoUrl = redactUrl(spec.repoUrl);
        // Built with a shell-safe token so it isn't quoted, then made readable.
        const TS = "TIMESTAMP";
        const staging = stagingDir(spec.server, TS);
        const remote = buildRemoteScript(spec.remotePath, `${staging}/dist.tar.gz`, staging, keepPrevious)
          .split(" && ")
          .map((cmd) => `(远端) ${cmd.replaceAll(TS, "<时间戳>")}`);
        return {
          ...env,
          repoUrl,
          remotePath: spec.remotePath,
          sshTarget: `${user}@${spec.host}:${port}`,
          busy: this.holderOf(spec.host, spec.remotePath),
          steps: [
            { stage: "clone", commands: [`git ${buildCloneArgs(repoUrl, spec.branch, "<临时目录>").join(" ")}`] },
            { stage: "install", commands: [spec.installCmd] },
            { stage: "build", commands: [spec.buildCmd], note: `产物目录：${spec.dist}` },
            {
              stage: "upload",
              commands: [
                `tar ${buildTarArgs(`<临时目录>/${spec.dist}`, `${spec.server}.tar.gz`).join(" ")}`,
                `sftp ${spec.server}.tar.gz → ${user}@${spec.host}:${port}:${staging.replaceAll(TS, "<时间戳>")}/dist.tar.gz`,
                ...remote,
              ],
              note: keepPrevious
                ? `打包 ${spec.dist} → 传到远端 /tmp 暂存 → 解压到 ${spec.dist}.tmp → 原子替换；旧版本保留为 ${spec.dist}.prev`
                : `打包 ${spec.dist} → 传到远端 /tmp 暂存 → 解压到 ${spec.dist}.tmp → 原子替换`,
            },
          ],
        };
      }),
    };
  }

  detail(id: number): DeploymentDetail | null {
    const deployment = this.repo.summary(id);
    if (!deployment) return null;
    const envs = this.repo.envs(id);
    const rt = this.runtimes.get(id);
    let state: ProgressState;
    let lastSeq: number;
    if (rt) {
      state = rt.state;
      lastSeq = rt.seq;
    } else {
      const events = this.repo.events(id);
      state = replayProgress(envs.length, deployment.createdAt, events.map((e) => e.event));
      lastSeq = events.at(-1)?.seq ?? 0;
    }
    return { deployment, envs, state, lastSeq, serverNow: this.clock() };
  }

  list(query: DeploymentListQuery): DeploymentList {
    const pageSize = Math.min(Math.max(query.pageSize ?? 20, 1), 100);
    const page = Math.max(query.page ?? 1, 1);
    const { items, total } = this.repo.list({ ...query, page, pageSize });
    return { items, total, page, pageSize };
  }

  isActive(id: number): boolean {
    return this.runtimes.has(id);
  }

  // Still running, or finished but the final notification / `end` message is
  // not out yet. Event streams wait for `end` while this is true.
  hasPendingEnd(id: number): boolean {
    return this.runtimes.has(id) || this.closing.has(id);
  }

  subscribe(id: number, listener: DeploymentListener): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(id) === set) this.listeners.delete(id);
    };
  }

  // --------------------------------------------------------------- commands

  create(countryCode: string, envNames: string[], operator: Operator, retryOf: number | null = null): CreatedDeployment {
    if (this.shuttingDown) throw new ServiceError("SHUTTING_DOWN", 503, "服务正在停止，暂不接受新的发布");

    let config: AppConfig;
    try {
      config = this.config.reload();
    } catch (e) {
      throw new ServiceError("CONFIG_INVALID", 422, `配置校验失败，已拒绝发起：${e instanceof Error ? e.message : String(e)}`);
    }
    this.scheduler.setMax(config.server.maxConcurrent);

    const { country, envs } = this.pick(config, countryCode, envNames);
    const specs = envs.map((env) => envSpecOf(config, env));

    const seen = new Map<string, string>();
    for (const spec of specs) {
      const key = lockKey(spec.host, spec.remotePath);
      const other = seen.get(key);
      if (other) throw new ServiceError("BAD_REQUEST", 400, `环境「${other}」和「${spec.name}」发布到同一个目录，不能同时发布`);
      seen.set(key, spec.name);
    }

    const busy: EnvBusyDetail[] = [];
    for (const spec of specs) {
      const holder = this.holderOf(spec.host, spec.remotePath);
      if (holder) busy.push({ ...holder, requestedEnv: spec.name });
    }
    if (busy.length) {
      const desc = busy.map((b) => `「${b.requestedEnv}」被 #${b.deploymentId} 占用`).join("，");
      throw new ServiceError("ENV_BUSY", 409, `${desc}，请等它结束后再发布`, busy);
    }

    let privateKey: string;
    try {
      privateKey = this.readKey(config.ssh.privateKeyPath);
    } catch (e) {
      throw new ServiceError("CONFIG_INVALID", 422, `无法读取 SSH 私钥 ${config.ssh.privateKeyPath}：${e instanceof Error ? e.message : String(e)}`);
    }

    const now = this.clock();
    const id = this.repo.createDeployment({
      countryCode: country.code,
      countryName: country.name,
      operatorIp: operator.ip,
      operatorName: operator.name,
      userAgent: operator.userAgent,
      retryOf,
      createdAt: now,
      envs: specs,
    });

    const rt: Runtime = {
      id,
      countryName: country.name,
      specs,
      creds: { user: config.ssh.user, port: config.ssh.port, privateKey, keepPrevious: config.ssh.keepPrevious },
      state: initialProgressState(specs.length, now),
      seq: 0,
      status: "queued",
      started: false,
      controllers: new Map(),
      interrupted: new Set(),
    };
    this.runtimes.set(id, rt);
    specs.forEach((spec, idx) => {
      this.locks.set(lockKey(spec.host, spec.remotePath), { deploymentId: id, envIdx: idx, envName: spec.name });
      this.scheduler.enqueue({ id: jobId(id, idx), run: () => this.runEnv(rt, idx) });
    });
    console.log(`[deploy] #${id} ${country.name} × ${specs.length} by ${operator.name ?? "-"} (${operator.ip})`);
    return { id };
  }

  retry(id: number, operator: Operator): CreatedDeployment {
    const summary = this.repo.summary(id);
    if (!summary) throw new ServiceError("NOT_FOUND", 404, `任务 #${id} 不存在`);
    const failed = this.repo.envs(id).filter((e) => e.status === "error" || e.status === "cancelled" || e.status === "interrupted");
    if (failed.length === 0) throw new ServiceError("BAD_REQUEST", 400, `任务 #${id} 没有失败、取消或中断的环境`);
    return this.create(summary.countryCode, failed.map((e) => e.envName), operator, id);
  }

  cancel(id: number, envIdx?: number): CancelResult {
    const summary = this.repo.summary(id);
    if (!summary) throw new ServiceError("NOT_FOUND", 404, `任务 #${id} 不存在`);
    const rt = this.runtimes.get(id);
    if (!rt) throw new ServiceError("NOTHING_TO_CANCEL", 409, `任务 #${id} 已经结束`);
    if (envIdx !== undefined && !rt.specs[envIdx]) throw new ServiceError("NOT_FOUND", 404, `任务 #${id} 没有序号为 ${envIdx} 的环境`);

    const targets = envIdx === undefined ? rt.specs.map((_, i) => i) : [envIdx];
    let cancelled = 0;
    for (const idx of targets) {
      if (isTaskSettled(rt.state.tasks[idx]!.status)) continue;
      if (this.scheduler.dequeue(jobId(id, idx))) {
        this.settleEnv(rt, idx, { type: "envCancelled", index: idx, at: this.clock() }, { status: "cancelled", finishedAt: this.clock() });
        cancelled++;
      } else {
        const ctl = rt.controllers.get(idx);
        if (ctl && !ctl.signal.aborted) {
          ctl.abort();
          cancelled++;
        }
      }
    }
    if (cancelled === 0) {
      throw new ServiceError("NOTHING_TO_CANCEL", 409, envIdx === undefined ? `任务 #${id} 没有可以取消的环境` : "该环境已经结束");
    }
    this.maybeFinish(rt);
    return { cancelled };
  }

  // Startup: anything the database still thinks is queued/running was killed
  // with the previous process. Mark it interrupted so locks and UI are consistent.
  recover(): number[] {
    const ids = this.repo.activeDeploymentIds();
    const now = this.clock();
    for (const id of ids) {
      const envs = this.repo.envs(id);
      let seq = this.repo.lastSeq(id);
      this.repo.transaction(() => {
        for (const env of envs) {
          if (env.status !== "queued" && env.status !== "running") continue;
          this.repo.appendEvent(id, ++seq, { type: "envInterrupted", index: env.idx, at: now });
          this.repo.updateEnv(id, env.idx, {
            status: "interrupted",
            finishedAt: now,
            errorSummary: "服务重启，执行被中断",
            totalMs: env.startedAt ? now - env.startedAt : null,
          });
        }
        const statuses = this.repo.envs(id).map((e) => e.status);
        this.repo.updateDeployment(id, { status: deploymentStatusOf(statuses), finishedAt: now, notifyStatus: "skipped", notifyError: "服务重启，未推送" });
      });
    }
    if (ids.length) console.warn(`[deploy] marked ${ids.length} unfinished deployment(s) as interrupted: ${ids.map((i) => `#${i}`).join(" ")}`);
    return ids;
  }

  // Graceful stop: refuse new work, interrupt what is still queued, wait for
  // running envs up to `timeoutMs`, then abort the stragglers.
  async shutdown(timeoutMs: number): Promise<void> {
    this.shuttingDown = true;
    for (const rt of this.runtimes.values()) {
      rt.specs.forEach((_, idx) => {
        if (this.scheduler.dequeue(jobId(rt.id, idx))) {
          this.settleEnv(rt, idx, { type: "envInterrupted", index: idx, at: this.clock() }, {
            status: "interrupted",
            finishedAt: this.clock(),
            errorSummary: "服务停止，执行被中断",
          });
        }
      });
      this.maybeFinish(rt);
    }
    const deadline = Date.now() + timeoutMs;
    while (this.scheduler.runningCount > 0 && Date.now() < deadline) {
      await Bun.sleep(250);
    }
    if (this.scheduler.runningCount > 0) {
      for (const rt of this.runtimes.values()) {
        for (const [idx, ctl] of rt.controllers) {
          rt.interrupted.add(idx);
          ctl.abort();
        }
      }
      const hardDeadline = Date.now() + 15_000;
      while (this.scheduler.runningCount > 0 && Date.now() < hardDeadline) await Bun.sleep(100);
    }
    await this.idle();
  }

  // Resolves once pending notifications have been sent (tests, shutdown).
  async idle(): Promise<void> {
    while (this.finalizing.size) await Promise.all([...this.finalizing]);
  }

  // Deletes finished deployments (and their logs) older than the retention window.
  cleanupOld(): number {
    const days = this.config.get().server.logRetentionDays;
    const ids = this.repo.deleteFinishedBefore(this.clock() - days * 24 * 3600 * 1000);
    for (const id of ids) this.logs.removeDeployment(id);
    return ids.length;
  }

  // ------------------------------------------------------------- internals

  private pick(config: AppConfig, countryCode: string, envNames: string[]) {
    const country = findCountry(config, countryCode);
    if (!country) throw new ServiceError("NOT_FOUND", 404, `国家 ${countryCode} 不存在`);
    const names = [...new Set(envNames)];
    if (names.length === 0) throw new ServiceError("BAD_REQUEST", 400, "至少选择一个环境");
    const missing = names.filter((n) => !country.environments.some((e) => e.name === n));
    if (missing.length) {
      throw new ServiceError("NOT_FOUND", 404, `${country.name} 下没有这些环境：${missing.join("、")}（可能已从配置中移除）`, { missing });
    }
    // Keep config order so the task list matches the picker.
    const envs: Environment[] = country.environments.filter((e) => names.includes(e.name));
    return { country, envs };
  }

  private publish(id: number, msg: DeploymentMessage): void {
    for (const listener of this.listeners.get(id) ?? []) {
      try {
        listener(msg);
      } catch {
        // a broken subscriber must not affect the deployment
      }
    }
  }

  private emit(rt: Runtime, event: ProgressEvent): void {
    const seq = ++rt.seq;
    this.repo.appendEvent(rt.id, seq, event);
    rt.state = reduceProgress(rt.state, event);
    this.publish(rt.id, { type: "progress", seq, event });
  }

  private log(rt: Runtime, idx: number, stage: Stage | undefined, stream: LogStream, text: string): void {
    this.logs.append(rt.id, idx, { ts: this.clock(), stream, ...(stage ? { stage } : {}), text });
  }

  private refreshStatus(rt: Runtime): void {
    const status = deploymentStatusOf(rt.state.tasks.map((t) => t.status));
    if (status === rt.status) return;
    rt.status = status;
    this.repo.updateDeployment(rt.id, { status });
    const summary = this.repo.summary(rt.id);
    if (summary) this.publish(rt.id, { type: "deployment", summary });
  }

  // Records the final event of one env, persists its row, frees its lock.
  private settleEnv(rt: Runtime, idx: number, event: ProgressEvent, patch: Parameters<Repository["updateEnv"]>[2]): void {
    this.repo.transaction(() => {
      this.emit(rt, event);
      this.repo.updateEnv(rt.id, idx, patch);
    });
    const spec = rt.specs[idx]!;
    const key = lockKey(spec.host, spec.remotePath);
    if (this.locks.get(key)?.deploymentId === rt.id) this.locks.delete(key);
    this.logs.end(rt.id, idx);
    this.refreshStatus(rt);
  }

  private async runEnv(rt: Runtime, idx: number): Promise<void> {
    const spec = rt.specs[idx]!;
    const ctl = new AbortController();
    rt.controllers.set(idx, ctl);
    const startedAt = this.clock();
    this.repo.updateEnv(rt.id, idx, { status: "running", startedAt });

    let outcome: EnvOutcome;
    try {
      this.log(rt, idx, undefined, "system", `开始发布 ${spec.name} · 分支 ${spec.branch} → ${spec.host}:${spec.remotePath}`);
      outcome = await runPipeline(
        spec,
        rt.creds,
        this.pipeline,
        {
          onPipelineStart: () => {
            this.emit(rt, { type: "pipelineStart", index: idx, at: this.clock() });
            if (!rt.started) {
              rt.started = true;
              this.repo.updateDeployment(rt.id, { startedAt: this.clock() });
            }
            this.refreshStatus(rt);
          },
          onStageStart: (stage) => this.emit(rt, { type: "stageStart", index: idx, stage, at: this.clock() }),
          onStageDone: (stage, ms) => this.emit(rt, { type: "stageDone", index: idx, stage, ms, at: this.clock() }),
          onCommit: (commit) => {
            this.emit(rt, { type: "commit", index: idx, sha: commit.sha, message: commit.message, at: this.clock() });
            this.repo.updateEnv(rt.id, idx, { commitSha: commit.sha, commitMessage: commit.message });
          },
          onLog: (stage, stream, text) => this.log(rt, idx, stage, stream, text),
        },
        ctl.signal,
      );
    } catch (e) {
      // runPipeline never throws; this only guards bugs in the hooks above.
      outcome = { ok: false, stages: [], failedStage: "clone", error: e instanceof Error ? e.message : String(e), totalMs: this.clock() - startedAt };
    } finally {
      rt.controllers.delete(idx);
    }

    const finishedAt = this.clock();
    const base = {
      finishedAt,
      totalMs: outcome.totalMs,
      commitSha: outcome.commit?.sha ?? null,
      commitMessage: outcome.commit?.message ?? null,
      failedStage: outcome.ok ? null : (outcome.failedStage ?? null),
    };
    if (rt.interrupted.has(idx)) {
      this.log(rt, idx, undefined, "system", "! 服务停止，执行被中断");
      this.settleEnv(rt, idx, { type: "envInterrupted", index: idx, at: finishedAt }, { ...base, status: "interrupted", errorSummary: "服务停止，执行被中断" });
    } else {
      const status = outcome.ok ? "done" : outcome.cancelled ? "cancelled" : "error";
      const summary = outcome.ok ? "✔ 发布成功" : outcome.cancelled ? "■ 已取消" : "✗ 发布失败";
      this.log(rt, idx, undefined, "system", summary);
      this.settleEnv(rt, idx, { type: "pipelineDone", index: idx, outcome, at: finishedAt }, {
        ...base,
        status,
        errorSummary: status === "error" ? errorSummary(outcome.error) : null,
      });
    }
    this.maybeFinish(rt);
  }

  private maybeFinish(rt: Runtime): void {
    if (!this.runtimes.has(rt.id)) return;
    if (!rt.state.tasks.every((t) => isTaskSettled(t.status))) return;
    this.closing.add(rt.id);
    this.runtimes.delete(rt.id);
    this.refreshStatus(rt);
    const finishedAt = this.clock();
    this.repo.updateDeployment(rt.id, { finishedAt });
    const p = this.finalize(rt).finally(() => this.finalizing.delete(p));
    this.finalizing.add(p);
  }

  private async finalize(rt: Runtime): Promise<void> {
    const config = this.config.get();
    const feishu = config.notify?.feishu;
    const summary = this.repo.summary(rt.id)!;
    if (feishu?.webhook) {
      const input = buildCardInput(summary, this.repo.envs(rt.id), config.server.publicUrl);
      const res = await this.notify(feishu.webhook, buildFeishuCard(input), feishu.secret).catch(
        (e): SendResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
      this.repo.updateDeployment(rt.id, { notifyStatus: res.ok ? "sent" : "failed", notifyError: res.ok ? null : (res.error ?? "未知错误") });
      if (!res.ok) console.warn(`[deploy] #${rt.id} 飞书通知发送失败：${res.error}`);
    } else {
      this.repo.updateDeployment(rt.id, { notifyStatus: "skipped", notifyError: null });
    }
    const final = this.repo.summary(rt.id);
    this.closing.delete(rt.id);
    if (final) this.publish(rt.id, { type: "deployment", summary: final });
    this.publish(rt.id, { type: "end" });
    console.log(`[deploy] #${rt.id} finished: ${final?.status} (${final?.doneCount}/${final?.envCount})`);
  }
}
