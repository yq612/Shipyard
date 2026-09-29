import type {
  DeploymentStatus,
  ProgressEvent,
  ProgressState,
  ProgressTask,
  Stage,
  StageStatus,
  TaskStatus,
} from "./types.ts";

export const STAGES: readonly Stage[] = ["clone", "install", "build", "upload"];

export const STAGE_NAMES: Record<Stage, string> = {
  clone: "克隆代码",
  install: "安装依赖",
  build: "构建产物",
  upload: "上传发布",
};

export const TASK_STATUS_NAMES: Record<TaskStatus, string> = {
  queued: "排队中",
  running: "执行中",
  done: "成功",
  error: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

export const DEPLOYMENT_STATUS_NAMES: Record<DeploymentStatus, string> = {
  queued: "排队中",
  running: "执行中",
  succeeded: "全部成功",
  partial: "部分成功",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

const SETTLED: ReadonlySet<TaskStatus> = new Set(["done", "error", "cancelled", "interrupted"]);

export function isTaskSettled(status: TaskStatus): boolean {
  return SETTLED.has(status);
}

export function isDeploymentActive(status: DeploymentStatus): boolean {
  return status === "queued" || status === "running";
}

function emptyStageState(): Record<Stage, StageStatus> {
  return { clone: "pending", install: "pending", build: "pending", upload: "pending" };
}

export function initialProgressState(taskCount: number, startedAt: number): ProgressState {
  return {
    tasks: Array.from({ length: taskCount }, () => ({
      status: "queued" as const,
      stages: emptyStageState(),
      stageDurations: {},
    })),
    startedAt,
    version: 0,
  };
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

// One-line form of arbitrary process output, for table cells and tooltips.
export function sanitizeText(text: string): string {
  return stripAnsi(text).replace(/[\r\n\t]+/g, " ").trim();
}

// Marks every stage after `from` that never ran as skipped.
function skipAfter(task: ProgressTask, from: Stage): void {
  for (let i = STAGES.indexOf(from) + 1; i < STAGES.length; i++) {
    const stage = STAGES[i]!;
    if (task.stages[stage] === "pending" || task.stages[stage] === "running") task.stages[stage] = "skipped";
  }
}

// Stops a task that never finished on its own (cancelled / interrupted): the
// stage that was running takes `mark`, the rest are skipped.
function haltTask(task: ProgressTask, status: TaskStatus, mark: StageStatus, at: number): void {
  task.status = status;
  task.endedAt ??= at;
  const running = STAGES.find((stage) => task.stages[stage] === "running");
  if (running) task.stages[running] = mark;
  for (const stage of STAGES) {
    if (task.stages[stage] === "pending") task.stages[stage] = "skipped";
  }
}

export function reduceProgress(state: ProgressState, event: ProgressEvent): ProgressState {
  const current = state.tasks[event.index];
  if (!current) return state;
  const task: ProgressTask = {
    ...current,
    stages: { ...current.stages },
    stageDurations: { ...current.stageDurations },
  };

  switch (event.type) {
    case "pipelineStart":
      task.status = "running";
      task.startedAt ??= event.at;
      break;
    case "stageStart":
      task.status = "running";
      task.startedAt ??= event.at;
      task.currentStage = event.stage;
      task.stages[event.stage] = "running";
      break;
    case "stageDone":
      task.currentStage = event.stage;
      task.stages[event.stage] = "done";
      task.stageDurations[event.stage] = event.ms;
      break;
    case "stageError":
      task.status = "error";
      task.currentStage = event.stage;
      task.stages[event.stage] = "error";
      task.stageDurations[event.stage] = event.ms;
      task.error = stripAnsi(event.error).trim() || "未知错误";
      task.endedAt = event.at;
      skipAfter(task, event.stage);
      break;
    case "commit":
      task.commit = { sha: event.sha, message: event.message };
      break;
    case "pipelineDone": {
      const { outcome } = event;
      for (const item of outcome.stages) {
        task.stages[item.stage] = "done";
        task.stageDurations[item.stage] = item.durationMs;
      }
      if (outcome.commit) task.commit = outcome.commit;
      task.endedAt = event.at;
      task.startedAt ??= event.at - outcome.totalMs;
      if (outcome.ok) {
        task.status = "done";
        task.currentStage = "upload";
        task.error = undefined;
      } else if (outcome.cancelled) {
        if (outcome.failedStage) {
          task.currentStage = outcome.failedStage;
          task.stages[outcome.failedStage] = "cancelled";
        }
        haltTask(task, "cancelled", "cancelled", event.at);
        task.error = undefined;
      } else {
        const failedStage = outcome.failedStage ?? "clone";
        task.status = "error";
        task.currentStage = failedStage;
        task.stages[failedStage] = "error";
        task.error = stripAnsi(outcome.error ?? "").trim() || "未知错误";
        skipAfter(task, failedStage);
      }
      break;
    }
    case "envCancelled":
      if (isTaskSettled(task.status)) return state;
      haltTask(task, "cancelled", "cancelled", event.at);
      break;
    case "envInterrupted":
      if (isTaskSettled(task.status)) return state;
      haltTask(task, "interrupted", "error", event.at);
      task.error = "服务重启，执行被中断";
      break;
  }

  const tasks = state.tasks.slice();
  tasks[event.index] = task;
  return { ...state, tasks, version: state.version + 1 };
}

export function replayProgress(taskCount: number, startedAt: number, events: Iterable<ProgressEvent>): ProgressState {
  let state = initialProgressState(taskCount, startedAt);
  for (const event of events) state = reduceProgress(state, event);
  return state;
}

export interface StageTotals {
  pending: number;
  running: number;
  done: number;
  error: number;
  cancelled: number;
  skipped: number;
  total: number;
}

export function stageTotals(state: ProgressState, stage: Stage): StageTotals {
  const totals: StageTotals = { pending: 0, running: 0, done: 0, error: 0, cancelled: 0, skipped: 0, total: state.tasks.length };
  for (const task of state.tasks) totals[task.stages[stage]]++;
  return totals;
}

export type TaskCounts = Record<TaskStatus, number> & { total: number };

export function taskCounts(state: ProgressState): TaskCounts {
  const counts: TaskCounts = { queued: 0, running: 0, done: 0, error: 0, cancelled: 0, interrupted: 0, total: state.tasks.length };
  for (const task of state.tasks) counts[task.status]++;
  return counts;
}

export function completedStageCount(task: ProgressTask): number {
  return STAGES.filter((stage) => task.stages[stage] === "done").length;
}

export function taskElapsed(task: ProgressTask, now: number): number {
  if (task.startedAt === undefined) return 0;
  return Math.max(0, (task.endedAt ?? now) - task.startedAt);
}

// The deployment's status is a pure function of its environments' statuses.
export function deploymentStatusOf(statuses: readonly TaskStatus[]): DeploymentStatus {
  const count = (s: TaskStatus) => statuses.filter((x) => x === s).length;
  const total = statuses.length;
  const queued = count("queued");
  const done = count("done");
  if (total === 0) return "cancelled";
  if (queued === total) return "queued";
  if (queued > 0 || count("running") > 0) return "running";
  if (done === total) return "succeeded";
  if (done > 0) return "partial";
  if (count("interrupted") > 0) return "interrupted";
  if (count("error") > 0) return "failed";
  return "cancelled";
}

export function deriveDeploymentStatus(state: ProgressState): DeploymentStatus {
  return deploymentStatusOf(state.tasks.map((task) => task.status));
}
