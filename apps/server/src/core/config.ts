import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { parse } from "yaml";
import type { Grouping } from "@shipyard/shared";
import type {
  AccessConfig,
  AppConfig,
  BuildConfig,
  CountryConfig,
  EnvConfig,
  EnvSpec,
  GitAuth,
  GitCredential,
  ProjectConfig,
  ServerConfig,
} from "./types.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// A config.yaml that still carries `repos` / `countries` at the top level (the
// single-project format) becomes this project, so its history stays linked.
export const LEGACY_PROJECT = { key: "topup", name: "充值网站" } as const;

const PROJECT_KEY = /^[a-z0-9][a-z0-9_-]*$/;
const SAFE_NAME = /^[\w.-]+$/;
const DEFAULT_BUILD: BuildConfig = { install: "bun install", build: "bun run build", dist: "dist", node: null };

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

function mapping(value: unknown, ctx: string): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new ConfigError(`${ctx} 必须是键值映射`);
  return value as Record<string, unknown>;
}

// Live directory on the target: absolute, no `.` / `..`, at least two levels
// deep (the swap renames it and keeps `<dir>.prev` next to it), no trailing slash.
export function normalizeRemotePath(raw: string, ctx: string): string {
  const path = raw.trim().replace(/\/+$/, "");
  const parts = path.split("/").slice(1);
  if (!path.startsWith("/") || parts.length < 2 || parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new ConfigError(`${ctx} 必须是至少两级的绝对路径，不能含 . 或 ..（当前：${raw}）`);
  }
  if (!parts.every((p) => SAFE_NAME.test(p))) {
    throw new ConfigError(`${ctx} 的每一级只能包含字母、数字、点、下划线和短横线（当前：${raw}）`);
  }
  return path;
}

// `node: default` (or null) means the image's own node.
function buildOverride(raw: unknown, base: BuildConfig, runtimes: Record<string, string>, ctx: string): BuildConfig {
  const b = mapping(raw, ctx);
  const text = (field: keyof BuildConfig) => {
    const v = b[field];
    if (v == null) return base[field] as string;
    const s = String(v).trim();
    if (!s) throw new ConfigError(`${ctx}.${field} 不能为空`);
    return s;
  };
  let node = base.node;
  if ("node" in b) {
    node = b.node == null || String(b.node) === "default" ? null : String(b.node);
    if (node !== null && !(node in runtimes)) {
      throw new ConfigError(`${ctx}.node="${node}" 未在 runtimes.node 中定义`);
    }
  }
  return { install: text("install"), build: text("build"), dist: text("dist"), node };
}

interface Globals {
  build: BuildConfig;
  runtimes: Record<string, string>;
}

function validateEnv(raw: any, ctx: string, repos: Record<string, string>, base: BuildConfig, globals: Globals, template?: string): EnvConfig {
  const name = String(req(raw, "name", ctx));
  const branch = String(req(raw, "branch", ctx));
  const host = String(req(raw, "host", ctx));
  const repo = String(req(raw, "repo", ctx));
  if (!(repo in repos)) throw new ConfigError(`${ctx} 的 repo="${repo}" 未在 repos 中定义`);

  let server = raw.server == null ? "" : String(raw.server);
  let remotePath: string;
  if (raw.remotePath != null) {
    remotePath = normalizeRemotePath(String(raw.remotePath), `${ctx}.remotePath`);
    // The directory holding the build: /home/mall-web/aurabotani/dist → aurabotani
    server ||= basename(posix.dirname(remotePath));
  } else {
    if (!server) throw new ConfigError(`${ctx} 需要 remotePath，或者 server 配合项目的 remotePathTemplate`);
    if (!template) throw new ConfigError(`${ctx} 没有 remotePath，项目也没有设置 remotePathTemplate`);
    if (!SAFE_NAME.test(server)) throw new ConfigError(`${ctx}.server 只能包含字母、数字、点、下划线和短横线`);
    remotePath = normalizeRemotePath(renderRemotePath(template, server), `${ctx} 的发布目录`);
  }
  if (!SAFE_NAME.test(server)) throw new ConfigError(`${ctx}.server 只能包含字母、数字、点、下划线和短横线`);

  return { name, branch, server, host, repo, remotePath, build: buildOverride(raw.build, base, globals.runtimes, `${ctx}.build`) };
}

function uniqueNames(envs: EnvConfig[], ctx: string): void {
  const names = new Set<string>();
  for (const e of envs) {
    if (names.has(e.name)) throw new ConfigError(`${ctx} 下的环境名「${e.name}」重复`);
    names.add(e.name);
  }
}

export function validateProject(key: string, raw: unknown, globals: Globals, fallbackTemplate?: string): ProjectConfig {
  if (!PROJECT_KEY.test(key)) throw new ConfigError(`项目文件名「${key}」只能用小写字母、数字、下划线和短横线`);
  const r = raw as any;
  if (r == null || typeof r !== "object" || Array.isArray(r)) throw new ConfigError("项目配置为空或不是对象");
  const name = String(req(r, "name", "root"));
  const order = r.order == null ? 100 : Number(r.order);
  if (!Number.isFinite(order)) throw new ConfigError("order 必须是数字");

  if (r.countries != null && r.environments != null) throw new ConfigError("countries 和 environments 只能写一个");
  const grouping: Grouping = r.grouping ?? (r.countries != null ? "country" : "none");
  if (grouping !== "country" && grouping !== "none") throw new ConfigError(`grouping 只能是 country 或 none（当前：${grouping}）`);

  const template = r.remotePathTemplate == null ? fallbackTemplate : String(r.remotePathTemplate);
  if (template != null && !template.includes("{server}")) throw new ConfigError("remotePathTemplate 必须包含 {server} 占位符");

  const repos = mapping(req(r, "repos", "root"), "repos");
  const repoUrls = Object.fromEntries(Object.entries(repos).map(([k, v]) => [k, String(v)]));
  const base = buildOverride(r.build, globals.build, globals.runtimes, "build");

  let countries: CountryConfig[] = [];
  let environments: EnvConfig[];
  if (grouping === "country") {
    const list = req(r, "countries", "root");
    if (!Array.isArray(list)) throw new ConfigError("countries 必须是数组");
    const codes = new Set<string>();
    countries = list.map((c: any, ci: number) => {
      const ctx = `countries[${ci}]`;
      req(c, "name", ctx);
      const code = String(req(c, "code", ctx));
      if (codes.has(code)) throw new ConfigError(`国家代码 ${code} 重复`);
      codes.add(code);
      const envs = req(c, "environments", ctx);
      if (!Array.isArray(envs)) throw new ConfigError(`${ctx}.environments 必须是数组`);
      const environments = envs.map((e, ei) => validateEnv(e, `${ctx}.environments[${ei}]`, repoUrls, base, globals, template));
      uniqueNames(environments, ctx);
      return { name: String(c.name), code, environments };
    });
    environments = countries.flatMap((c) => c.environments);
  } else {
    const list = req(r, "environments", "root");
    if (!Array.isArray(list)) throw new ConfigError("environments 必须是数组");
    environments = list.map((e, ei) => validateEnv(e, `environments[${ei}]`, repoUrls, base, globals, template));
    uniqueNames(environments, "项目");
  }

  const dirs = new Map<string, string>();
  for (const e of environments) {
    const other = dirs.get(lockKey(e.host, e.remotePath));
    if (other) throw new ConfigError(`环境「${other}」和「${e.name}」发布到同一个目录 ${e.host}:${e.remotePath}`);
    dirs.set(lockKey(e.host, e.remotePath), e.name);
  }

  return { key, name, order, grouping, repos: repoUrls, countries, environments, error: null };
}

type GlobalConfig = Omit<AppConfig, "projects"> & { legacy: ProjectConfig | null };

// `baseDir` resolves a relative ssh.privateKeyPath (usually the config file's directory).
export function validateGlobal(raw: unknown, baseDir = process.cwd()): GlobalConfig {
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

  const credsRaw = r.git?.credentials ?? [];
  if (!Array.isArray(credsRaw)) throw new ConfigError("git.credentials 必须是数组");
  const git: GitCredential[] = credsRaw.map((c: any, i: number) => {
    const ctx = `git.credentials[${i}]`;
    return {
      host: String(req(c, "host", ctx)).trim().toLowerCase(),
      username: String(req(c, "username", ctx)),
      token: String(req(c, "token", ctx)),
    };
  });

  const nodeRaw = mapping(r.runtimes?.node, "runtimes.node");
  const node: Record<string, string> = {};
  for (const [label, dir] of Object.entries(nodeRaw)) {
    const bin = String(dir ?? "");
    if (!isAbsolute(bin)) throw new ConfigError(`runtimes.node.${label} 必须是 node 所在 bin 目录的绝对路径`);
    node[label] = bin;
  }
  const build = buildOverride(r.build, DEFAULT_BUILD, node, "build");

  // Optional Feishu notification. FEISHU_WEBHOOK overrides the file.
  const rn = r.notify?.feishu ?? {};
  const webhook = process.env.FEISHU_WEBHOOK || (rn.webhook ? String(rn.webhook) : "");
  const secret = process.env.FEISHU_SECRET || (rn.secret ? String(rn.secret) : "");
  const notify: AppConfig["notify"] = webhook ? { feishu: { webhook, ...(secret ? { secret } : {}) } } : undefined;

  let legacy: ProjectConfig | null = null;
  if (r.countries != null || r.repos != null) {
    legacy = validateProject(
      LEGACY_PROJECT.key,
      { name: LEGACY_PROJECT.name, order: 0, grouping: "country", repos: r.repos, countries: r.countries },
      { build, runtimes: node },
      r.ssh.remotePathTemplate == null ? undefined : String(r.ssh.remotePathTemplate),
    );
  }

  return {
    server,
    access,
    ssh: {
      user: String(r.ssh.user),
      port: Number(r.ssh.port),
      privateKeyPath: isAbsolute(keyPath) ? keyPath : resolve(baseDir, keyPath),
      keepPrevious: r.ssh.keepPrevious !== false,
    },
    git,
    runtimes: { node },
    build,
    notify,
    legacy,
  };
}

function erroredProject(key: string, message: string): ProjectConfig {
  return { key, name: key, order: 100, grouping: "none", repos: {}, countries: [], environments: [], error: message };
}

function yamlOf(text: string, what: string): unknown {
  try {
    return parse(text);
  } catch (e) {
    throw new ConfigError(`${what} 不是合法的 YAML：${e instanceof Error ? e.message : String(e)}`);
  }
}

// Global config plus one project per file. A broken project file only marks
// that project (`error`); a broken global file fails the whole load.
export function parseConfig(text: string, baseDir?: string, projectFiles: Record<string, string> = {}): AppConfig {
  const { legacy, ...global } = validateGlobal(yamlOf(text, "config.yaml"), baseDir);
  const globals: Globals = { build: global.build, runtimes: global.runtimes.node };
  const projects: ProjectConfig[] = legacy ? [legacy] : [];
  for (const [key, body] of Object.entries(projectFiles)) {
    const existing = projects.find((p) => p.key === key);
    if (existing) {
      existing.error = `projects/${key}.yaml 和 config.yaml 里的旧格式配置是同一个项目，两处只能留一处`;
      continue;
    }
    try {
      projects.push(validateProject(key, yamlOf(body, `projects/${key}.yaml`), globals));
    } catch (e) {
      projects.push(erroredProject(key, `projects/${key}.yaml：${e instanceof Error ? e.message : String(e)}`));
    }
  }
  projects.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));

  // Two projects must never share a live directory: the later one is refused.
  const owners = new Map<string, string>();
  for (const p of projects) {
    const clash = p.environments.find((e) => owners.has(lockKey(e.host, e.remotePath)));
    if (clash) {
      p.error ??= `环境「${clash.name}」和项目「${owners.get(lockKey(clash.host, clash.remotePath))}」发布到同一个目录 ${clash.host}:${clash.remotePath}`;
      continue;
    }
    for (const e of p.environments) owners.set(lockKey(e.host, e.remotePath), p.name);
  }
  return { ...global, projects };
}

export function projectsDirOf(configPath: string): string {
  return join(dirname(configPath), "projects");
}

function projectFileNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && !f.startsWith(".")).sort();
  } catch {
    return [];
  }
}

export function loadConfigFile(path: string): AppConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(`无法读取配置文件 ${path}：${e instanceof Error ? e.message : String(e)}`);
  }
  const dir = projectsDirOf(path);
  const files: Record<string, string> = {};
  for (const file of projectFileNames(dir)) {
    // An unreadable file reads as empty and is reported as an invalid project.
    let body = "";
    try {
      body = readFileSync(join(dir, file), "utf8");
    } catch {
      // keep ""
    }
    files[file.replace(/\.ya?ml$/, "")] = body;
  }
  return parseConfig(text, dirname(path), files);
}

export function findProject(config: AppConfig, key: string): ProjectConfig | undefined {
  return config.projects.find((p) => p.key === key);
}

export function findCountry(project: ProjectConfig, code: string): CountryConfig | undefined {
  return project.countries.find((c) => c.code === code);
}

// A token for the repo's host, unless the URL already carries credentials
// (the old format) or is not HTTP(S).
export function gitAuthFor(repoUrl: string, credentials: GitCredential[]): GitAuth | null {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
  const cred = credentials.find((c) => c.host === url.hostname.toLowerCase());
  return cred ? { username: cred.username, token: cred.token } : null;
}

export function envSpecOf(config: AppConfig, project: ProjectConfig, env: EnvConfig): EnvSpec {
  const repoUrl = project.repos[env.repo]!;
  const node = env.build.node;
  return {
    name: env.name,
    branch: env.branch,
    server: env.server,
    host: env.host,
    repoKey: env.repo,
    repoUrl,
    remotePath: env.remotePath,
    installCmd: env.build.install,
    buildCmd: env.build.build,
    dist: env.build.dist,
    toolchain: { node, nodeBin: node === null ? null : (config.runtimes.node[node] ?? null) },
    gitAuth: gitAuthFor(repoUrl, config.git),
  };
}

// Lock key: two environments sharing a host but not a directory may run together.
export function lockKey(host: string, remotePath: string): string {
  return `${host}:${remotePath}`;
}

// Loads the config once at startup and re-reads it before each new deployment,
// so edits (environments, allowlist) take effect without a restart. A broken
// edit never takes the service down: the last good config stays in use and
// `error` explains why new deployments are refused. A broken project file keeps
// that project's last good environments and refuses only its deployments.
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

  // Changes whenever config.yaml or any file in projects/ is edited, added or removed.
  private fileStamp(): string {
    const stat = (p: string) => {
      try {
        const s = statSync(p);
        return `${s.mtimeMs}:${s.size}`;
      } catch {
        return "missing";
      }
    };
    const dir = projectsDirOf(this.path);
    return [stat(this.path), ...projectFileNames(dir).map((f) => `${f}=${stat(join(dir, f))}`)].join("|");
  }

  get(): AppConfig {
    return this.current;
  }

  get error(): string | null {
    return this.lastError;
  }

  // Re-reads the files. Returns the fresh config, or throws ConfigError while
  // keeping the previous one for everything else.
  reload(): AppConfig {
    const stamp = this.fileStamp();
    try {
      const next = this.load(this.path);
      next.projects = next.projects.map((p) => {
        const prev = this.current.projects.find((q) => q.key === p.key);
        return p.error && prev ? { ...prev, error: p.error } : p;
      });
      this.current = next;
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
  // when a file changed on disk, and never throws.
  refresh(): AppConfig {
    if (this.fileStamp() === this.stamp) return this.current;
    try {
      return this.reload();
    } catch {
      return this.current;
    }
  }
}
