import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import type { Country, Environment } from "@ease-deploy/shared";
import type { AccessConfig, AppConfig, EnvSpec, ServerConfig } from "./types.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function renderRemotePath(template: string, server: string): string {
  return template.replaceAll("{server}", server);
}

function req(obj: any, field: string, ctx: string): unknown {
  if (obj == null || obj[field] == null || obj[field] === "") {
    throw new ConfigError(`配置缺少必填字段 ${field}（位于 ${ctx}）`);
  }
  return obj[field];
}

function stringList(value: unknown, ctx: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${ctx} 必须是数组`);
  return value.map((v) => String(v).trim()).filter(Boolean);
}

function positiveInt(value: unknown, fallback: number, ctx: string): number {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${ctx} 必须是正整数`);
  return n;
}

// `baseDir` resolves a relative ssh.privateKeyPath (usually the config file's directory).
export function validateConfig(raw: unknown, baseDir = process.cwd()): AppConfig {
  const r = raw as any;
  if (r == null || typeof r !== "object") throw new ConfigError("配置为空或不是对象");

  const rs = r.server ?? {};
  const server: ServerConfig = {
    port: positiveInt(rs.port, 8080, "server.port"),
    ...(rs.publicUrl ? { publicUrl: String(rs.publicUrl).replace(/\/+$/, "") } : {}),
    maxConcurrent: positiveInt(rs.maxConcurrent, 3, "server.maxConcurrent"),
    logRetentionDays: positiveInt(rs.logRetentionDays, 30, "server.logRetentionDays"),
  };

  const ra = r.access ?? {};
  const access: AccessConfig = {
    allowIps: stringList(ra.allowIps, "access.allowIps"),
    protectReads: ra.protectReads === true,
    trustProxy: ra.trustProxy === true,
    proxyIps: stringList(ra.proxyIps ?? ["127.0.0.1", "::1"], "access.proxyIps"),
    allowedOrigins: stringList(ra.allowedOrigins, "access.allowedOrigins").map((o) => o.replace(/\/+$/, "")),
  };

  req(r, "ssh", "root");
  req(r.ssh, "user", "ssh");
  req(r.ssh, "port", "ssh");
  const keyPath = String(req(r.ssh, "privateKeyPath", "ssh"));
  const template = String(req(r.ssh, "remotePathTemplate", "ssh"));
  if (!template.includes("{server}")) {
    throw new ConfigError("ssh.remotePathTemplate 必须包含 {server} 占位符");
  }

  req(r, "build", "root");
  req(r.build, "install", "build");
  req(r.build, "build", "build");
  req(r.build, "dist", "build");

  const repos = req(r, "repos", "root") as Record<string, string>;
  if (typeof repos !== "object" || Array.isArray(repos)) throw new ConfigError("repos 必须是键值映射");

  const countriesRaw = req(r, "countries", "root") as any[];
  if (!Array.isArray(countriesRaw)) throw new ConfigError("countries 必须是数组");

  const codes = new Set<string>();
  const countries: Country[] = countriesRaw.map((c, ci) => {
    const ctx = `countries[${ci}]`;
    req(c, "name", ctx);
    const code = String(req(c, "code", ctx));
    if (codes.has(code)) throw new ConfigError(`国家代码 ${code} 重复`);
    codes.add(code);
    const envsRaw = req(c, "environments", ctx) as any[];
    if (!Array.isArray(envsRaw)) throw new ConfigError(`${ctx}.environments 必须是数组`);
    const names = new Set<string>();
    const environments: Environment[] = envsRaw.map((e, ei) => {
      const ectx = `${ctx}.environments[${ei}]`;
      const name = String(req(e, "name", ectx));
      if (names.has(name)) throw new ConfigError(`${ctx} 下的环境名「${name}」重复`);
      names.add(name);
      const branch = String(req(e, "branch", ectx));
      const serverName = String(req(e, "server", ectx));
      if (!/^[\w.-]+$/.test(serverName)) throw new ConfigError(`${ectx}.server 只能包含字母、数字、点、下划线和短横线`);
      const host = String(req(e, "host", ectx));
      const repo = String(req(e, "repo", ectx));
      if (!(repo in repos)) {
        throw new ConfigError(`${ectx} 的 repo="${repo}" 未在 repos 中定义`);
      }
      return { name, branch, server: serverName, host, repo };
    });
    return { name: String(c.name), code, environments };
  });

  // Optional Feishu notification. FEISHU_WEBHOOK overrides the file.
  const rn = r.notify?.feishu ?? {};
  const webhook = process.env.FEISHU_WEBHOOK || (rn.webhook ? String(rn.webhook) : "");
  const secret = process.env.FEISHU_SECRET || (rn.secret ? String(rn.secret) : "");
  const notify: AppConfig["notify"] = webhook ? { feishu: { webhook, ...(secret ? { secret } : {}) } } : undefined;

  return {
    server,
    access,
    ssh: {
      user: String(r.ssh.user),
      port: Number(r.ssh.port),
      privateKeyPath: isAbsolute(keyPath) ? keyPath : resolve(baseDir, keyPath),
      remotePathTemplate: template,
      keepPrevious: r.ssh.keepPrevious !== false,
    },
    build: {
      install: String(r.build.install),
      build: String(r.build.build),
      dist: String(r.build.dist),
    },
    repos: Object.fromEntries(Object.entries(repos).map(([k, v]) => [k, String(v)])),
    countries,
    notify,
  };
}

export function parseConfig(text: string, baseDir?: string): AppConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new ConfigError(`config.yaml 不是合法的 YAML：${e instanceof Error ? e.message : String(e)}`);
  }
  return validateConfig(raw, baseDir);
}

export function loadConfigFile(path: string): AppConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(`无法读取配置文件 ${path}：${e instanceof Error ? e.message : String(e)}`);
  }
  return parseConfig(text, dirname(path));
}

export function findCountry(config: AppConfig, code: string): Country | undefined {
  return config.countries.find((c) => c.code === code);
}

export function envSpecOf(config: AppConfig, env: Environment): EnvSpec {
  return {
    name: env.name,
    branch: env.branch,
    server: env.server,
    host: env.host,
    repoKey: env.repo,
    repoUrl: config.repos[env.repo]!,
    remotePath: renderRemotePath(config.ssh.remotePathTemplate, env.server),
    installCmd: config.build.install,
    buildCmd: config.build.build,
    dist: config.build.dist,
  };
}

// Lock key: two environments sharing a host but not a directory may run together.
export function lockKey(host: string, remotePath: string): string {
  return `${host}:${remotePath}`;
}

// Loads the config once at startup and re-reads it before each new deployment,
// so edits (environments, allowlist) take effect without a restart. A broken
// edit never takes the service down: the last good config stays in use and
// `error` explains why new deployments are refused.
export class ConfigStore {
  private current: AppConfig;
  private lastError: string | null = null;
  private stamp: string;

  constructor(
    readonly path: string,
    private load: (path: string) => AppConfig = loadConfigFile,
  ) {
    this.stamp = this.fileStamp();
    this.current = this.load(path);
  }

  private fileStamp(): string {
    try {
      const s = statSync(this.path);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return "missing";
    }
  }

  get(): AppConfig {
    return this.current;
  }

  get error(): string | null {
    return this.lastError;
  }

  // Re-reads the file. Returns the fresh config, or throws ConfigError while
  // keeping the previous one for everything else.
  reload(): AppConfig {
    const stamp = this.fileStamp();
    try {
      this.current = this.load(this.path);
      this.lastError = null;
      return this.current;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      throw e instanceof ConfigError ? e : new ConfigError(this.lastError);
    } finally {
      this.stamp = stamp;
    }
  }

  // Cheap refresh for read paths and per-request access checks: re-parses only
  // when the file changed on disk, and never throws.
  refresh(): AppConfig {
    if (this.fileStamp() === this.stamp) return this.current;
    try {
      return this.reload();
    } catch {
      return this.current;
    }
  }
}
