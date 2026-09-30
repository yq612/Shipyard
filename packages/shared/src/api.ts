// HTTP / SSE contract between apps/server and apps/web.
import type {
  DeploymentStatus,
  Environment,
  Grouping,
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
  node: string | null; // runtimes.node label; null = the image's node
  busy: EnvHolder | null;
  last: EnvLastDeploy | null;
}

export interface CountryView {
  code: string;
  name: string;
  environments: EnvView[];
  busyCount: number;
}

export interface ProjectView {
  key: string;
  name: string;
  grouping: Grouping;
  countries: CountryView[]; // grouping "country"
  environments: EnvView[]; // grouping "none"; see projectEnvs() for every environment
  envCount: number;
  busyCount: number;
  // Set when the project's file fails validation: the view shows its last good
  // environments (if any) and new deployments of it are refused.
  error: string | null;
}

export interface ConfigView {
  projects: ProjectView[];
  maxConcurrent: number;
  // Set when config.yaml itself fails validation; the view then shows the
  // last good config and new deployments are refused.
  configError: string | null;
}

// A deployment targets environments of one project, and for projects grouped
// by country, of one country (`countryCode`; omitted otherwise).
export interface PlanRequest {
  project: string;
  countryCode?: string | null;
  envNames: string[];
}

export interface PlanStep {
  stage: Stage;
  commands: string[];
  note?: string;
}

export interface PlanEnv extends Environment {
  repoUrl: string; // credentials redacted
  node: string | null;
  sshTarget: string; // user@host:port
  busy: EnvHolder | null;
  steps: PlanStep[];
}

export interface PlanResponse {
  project: string;
  projectName: string;
  countryCode: string | null;
  countryName: string | null;
  maxConcurrent: number;
  envs: PlanEnv[];
}

export interface CreateDeploymentRequest extends PlanRequest {
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
  projectKey: string;
  projectName: string;
  countryCode: string | null; // null for projects without countries
  countryName: string | null;
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
  node: string | null;
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
  project?: string;
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
