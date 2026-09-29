// Types shared by the server and the browser. Nothing in this package may import
// `node:*` or any terminal/UI library — it has to run unchanged in both places.

export type Stage = "clone" | "install" | "build" | "upload";

export interface Environment {
  name: string;
  branch: string;
  server: string;
  host: string;
  repo: string; // key into the config's repos map
}

export interface Country {
  name: string;
  code: string;
  environments: Environment[];
}

export interface StageResult {
  stage: Stage;
  durationMs: number;
}

export interface CommitInfo {
  sha: string;
  message: string;
}

// What runPipeline returns for one environment. It never throws: failures,
// including cancellation, are folded into this value.
export interface EnvOutcome {
  ok: boolean;
  // Only COMPLETED stages are recorded; the failing stage is `failedStage`.
  stages: StageResult[];
  failedStage?: Stage;
  error?: string;
  cancelled?: boolean;
  commit?: CommitInfo;
  totalMs: number;
}

// Per-environment status inside one deployment.
export type TaskStatus = "queued" | "running" | "done" | "error" | "cancelled" | "interrupted";
export type StageStatus = "pending" | "running" | "done" | "error" | "cancelled" | "skipped";

export type DeploymentStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled"
  | "interrupted";

export type NotifyStatus = "sent" | "failed" | "skipped";

// Progress is an append-only stream of these events. Replaying them through
// `reduceProgress` yields the UI state at any point, on the server and in the
// browser alike. `at` is wall-clock milliseconds (Date.now()).
export type ProgressEvent =
  | { type: "pipelineStart"; index: number; at: number }
  | { type: "stageStart"; index: number; stage: Stage; at: number }
  | { type: "stageDone"; index: number; stage: Stage; ms: number; at: number }
  | { type: "stageError"; index: number; stage: Stage; ms: number; error: string; at: number }
  | { type: "commit"; index: number; sha: string; message: string; at: number }
  | { type: "pipelineDone"; index: number; outcome: EnvOutcome; at: number }
  | { type: "envCancelled"; index: number; at: number } // cancelled before it left the queue
  | { type: "envInterrupted"; index: number; at: number }; // the server restarted mid-flight

export interface ProgressTask {
  status: TaskStatus;
  currentStage?: Stage;
  stages: Record<Stage, StageStatus>;
  stageDurations: Partial<Record<Stage, number>>;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  commit?: CommitInfo;
}

export interface ProgressState {
  tasks: ProgressTask[];
  startedAt: number;
  version: number;
}

export type LogStream = "stdout" | "stderr" | "system";

export interface LogLine {
  ts: number;
  stream: LogStream;
  stage?: Stage;
  text: string;
}
