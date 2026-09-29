// HTTP / SSE contract between apps/server and apps/web.
import type {
  DeploymentStatus,
  Environment,
  LogLine,
  NotifyStatus,
  ProgressEvent,
  ProgressState,
  Stage,
  TaskStatus,
} from "./types.ts";

export type ErrorCode =
  | "IP_NOT_ALLOWED"
  | "ORIGIN_REJECTED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "ENV_BUSY"
  | "CONFIG_INVALID"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "NOTHING_TO_CANCEL"
  | "SHUTTING_DOWN"
  | "INTERNAL";

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export interface WhoAmI {
  ip: string;
  allowed: boolean;
  protectReads: boolean;
}

export interface ServerStatus {
  runningEnvs: number;
  queuedEnvs: number;
  activeDeployments: number[];
  maxConcurrent: number;
  shuttingDown: boolean;
}

// Who is holding an environment's lock right now.
export interface EnvHolder {
  deploymentId: number;
  envIdx: number;
  envName: string;
}

export interface EnvBusyDetail extends EnvHolder {
  requestedEnv: string;
}

export interface EnvLastDeploy {
  deploymentId: number;
  status: TaskStatus;
  startedAt: number | null;
  finishedAt: number | null;
  commitSha: string | null;
  failedStage: Stage | null;
}

export interface EnvView extends Environment {
  remotePath: string;
  busy: EnvHolder | null;
  last: EnvLastDeploy | null;
}

export interface CountryView {
  code: string;
  name: string;
  environments: EnvView[];
  busyCount: number;
}

export interface ConfigView {
  countries: CountryView[];
  repos: Record<string, string>; // credentials redacted
  build: { install: string; build: string; dist: string };
  maxConcurrent: number;
  // Set when config.yaml currently fails validation; the view then shows the
  // last good config and new deployments are refused.
  configError: string | null;
}

export interface PlanRequest {
  countryCode: string;
  envNames: string[];
}

export interface PlanStep {
  stage: Stage;
  commands: string[];
  note?: string;
}

export interface PlanEnv extends Environment {
  repoUrl: string; // credentials redacted
  remotePath: string;
  sshTarget: string; // user@host:port
  busy: EnvHolder | null;
  steps: PlanStep[];
}

export interface PlanResponse {
  countryCode: string;
  countryName: string;
  maxConcurrent: number;
  envs: PlanEnv[];
}

export interface CreateDeploymentRequest {
  countryCode: string;
  envNames: string[];
  operatorName?: string;
}

export interface RetryDeploymentRequest {
  operatorName?: string;
}

export interface CreatedDeployment {
  id: number;
}

export interface CancelResult {
  cancelled: number;
}

export interface DeploymentSummary {
  id: number;
  countryCode: string;
  countryName: string;
  status: DeploymentStatus;
  operatorName: string | null;
  operatorIp: string;
  retryOf: number | null;
  notifyStatus: NotifyStatus | null;
  notifyError: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  envNames: string[];
  envCount: number;
  doneCount: number;
  failedCount: number; // error + interrupted
  cancelledCount: number;
}

export interface DeploymentEnvView {
  idx: number;
  envName: string;
  branch: string;
  server: string;
  host: string;
  repoKey: string;
  repoUrl: string; // credentials redacted
  remotePath: string;
  installCmd: string;
  buildCmd: string;
  dist: string;
  status: TaskStatus;
  failedStage: Stage | null;
  errorSummary: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  totalMs: number | null;
}

export interface DeploymentDetail {
  deployment: DeploymentSummary;
  envs: DeploymentEnvView[];
  state: ProgressState;
  lastSeq: number;
  serverNow: number;
}

export interface DeploymentListQuery {
  page?: number;
  pageSize?: number;
  country?: string;
  env?: string;
  status?: DeploymentStatus;
  from?: number;
  to?: number;
}

export interface DeploymentList {
  items: DeploymentSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface LogChunk {
  lines: LogLine[];
  offset: number;
  nextOffset: number;
  total: number;
  done: boolean; // the log is closed; no more lines will be appended
}

// ---- SSE payloads ----
// /api/deployments/:id/events
//   event: snapshot   data: DeploymentDetail        (always first, also after reconnect)
//   event: progress   data: ProgressMessage         (id = event seq)
//   event: deployment data: DeploymentSummary       (status / notify changes)
//   event: end        data: {}                      (deployment finished; client should close)
export interface ProgressMessage {
  seq: number;
  event: ProgressEvent;
}

// /api/deployments/:id/envs/:idx/logs?follow=1
//   event: tail  data: LogTail     (first message: the last lines so far)
//   event: lines data: LogLine[]   (new lines, batched)
//   event: end   data: {}          (the log is closed)
export interface LogTail {
  lines: LogLine[];
  skipped: number; // lines before the tail that were not sent
}
