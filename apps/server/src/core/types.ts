import type { Country, LogStream } from "@ease-deploy/shared";

export interface SshConfig {
  user: string;
  port: number;
  privateKeyPath: string; // absolute; resolved against the config file's directory
  remotePathTemplate: string; // must contain the {server} placeholder
  keepPrevious: boolean; // keep the replaced dist as `<remotePath>.prev` (rollback insurance)
}

export interface BuildConfig {
  install: string; // e.g. "bun install"
  build: string; // e.g. "bun run build"
  dist: string; // e.g. "dist"
}

export interface ServerConfig {
  port: number;
  publicUrl?: string; // prefix for the Feishu card's 「查看详情」 link
  maxConcurrent: number;
  logRetentionDays: number;
}

export interface AccessConfig {
  allowIps: string[]; // IPs / CIDRs allowed to start, cancel and retry
  protectReads: boolean; // when true, read endpoints also require the allowlist
  trustProxy: boolean; // honour X-Forwarded-For from `proxyIps`
  proxyIps: string[];
  allowedOrigins: string[]; // empty → same-origin only (Origin host must equal Host)
}

export interface FeishuNotify {
  webhook: string;
  secret?: string; // only when the bot enables 签名校验
}

export interface NotifyConfig {
  feishu?: FeishuNotify;
}

export interface AppConfig {
  server: ServerConfig;
  access: AccessConfig;
  ssh: SshConfig;
  build: BuildConfig;
  repos: Record<string, string>; // repo key -> git url
  countries: Country[];
  notify?: NotifyConfig;
}

// Everything one environment's pipeline needs, frozen when the deployment is
// created so later config edits don't change what an in-flight job does.
export interface EnvSpec {
  name: string;
  branch: string;
  server: string;
  host: string;
  repoKey: string;
  repoUrl: string; // raw — may carry credentials; never log or persist unredacted
  remotePath: string;
  installCmd: string;
  buildCmd: string;
  dist: string;
}

export interface SshCredentials {
  user: string;
  port: number;
  privateKey: string; // PEM contents
  keepPrevious: boolean;
}

export interface UploadTarget extends SshCredentials {
  host: string;
  server: string;
  remotePath: string;
}

export type LogFn = (stream: LogStream, text: string) => void;

export interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
  env?: Record<string, string>;
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
}

// Subprocess runner abstraction. The default implementation spawns a real
// process; tests inject a fake. Rejects on non-zero exit or cancellation.
export type Runner = (
  file: string,
  args: string[],
  opts?: RunOptions,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
