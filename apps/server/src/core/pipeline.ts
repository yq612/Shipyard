import type { CommitInfo, EnvOutcome, LogStream, Stage, StageResult } from "@shipyard/shared";
import { STAGE_NAMES, formatDuration, shortSha } from "@shipyard/shared";
import { CancelledError } from "./process.ts";
import type { EnvSpec, LogFn, SshCredentials, UploadTarget } from "./types.ts";

export function buildUploadTarget(spec: EnvSpec, creds: SshCredentials): UploadTarget {
  return { ...creds, host: spec.host, server: spec.server, remotePath: spec.remotePath };
}

export interface StageContext {
  signal: AbortSignal;
  log: LogFn;
}

export interface PipelineDeps {
  clone: (repoUrl: string, branch: string, dest: string, ctx: StageContext) => Promise<void>;
  headCommit: (dir: string, ctx: StageContext) => Promise<CommitInfo | undefined>;
  runInstall: (cwd: string, installCmd: string, ctx: StageContext) => Promise<void>;
  runBuild: (cwd: string, buildCmd: string, dist: string, ctx: StageContext) => Promise<{ distPath: string }>;
  upload: (distPath: string, target: UploadTarget, ctx: StageContext) => Promise<void>;
  mkdtemp: () => Promise<string>;
  rmrf: (p: string) => Promise<void>;
  now: () => number; // monotonic clock, only used for durations
}

export interface PipelineHooks {
  onPipelineStart?: () => void;
  onStageStart?: (stage: Stage) => void;
  onStageDone?: (stage: Stage, ms: number) => void;
  onStageError?: (stage: Stage, ms: number, err: string) => void;
  onCommit?: (commit: CommitInfo) => void;
  onLog?: (stage: Stage | undefined, stream: LogStream, text: string) => void;
}

function notify(hook: (() => void) | undefined): void {
  // Progress reporting is observational: a reporting failure must never turn a
  // successful deployment into a failed one.
  try {
    hook?.();
  } catch {
    // Deliberately ignored. The pipeline outcome is the source of truth.
  }
}

// Runs clone → install → build → upload for one environment. Never throws:
// failures and cancellation are folded into the returned outcome.
export async function runPipeline(
  spec: EnvSpec,
  creds: SshCredentials,
  deps: PipelineDeps,
  hooks: PipelineHooks = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<EnvOutcome> {
  const start = deps.now();
  notify(hooks.onPipelineStart);
  // Only COMPLETED stages are recorded here; on failure the stage is reported
  // via `failedStage`/`error`, not appended to `stages`.
  const stages: StageResult[] = [];
  const target = buildUploadTarget(spec, creds);

  let tmp: string | null = null;
  let failedStage: Stage | undefined;
  let error: string | undefined;
  let cancelled = false;
  let commit: CommitInfo | undefined;

  const logFor = (stage: Stage | undefined): LogFn => (stream, text) => notify(() => hooks.onLog?.(stage, stream, text));

  const step = async (stage: Stage, fn: (ctx: StageContext) => Promise<void>): Promise<boolean> => {
    if (signal.aborted) {
      cancelled = true;
      failedStage = stage;
      error = "已取消";
      return false;
    }
    const log = logFor(stage);
    const t0 = deps.now();
    notify(() => hooks.onStageStart?.(stage));
    log("system", `▶ ${STAGE_NAMES[stage]}`);
    try {
      await fn({ signal, log });
      const ms = deps.now() - t0;
      stages.push({ stage, durationMs: ms });
      notify(() => hooks.onStageDone?.(stage, ms));
      log("system", `✔ ${STAGE_NAMES[stage]}完成（${formatDuration(ms)}）`);
      return true;
    } catch (e) {
      const ms = deps.now() - t0;
      failedStage = stage;
      if (e instanceof CancelledError || signal.aborted) {
        cancelled = true;
        error = "已取消";
        log("system", `■ ${STAGE_NAMES[stage]}已取消（${formatDuration(ms)}）`);
      } else {
        error = e instanceof Error ? e.message : String(e);
        log("system", `✗ ${STAGE_NAMES[stage]}失败（${formatDuration(ms)}）`);
        notify(() => hooks.onStageError?.(stage, ms, error!));
      }
      return false;
    }
  };

  try {
    tmp = await deps.mkdtemp();
    let distPath = "";
    const cont =
      (await step("clone", async (ctx) => {
        await deps.clone(spec.repoUrl, spec.branch, tmp!, ctx);
        commit = await deps.headCommit(tmp!, ctx).catch(() => undefined);
        if (commit) {
          const c = commit;
          notify(() => hooks.onCommit?.(c));
          ctx.log("system", `提交 ${shortSha(c.sha)}「${c.message}」`);
        }
      })) &&
      (await step("install", (ctx) => deps.runInstall(tmp!, spec.installCmd, ctx))) &&
      (await step("build", async (ctx) => {
        const r = await deps.runBuild(tmp!, spec.buildCmd, spec.dist, ctx);
        distPath = r.distPath;
      }));
    if (cont) {
      await step("upload", (ctx) => deps.upload(distPath, target, ctx));
    }
  } catch (e) {
    // Failure creating the temp dir (before any stage) — record as a clone-stage failure.
    failedStage = failedStage ?? "clone";
    error = error ?? (e instanceof Error ? e.message : String(e));
    logFor(undefined)("system", `✗ 准备临时目录失败：${error}`);
  } finally {
    if (tmp) await deps.rmrf(tmp).catch(() => {});
  }

  const ok = failedStage === undefined;
  return {
    ok,
    stages,
    ...(failedStage ? { failedStage } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(cancelled ? { cancelled } : {}),
    ...(commit ? { commit } : {}),
    totalMs: deps.now() - start,
  };
}
