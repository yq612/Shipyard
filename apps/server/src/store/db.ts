import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Each entry runs once, in order; PRAGMA user_version records how far we got.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE deployments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code  TEXT NOT NULL,
    country_name  TEXT NOT NULL,
    status        TEXT NOT NULL,
    operator_ip   TEXT NOT NULL,
    operator_name TEXT,
    user_agent    TEXT,
    retry_of      INTEGER REFERENCES deployments(id),
    notify_status TEXT,
    notify_error  TEXT,
    created_at    INTEGER NOT NULL,
    started_at    INTEGER,
    finished_at   INTEGER
  );
  CREATE INDEX idx_deployments_created ON deployments(created_at DESC);
  CREATE INDEX idx_deployments_status ON deployments(status);

  CREATE TABLE deployment_envs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id  INTEGER NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    idx            INTEGER NOT NULL,
    env_name       TEXT NOT NULL,
    branch         TEXT NOT NULL,
    server         TEXT NOT NULL,
    host           TEXT NOT NULL,
    repo_key       TEXT NOT NULL,
    repo_url       TEXT NOT NULL,
    remote_path    TEXT NOT NULL,
    install_cmd    TEXT NOT NULL,
    build_cmd      TEXT NOT NULL,
    dist           TEXT NOT NULL,
    status         TEXT NOT NULL,
    failed_stage   TEXT,
    error_summary  TEXT,
    commit_sha     TEXT,
    commit_message TEXT,
    started_at     INTEGER,
    finished_at    INTEGER,
    total_ms       INTEGER,
    UNIQUE (deployment_id, idx)
  );
  CREATE INDEX idx_envs_lookup ON deployment_envs(host, remote_path, deployment_id DESC);
  CREATE INDEX idx_envs_name ON deployment_envs(env_name);

  CREATE TABLE deployment_events (
    deployment_id INTEGER NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    type          TEXT NOT NULL,
    payload_json  TEXT NOT NULL,
    at            INTEGER NOT NULL,
    PRIMARY KEY (deployment_id, seq)
  );
  `,
];

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}
