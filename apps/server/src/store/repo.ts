import type { Database } from "bun:sqlite";
import type {
  DeploymentEnvView,
  DeploymentListQuery,
  DeploymentStatus,
  DeploymentSummary,
  EnvLastDeploy,
  NotifyStatus,
  ProgressEvent,
  Stage,
  TaskStatus,
} from "@shipyard/shared";
import { redactUrl } from "@shipyard/shared";
import type { EnvSpec } from "../core/types.ts";

export interface NewDeployment {
  projectKey: string;
  projectName: string;
  countryCode: string | null;
  countryName: string | null;
  operatorIp: string;
  operatorName: string | null;
  userAgent: string | null;
  retryOf: number | null;
  createdAt: number;
  envs: EnvSpec[];
}

export interface DeploymentPatch {
  status?: DeploymentStatus;
  startedAt?: number | null;
  finishedAt?: number | null;
  notifyStatus?: NotifyStatus | null;
  notifyError?: string | null;
}

export interface EnvPatch {
  status?: TaskStatus;
  failedStage?: Stage | null;
  errorSummary?: string | null;
  commitSha?: string | null;
  commitMessage?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  totalMs?: number | null;
}

export interface StoredEvent {
  seq: number;
  event: ProgressEvent;
}

const SUMMARY_SELECT = `
  SELECT d.*,
    (SELECT json_group_array(env_name) FROM (SELECT env_name FROM deployment_envs WHERE deployment_id = d.id ORDER BY idx)) AS env_names,
    (SELECT count(*) FROM deployment_envs WHERE deployment_id = d.id) AS env_count,
    (SELECT count(*) FROM deployment_envs WHERE deployment_id = d.id AND status = 'done') AS done_count,
    (SELECT count(*) FROM deployment_envs WHERE deployment_id = d.id AND status IN ('error', 'interrupted')) AS failed_count,
    (SELECT count(*) FROM deployment_envs WHERE deployment_id = d.id AND status = 'cancelled') AS cancelled_count
  FROM deployments d`;

function toSummary(row: any): DeploymentSummary {
  return {
    id: row.id,
    projectKey: row.project_key,
    projectName: row.project_name,
    countryCode: row.country_code || null,
    countryName: row.country_name || null,
    status: row.status,
    operatorName: row.operator_name,
    operatorIp: row.operator_ip,
    retryOf: row.retry_of,
    notifyStatus: row.notify_status,
    notifyError: row.notify_error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    envNames: JSON.parse(row.env_names ?? "[]"),
    envCount: row.env_count,
    doneCount: row.done_count,
    failedCount: row.failed_count,
    cancelledCount: row.cancelled_count,
  };
}

function toEnvView(row: any): DeploymentEnvView {
  return {
    idx: row.idx,
    envName: row.env_name,
    branch: row.branch,
    server: row.server,
    host: row.host,
    repoKey: row.repo_key,
    repoUrl: row.repo_url,
    remotePath: row.remote_path,
    installCmd: row.install_cmd,
    buildCmd: row.build_cmd,
    dist: row.dist,
    node: row.node ?? null,
    status: row.status,
    failedStage: row.failed_stage,
    errorSummary: row.error_summary,
    commitSha: row.commit_sha,
    commitMessage: row.commit_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    totalMs: row.total_ms,
  };
}

const DEPLOYMENT_COLUMNS: Record<keyof DeploymentPatch, string> = {
  status: "status",
  startedAt: "started_at",
  finishedAt: "finished_at",
  notifyStatus: "notify_status",
  notifyError: "notify_error",
};

const ENV_COLUMNS: Record<keyof EnvPatch, string> = {
  status: "status",
  failedStage: "failed_stage",
  errorSummary: "error_summary",
  commitSha: "commit_sha",
  commitMessage: "commit_message",
  startedAt: "started_at",
  finishedAt: "finished_at",
  totalMs: "total_ms",
};

function setClause<T extends object>(patch: T, columns: Record<keyof T, string>): { sql: string; values: any[] } {
  const keys = (Object.keys(patch) as (keyof T)[]).filter((k) => patch[k] !== undefined);
  return {
    sql: keys.map((k) => `${columns[k]} = ?`).join(", "),
    values: keys.map((k) => patch[k] as any),
  };
}

export class Repository {
  constructor(readonly db: Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  createDeployment(input: NewDeployment): number {
    return this.transaction(() => {
      const row = this.db
        .query(
          `INSERT INTO deployments (project_key, project_name, country_code, country_name, status, operator_ip, operator_name, user_agent, retry_of, created_at)
           VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(
          input.projectKey,
          input.projectName,
          input.countryCode ?? "",
          input.countryName ?? "",
          input.operatorIp,
          input.operatorName,
          input.userAgent,
          input.retryOf,
          input.createdAt,
        ) as { id: number };
      const insertEnv = this.db.query(
        `INSERT INTO deployment_envs
           (deployment_id, idx, env_name, branch, server, host, repo_key, repo_url, remote_path, install_cmd, build_cmd, dist, node, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
      );
      input.envs.forEach((env, idx) => {
        insertEnv.run(
          row.id,
          idx,
          env.name,
          env.branch,
          env.server,
          env.host,
          env.repoKey,
          redactUrl(env.repoUrl),
          env.remotePath,
          env.installCmd,
          env.buildCmd,
          env.dist,
          env.toolchain.node,
        );
      });
      return row.id;
    });
  }

  updateDeployment(id: number, patch: DeploymentPatch): void {
    const { sql, values } = setClause(patch, DEPLOYMENT_COLUMNS);
    if (!sql) return;
    this.db.query(`UPDATE deployments SET ${sql} WHERE id = ?`).run(...values, id);
  }

  updateEnv(deploymentId: number, idx: number, patch: EnvPatch): void {
    const { sql, values } = setClause(patch, ENV_COLUMNS);
    if (!sql) return;
    this.db.query(`UPDATE deployment_envs SET ${sql} WHERE deployment_id = ? AND idx = ?`).run(...values, deploymentId, idx);
  }

  appendEvent(deploymentId: number, seq: number, event: ProgressEvent): void {
    this.db
      .query(`INSERT INTO deployment_events (deployment_id, seq, type, payload_json, at) VALUES (?, ?, ?, ?, ?)`)
      .run(deploymentId, seq, event.type, JSON.stringify(event), "at" in event ? event.at : Date.now());
  }

  events(deploymentId: number, afterSeq = 0): StoredEvent[] {
    const rows = this.db
      .query(`SELECT seq, payload_json FROM deployment_events WHERE deployment_id = ? AND seq > ? ORDER BY seq`)
      .all(deploymentId, afterSeq) as { seq: number; payload_json: string }[];
    return rows.map((r) => ({ seq: r.seq, event: JSON.parse(r.payload_json) }));
  }

  lastSeq(deploymentId: number): number {
    const row = this.db
      .query(`SELECT coalesce(max(seq), 0) AS seq FROM deployment_events WHERE deployment_id = ?`)
      .get(deploymentId) as { seq: number };
    return row.seq;
  }

  summary(id: number): DeploymentSummary | null {
    const row = this.db.query(`${SUMMARY_SELECT} WHERE d.id = ?`).get(id);
    return row ? toSummary(row) : null;
  }

  envs(deploymentId: number): DeploymentEnvView[] {
    const rows = this.db.query(`SELECT * FROM deployment_envs WHERE deployment_id = ? ORDER BY idx`).all(deploymentId);
    return rows.map(toEnvView);
  }

  list(query: DeploymentListQuery): { items: DeploymentSummary[]; total: number } {
    const where: string[] = [];
    const params: any[] = [];
    if (query.project) {
      where.push("d.project_key = ?");
      params.push(query.project);
    }
    if (query.country) {
      where.push("d.country_code = ?");
      params.push(query.country);
    }
    if (query.status) {
      where.push("d.status = ?");
      params.push(query.status);
    }
    if (query.env) {
      where.push("EXISTS (SELECT 1 FROM deployment_envs e WHERE e.deployment_id = d.id AND e.env_name = ?)");
      params.push(query.env);
    }
    if (query.from != null) {
      where.push("d.created_at >= ?");
      params.push(query.from);
    }
    if (query.to != null) {
      where.push("d.created_at < ?");
      params.push(query.to);
    }
    const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const pageSize = Math.min(Math.max(query.pageSize ?? 20, 1), 100);
    const page = Math.max(query.page ?? 1, 1);
    const total = (this.db.query(`SELECT count(*) AS n FROM deployments d${whereSql}`).get(...params) as { n: number }).n;
    const rows = this.db
      .query(`${SUMMARY_SELECT}${whereSql} ORDER BY d.id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize);
    return { items: rows.map(toSummary), total };
  }

  // Most recent deployment of the directory `host:remotePath`, whatever the env was called then.
  lastDeployOf(host: string, remotePath: string): EnvLastDeploy | null {
    const row = this.db
      .query(
        `SELECT deployment_id, status, started_at, finished_at, commit_sha, failed_stage
         FROM deployment_envs WHERE host = ? AND remote_path = ?
         ORDER BY deployment_id DESC LIMIT 1`,
      )
      .get(host, remotePath) as any;
    if (!row) return null;
    return {
      deploymentId: row.deployment_id,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      commitSha: row.commit_sha,
      failedStage: row.failed_stage,
    };
  }

  activeDeploymentIds(): number[] {
    const rows = this.db
      .query(`SELECT id FROM deployments WHERE status IN ('queued', 'running') ORDER BY id`)
      .all() as { id: number }[];
    return rows.map((r) => r.id);
  }

  // Deletes finished deployments created before `cutoff`; returns what was deleted.
  deleteFinishedBefore(cutoff: number): { id: number; createdAt: number }[] {
    return this.transaction(() => {
      const rows = this.db
        .query(`SELECT id, created_at FROM deployments WHERE created_at < ? AND status NOT IN ('queued', 'running')`)
        .all(cutoff) as { id: number; created_at: number }[];
      const ids = rows.map((r) => r.id);
      const unlink = this.db.query(`UPDATE deployments SET retry_of = NULL WHERE retry_of = ?`);
      const del = this.db.query(`DELETE FROM deployments WHERE id = ?`);
      for (const id of ids) {
        // A retry's back-reference must not block deleting the original.
        unlink.run(id);
        del.run(id);
      }
      return rows.map((r) => ({ id: r.id, createdAt: r.created_at }));
    });
  }
}
