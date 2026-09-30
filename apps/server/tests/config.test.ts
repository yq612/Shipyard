import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ConfigError,
  envSpecOf,
  gitAuthFor,
  lockKey,
  normalizeRemotePath,
  parseConfig,
  renderRemotePath,
  validateGlobal,
  validateProject,
} from "../src/core/config.ts";
import { CONFIG_YAML, setupService, type TestEnv } from "./helpers.ts";

const ROOT = resolve(import.meta.dir, "../../..");

const GLOBAL = {
  ssh: { user: "root", port: 22, privateKeyPath: "k.pem" },
  git: { credentials: [{ host: "Codeup.Aliyun.com", username: "me", token: "t0k" }] },
  runtimes: { node: { node20: "/opt/node20/bin" } },
};
const GLOBALS = { build: { install: "bun install", build: "bun run build", dist: "dist", node: null }, runtimes: { node20: "/opt/node20/bin" } };

const env = (over: Record<string, unknown> = {}) => ({ name: "e", branch: "main", host: "h", repo: "site", remotePath: "/home/site/dist", ...over });
const flat = (envs: unknown[], over: Record<string, unknown> = {}) => ({ name: "官网", repos: { site: "https://codeup.aliyun.com/x/site.git" }, environments: envs, ...over });

describe("global config", () => {
  test("substitutes {server}", () => {
    expect(renderRemotePath("/home/topup-web/{server}/dist", "foo")).toBe("/home/topup-web/foo/dist");
  });

  test("fills defaults, resolves the key path, reads git credentials and runtimes", () => {
    const cfg = validateGlobal(GLOBAL, "/data");
    expect(cfg.server).toEqual({ port: 8080, maxConcurrent: 3, logRetentionDays: 30 });
    expect(cfg.access).toMatchObject({ allowIps: [], protectReads: false, trustProxy: false, allowedOrigins: [] });
    expect(cfg.ssh).toEqual({ user: "root", port: 22, privateKeyPath: "/data/k.pem", keepPrevious: true });
    expect(cfg.git).toEqual([{ host: "codeup.aliyun.com", username: "me", token: "t0k" }]);
    expect(cfg.runtimes.node).toEqual({ node20: "/opt/node20/bin" });
    expect(cfg.build).toEqual({ install: "bun install", build: "bun run build", dist: "dist", node: null });
    expect(cfg.legacy).toBeNull();
  });

  test("rejects bad input with a readable message", () => {
    expect(() => validateGlobal({ ...GLOBAL, ssh: { ...GLOBAL.ssh, privateKeyPath: "" } })).toThrow(/privateKeyPath/);
    expect(() => validateGlobal({ ...GLOBAL, server: { maxConcurrent: 0 } })).toThrow(/maxConcurrent/);
    expect(() => validateGlobal({ ...GLOBAL, runtimes: { node: { n: "relative/bin" } } })).toThrow(/绝对路径/);
    expect(() => validateGlobal({ ...GLOBAL, build: { node: "node99" } })).toThrow(/node99/);
    expect(() => validateGlobal({ ...GLOBAL, git: { credentials: [{ host: "x" }] } })).toThrow(/username/);
    expect(() => parseConfig("a: [")).toThrow(ConfigError);
  });

  test("FEISHU_WEBHOOK overrides the file", () => {
    process.env.FEISHU_WEBHOOK = "https://hook/env";
    try {
      expect(validateGlobal(GLOBAL).notify?.feishu?.webhook).toBe("https://hook/env");
    } finally {
      delete process.env.FEISHU_WEBHOOK;
    }
    expect(validateGlobal(GLOBAL).notify).toBeUndefined();
  });
});

describe("projects", () => {
  test("remote directories: explicit, normalised, server derived from the parent directory", () => {
    const p = validateProject("site", flat([env({ remotePath: "/home/freelancer-web/dist/" })]), GLOBALS);
    expect(p.grouping).toBe("none");
    expect(p.environments[0]).toMatchObject({ remotePath: "/home/freelancer-web/dist", server: "freelancer-web" });
    expect(normalizeRemotePath("/home/mall-web/beef.aurabotani.com/dist", "x")).toBe("/home/mall-web/beef.aurabotani.com/dist");
    for (const bad of ["dist", "/dist", "/home/../etc", "/home/a b/dist", "/home//dist"]) {
      expect(() => normalizeRemotePath(bad, "x")).toThrow(ConfigError);
    }
  });

  test("build settings merge global ← project ← environment, including the node runtime", () => {
    const p = validateProject("site", flat([env({ name: "a" }), env({ name: "b", remotePath: "/home/b/dist", build: { build: "vite build", node: "default" } })], {
      build: { build: "vue-tsc -b && vite build", node: "node20" },
    }), GLOBALS);
    expect(p.environments[0]!.build).toEqual({ install: "bun install", build: "vue-tsc -b && vite build", dist: "dist", node: "node20" });
    expect(p.environments[1]!.build).toEqual({ install: "bun install", build: "vite build", dist: "dist", node: null });
    expect(() => validateProject("site", flat([env({ build: { node: "node18" } })]), GLOBALS)).toThrow(/node18/);
  });

  test("rejects duplicate names, duplicate directories and unknown repos", () => {
    expect(() => validateProject("site", flat([env(), env({ remotePath: "/home/x/dist" })]), GLOBALS)).toThrow(/重复/);
    expect(() => validateProject("site", flat([env({ name: "a" }), env({ name: "b" })]), GLOBALS)).toThrow(/同一个目录/);
    expect(() => validateProject("site", flat([env({ repo: "nope" })]), GLOBALS)).toThrow(/repo/);
    expect(() => validateProject("Bad Key", flat([env()]), GLOBALS)).toThrow(/文件名/);
    expect(() => validateProject("site", flat([env({ remotePath: undefined, server: "s" })]), GLOBALS)).toThrow(/remotePathTemplate/);
    expect(() => validateProject("site", { ...flat([]), countries: [] }, GLOBALS)).toThrow(/只能写一个/);
  });

  test("country projects keep the template form and duplicate-code check", () => {
    const e = { name: "e", branch: "b", server: "s", host: "h", repo: "site" };
    const base = { name: "充值网站", repos: { site: "u" }, remotePathTemplate: "/home/topup-web/{server}/dist" };
    const p = validateProject("topup", { ...base, countries: [{ name: "巴基斯坦", code: "PK", environments: [e] }] }, GLOBALS);
    expect(p.grouping).toBe("country");
    expect(p.environments[0]!.remotePath).toBe("/home/topup-web/s/dist");
    expect(() => validateProject("topup", { ...base, countries: [{ name: "A", code: "PK", environments: [e] }, { name: "B", code: "PK", environments: [] }] }, GLOBALS)).toThrow(/重复/);
    expect(() => validateProject("topup", { ...base, remotePathTemplate: "/no/placeholder", countries: [] }, GLOBALS)).toThrow(/\{server\}/);
  });

  test("a broken project file only disables that project; cross-project directory clashes are refused", () => {
    const g = "ssh: { user: root, port: 22, privateKeyPath: k.pem }\n";
    const ok = "name: 官网\norder: 1\nrepos: { site: u }\nenvironments:\n  - { name: a, branch: main, host: h, repo: site, remotePath: /home/a/dist }\n";
    // the project listed first (by order, then key) keeps the directory
    const cfg = parseConfig(g, "/d", { site: ok, broken: "name: [", clash: ok.replace("官网", "撞车").replace("order: 1", "order: 2") });
    expect(cfg.projects.map((p) => [p.key, p.error === null])).toEqual([["site", true], ["clash", false], ["broken", false]]);
    expect(cfg.projects.find((p) => p.key === "broken")!.error).toContain("YAML");
    expect(cfg.projects.find((p) => p.key === "clash")!.error).toContain("同一个目录");
  });

  test("git credentials are matched by host and never override a URL that carries its own", () => {
    const creds = [{ host: "codeup.aliyun.com", username: "me", token: "t" }];
    expect(gitAuthFor("https://codeup.aliyun.com/x/y.git", creds)).toEqual({ username: "me", token: "t" });
    expect(gitAuthFor("https://oauth2:old@codeup.aliyun.com/x/y.git", creds)).toBeNull();
    expect(gitAuthFor("https://github.com/x/y.git", creds)).toBeNull();
    expect(gitAuthFor("git@codeup.aliyun.com:x/y.git", creds)).toBeNull();
  });

  test("the legacy single-project config.yaml loads as the topup project", () => {
    const cfg = parseConfig(CONFIG_YAML, "/cfg");
    expect(cfg.projects.map((p) => [p.key, p.name, p.grouping])).toEqual([["topup", "充值网站", "country"]]);
    const project = cfg.projects[0]!;
    expect(envSpecOf(cfg, project, project.countries[0]!.environments[0]!)).toEqual({
      name: "QuickBuy 环境",
      branch: "PK-QuickBuy",
      server: "quickbuypk",
      host: "1.1.1.1",
      repoKey: "out",
      repoUrl: "https://oauth2:secret@codeup.example.com/out.git",
      remotePath: "/home/topup-web/quickbuypk/dist",
      installCmd: "bun install",
      buildCmd: "bun run build",
      dist: "dist",
      toolchain: { node: null, nodeBin: null },
      gitAuth: null,
    });
    expect(lockKey("1.1.1.1", "/a")).toBe("1.1.1.1:/a");
    // a projects/topup.yaml next to the legacy block is a conflict, not a silent override
    const both = parseConfig(CONFIG_YAML, "/cfg", { topup: "name: x" });
    expect(both.projects[0]!.error).toContain("两处只能留一处");
  });
});

test("the README's config snippets are valid", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const blocks = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const global = blocks.find((b) => b.startsWith("server:"))!;
  const projects = Object.fromEntries(
    blocks.filter((b) => b.startsWith("# projects/")).map((b) => [/^# projects\/(\w+)\.yaml/.exec(b)![1]!, b]),
  );
  const cfg = parseConfig(global, "/data", projects);
  expect(cfg.projects.map((p) => [p.key, p.grouping, p.error])).toEqual([
    ["topup", "country", null],
    ["official", "none", null],
  ]);
  expect(cfg.git.map((c) => c.host)).toEqual(["codeup.aliyun.com", "github.com"]);
  const official = cfg.projects[1]!;
  expect(official.environments.map((e) => [e.server, e.build.build, e.build.node])).toEqual([
    ["future-harvest-web", "bun run build --mode production", null],
    ["future-harvest-admin", "vite build", null],
  ]);
  expect(cfg.notify).toBeUndefined();
});

describe("ConfigStore", () => {
  let t: TestEnv;
  afterEach(() => t?.cleanup());

  test("keeps the last good config when an edit breaks validation", () => {
    t = setupService();
    expect(t.config.get().projects[0]!.countries).toHaveLength(2);
    t.writeConfig(CONFIG_YAML.replace("privateKeyPath: deploy.pem", "privateKeyPath: \"\""));
    expect(() => t.config.reload()).toThrow(/privateKeyPath/);
    expect(t.config.error).toContain("privateKeyPath");
    expect(t.config.get().projects[0]!.countries).toHaveLength(2);

    t.writeConfig(CONFIG_YAML.replace("maxConcurrent: 2", "maxConcurrent: 5"));
    expect(t.config.refresh().server.maxConcurrent).toBe(5);
    expect(t.config.error).toBeNull();
  });

  test("picks up project files and keeps a broken project's last good environments", () => {
    t = setupService();
    const site = "name: 官网\nrepos: { site: u }\nenvironments:\n  - { name: a, branch: main, host: h, repo: site, remotePath: /home/a/dist }\n";
    t.writeProject("site", site);
    expect(t.config.refresh().projects.map((p) => p.key)).toEqual(["topup", "site"]);

    t.writeProject("site", site + "  - [");
    const broken = t.config.refresh().projects.find((p) => p.key === "site")!;
    expect(broken.error).toContain("YAML");
    expect(broken.environments.map((e) => e.name)).toEqual(["a"]);
    expect(t.config.error).toBeNull();
  });
});
