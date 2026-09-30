import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineDeps, StageContext } from "../src/core/pipeline.ts";
import { CancelledError } from "../src/core/process.ts";
import { ConfigStore, parseConfig } from "../src/core/config.ts";
import type { AppConfig, EnvSpec } from "../src/core/types.ts";
import type { PlanRequest } from "@shipyard/shared";
import { DeploymentService } from "../src/service/deployments.ts";
import { openDatabase } from "../src/store/db.ts";
import { LogStore } from "../src/store/logs.ts";
import { Repository } from "../src/store/repo.ts";
import type { FeishuCard, SendResult } from "../src/core/notify.ts";

export const CONFIG_YAML = `
server:
  maxConcurrent: 2
access:
  allowIps: [127.0.0.1, 10.8.0.0/16]
ssh:
  user: root
  port: 22
  privateKeyPath: deploy.pem
  remotePathTemplate: "/home/topup-web/{server}/dist"
build:
  install: "bun install"
  build: "bun run build"
  dist: "dist"
repos:
  out: "https://oauth2:secret@codeup.example.com/out.git"
  lab: "https://codeup.example.com/lab.git"
countries:
  - name: 巴基斯坦
    code: PK
    environments:
      - { name: QuickBuy 环境, branch: PK-QuickBuy, server: quickbuypk, host: 1.1.1.1, repo: out }
      - { name: Kbunique 环境, branch: PK-kbunique, server: kbunique, host: 1.1.1.2, repo: lab }
      - { name: Saink 环境, branch: PK-saink, server: sainkgos, host: 1.1.1.1, repo: lab }
  - name: 墨西哥
    code: MX
    environments:
      - { name: ZenLix 环境, branch: MX-ZenLix, server: zenlixmx, host: 2.2.2.2, repo: out }
`;

export const SPEC: EnvSpec = {
  name: "QuickBuy 环境",
  branch: "PK-QuickBuy",
  server: "quickbuypk",
  host: "1.2.3.4",
  repoKey: "out",
  repoUrl: "https://x/out.git",
  remotePath: "/home/topup-web/quickbuypk/dist",
  installCmd: "bun install",
  buildCmd: "bun run build",
  dist: "dist",
  toolchain: { node: null, nodeBin: null },
  gitAuth: null,
};

// CONFIG_YAML is the single-project (legacy) format, which loads as project "topup".
export function topup(countryCode: string, envNames: string[]): PlanRequest {
  return { project: "topup", countryCode, envNames };
}

export function testConfig(yaml = CONFIG_YAML): AppConfig {
  return parseConfig(yaml, "/cfg");
}

// A controllable pipeline: each stage waits on a gate you can open or fail.
export class FakePipeline {
  gates = new Map<string, { resolve: () => void; reject: (e: Error) => void; promise: Promise<void> }>();
  calls: string[] = [];
  autoOpen = false;

  private gate(key: string) {
    let g = this.gates.get(key);
    if (!g) {
      let resolve!: () => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      g = { resolve, reject, promise };
      this.gates.set(key, g);
    }
    return g;
  }

  open(env: string, stage: string): void {
    this.gate(`${env}:${stage}`).resolve();
  }

  fail(env: string, stage: string, message: string): void {
    this.gate(`${env}:${stage}`).reject(new Error(message));
  }

  private async wait(env: string, stage: string, ctx: StageContext): Promise<void> {
    this.calls.push(`${env}:${stage}`);
    ctx.log("stdout", `${stage} output for ${env}`);
    if (this.autoOpen) return;
    const g = this.gate(`${env}:${stage}`);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new CancelledError());
      if (ctx.signal.aborted) return onAbort();
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      g.promise.then(resolve, reject);
    });
  }

  // Opens every stage of a branch.
  pass(branch: string): void {
    for (const stage of ["clone", "install", "build", "upload"]) this.open(branch, stage);
  }

  // Gates are keyed by branch: `open("PK-QuickBuy", "clone")`.
  deps(): PipelineDeps {
    const branchOf = new Map<string, string>();
    let n = 0;
    return {
      clone: (_url, branch, dest, ctx) => {
        branchOf.set(dest, branch);
        return this.wait(branch, "clone", ctx);
      },
      headCommit: async () => ({ sha: "a1b2c3d4e5f6", message: "fix: test" }),
      runInstall: (cwd, _cmd, ctx) => this.wait(branchOf.get(cwd)!, "install", ctx),
      runBuild: async (cwd, _cmd, dist, ctx) => {
        await this.wait(branchOf.get(cwd)!, "build", ctx);
        return { distPath: `${cwd}/${dist}` };
      },
      upload: (dist, _target, ctx) => this.wait(branchOf.get(dist.replace(/\/[^/]+$/, ""))!, "upload", ctx),
      mkdtemp: async () => `/tmp/fake-${++n}`,
      rmrf: async () => {},
      now: () => performance.now(),
    };
  }
}

export interface TestEnv {
  dir: string;
  configPath: string;
  config: ConfigStore;
  repo: Repository;
  logs: LogStore;
  service: DeploymentService;
  pipeline: FakePipeline;
  notified: { card: FeishuCard; webhook: string }[];
  writeConfig(yaml: string): void;
  writeProject(key: string, yaml: string): void; // projects/<key>.yaml next to config.yaml
  cleanup(): void;
}

export function setupService(opts: { yaml?: string; notify?: (card: FeishuCard) => SendResult } = {}): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "shipyard-test-"));
  const configPath = join(dir, "config.yaml");
  let version = 0;
  const write = (path: string, yaml: string) => {
    writeFileSync(path, yaml);
    // make sure the mtime-based change detection notices even same-millisecond writes
    const t = new Date(Date.now() + ++version * 1000);
    utimesSync(path, t, t);
  };
  const writeConfig = (yaml: string) => write(configPath, yaml);
  const writeProject = (key: string, yaml: string) => {
    mkdirSync(join(dir, "projects"), { recursive: true });
    write(join(dir, "projects", `${key}.yaml`), yaml);
  };
  writeConfig(opts.yaml ?? CONFIG_YAML);
  writeFileSync(join(dir, "deploy.pem"), "PEM");
  const config = new ConfigStore(configPath);
  const repo = new Repository(openDatabase(":memory:"));
  const logs = new LogStore(join(dir, "logs"));
  const pipeline = new FakePipeline();
  const notified: TestEnv["notified"] = [];
  const service = new DeploymentService({
    repo,
    logs,
    config,
    pipeline: pipeline.deps(),
    notify: async (webhook, card) => {
      notified.push({ webhook, card });
      return opts.notify?.(card) ?? { ok: true };
    },
  });
  return {
    dir,
    configPath,
    config,
    repo,
    logs,
    service,
    pipeline,
    notified,
    writeConfig,
    writeProject,
    cleanup: () => {
      logs.closeAll();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

export const OPERATOR = { ip: "127.0.0.1", name: "张三", userAgent: "test" };
