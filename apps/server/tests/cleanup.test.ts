import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRemoteScript, remoteTempPath, upload, type SshClient, type UploadDeps } from "../src/core/deployer.ts";
import { runPipeline, type PipelineDeps } from "../src/core/pipeline.ts";
import { CancelledError } from "../src/core/process.ts";
import { isTempPathActive } from "../src/core/temp.ts";
import type { UploadTarget } from "../src/core/types.ts";
import { cleanTmp } from "../src/service/deps.ts";
import { SPEC } from "./helpers.ts";

const dirs: string[] = [];
function scratch() {
  const path = mkdtempSync(join(tmpdir(), "shipyard-cleanup-test-"));
  dirs.push(path);
  return path;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const target: UploadTarget = { ...SPEC, user: "test", port: 22, privateKey: "unused", keepPrevious: true };
const success = { code: 0, stdout: "", stderr: "" };
const runSuccess = { stdout: "", stderr: "", exitCode: 0 };

function client(overrides: Partial<SshClient> = {}): SshClient {
  return { connect: async () => {}, putFile: async () => {}, execCommand: async () => success, dispose() {}, ...overrides };
}

function uploadHarness(primary: SshClient, cleanup = client()) {
  const removed: string[] = [];
  const logs: string[] = [];
  let clients = 0;
  const deps: Partial<UploadDeps> = {
    run: async () => runSuccess,
    stamp: () => "audit",
    tmpBase: scratch(),
    fileSize: async () => 1,
    rm: async (path) => { removed.push(path); },
    sshFactory: () => clients++ === 0 ? primary : cleanup,
  };
  return { deps, removed, logs, clients: () => clients, log: (_stream: unknown, text: string) => { logs.push(text); } };
}

describe("upload cleanup", () => {
  test("default upload identities produce separate local and remote temporary paths", async () => {
    const archives: string[] = [];
    const swaps: string[] = [];
    const deps: Partial<UploadDeps> = {
      tmpBase: scratch(),
      run: async (_file, args) => { archives.push(args[3]!); return runSuccess; },
      fileSize: async () => 1,
      rm: async () => {},
      sshFactory: () => client({ execCommand: async (command) => {
        if (!command.startsWith("mkdir")) swaps.push(command);
        return success;
      } }),
    };
    await Promise.all([upload("/unused", target, {}, deps), upload("/unused", target, {}, deps)]);
    expect(new Set(archives).size).toBe(2);
    expect(new Set(swaps).size).toBe(2);
    for (const archive of archives) expect(archive).toMatch(/-\d+-[0-9a-f-]{36}\.tar\.gz$/);
  });

  for (const cancel of [false, true]) {
    test(`partial tar is removed when packaging ${cancel ? "is cancelled" : "fails"}`, async () => {
      const base = scratch();
      const ctl = new AbortController();
      const archive = join(base, "shipyard-quickbuypk-audit.tar.gz");
      let connected = false;
      await expect(upload("/unused", target, { signal: ctl.signal }, {
        tmpBase: base,
        stamp: () => "audit",
        run: async () => {
          writeFileSync(archive, "partial archive");
          if (cancel) ctl.abort();
          throw cancel ? new CancelledError() : new Error("tar failed");
        },
        sshFactory: () => { connected = true; return client(); },
      })).rejects.toThrow(cancel ? "已取消" : "tar failed");
      expect(existsSync(archive)).toBe(false);
      expect(isTempPathActive(archive)).toBe(false);
      expect(connected).toBe(false);
    });
  }

  test("SSH client construction failure still removes the archive", async () => {
    const h = uploadHarness(client());
    await expect(upload("/unused", target, {}, { ...h.deps, sshFactory: () => { throw new Error("client failed"); } })).rejects.toThrow("client failed");
    expect(h.removed).toHaveLength(1);
    expect(isTempPathActive(h.removed[0]!)).toBe(false);
  });

  test("upload failure cleans only its staging directory through a fresh connection", async () => {
    const commands: string[] = [];
    const h = uploadHarness(client({ putFile: async () => { throw new Error("transfer failed"); } }), client({
      execCommand: async (command) => { commands.push(command); return success; },
    }));
    await expect(upload("/unused", target, { log: h.log }, h.deps)).rejects.toThrow("transfer failed");
    expect(h.clients()).toBe(2);
    expect(commands).toEqual(["rm -rf -- /tmp/shipyard-quickbuypk-audit"]);
    expect(h.removed).toHaveLength(1);
    expect(h.logs.some((line) => line.includes("已清理远端"))).toBe(true);
  });

  test("cancelled transfer cleans staging without the aborted transfer connection", async () => {
    const ctl = new AbortController();
    let disposed = 0;
    const commands: string[] = [];
    const h = uploadHarness(client({ putFile: async () => { ctl.abort(); }, dispose() { disposed++; } }), client({
      execCommand: async (command) => { commands.push(command); return success; },
    }));
    await expect(upload("/unused", target, { log: h.log, signal: ctl.signal }, h.deps)).rejects.toBeInstanceOf(CancelledError);
    expect(disposed).toBeGreaterThan(0);
    expect(commands).toEqual(["rm -rf -- /tmp/shipyard-quickbuypk-audit"]);
    expect(h.removed).toHaveLength(1);
  });

  test("confirmed swap failure cleans this upload's extraction directory, never live or previous", async () => {
    const staging = "/tmp/shipyard-quickbuypk-audit";
    const commands: string[] = [];
    const h = uploadHarness(client({ execCommand: async (command) => command.startsWith("mkdir") ? success : { ...success, code: 1, stderr: "extract failed" } }), client({
      execCommand: async (command) => { commands.push(command); return success; },
    }));
    await expect(upload("/unused", target, { log: h.log }, h.deps)).rejects.toThrow("extract failed");
    expect(commands).toEqual([`rm -rf -- ${staging} ${remoteTempPath(target.remotePath, staging)}`]);
    const another = buildRemoteScript(target.remotePath, "/tmp/another/dist.tar.gz", "/tmp/another", true);
    expect(another).not.toContain(remoteTempPath(target.remotePath, staging));
    expect(h.removed).toHaveLength(1);
  });

  test("lost swap response preserves potentially active remote paths and warns", async () => {
    const h = uploadHarness(client({ execCommand: async (command) => {
      if (!command.startsWith("mkdir")) throw new Error("connection lost");
      return success;
    } }));
    await expect(upload("/unused", target, { log: h.log }, h.deps)).rejects.toThrow("connection lost");
    expect(h.clients()).toBe(1);
    expect(h.logs.some((line) => line.includes("替换结果未知") && line.includes("确认替换结束后清理"))).toBe(true);
    expect(h.removed).toHaveLength(1);
  });

  test("missing remote exit status is treated as an unknown swap outcome", async () => {
    const h = uploadHarness(client({ execCommand: async (command) => command.startsWith("mkdir") ? success : { ...success, code: null } }));
    await expect(upload("/unused", target, { log: h.log }, h.deps)).rejects.toThrow("未收到远端退出状态");
    expect(h.clients()).toBe(1);
    expect(h.logs.some((line) => line.includes("替换结果未知"))).toBe(true);
    expect(h.removed).toHaveLength(1);
  });

  test("cleanup connection failure is logged without replacing the original error", async () => {
    const h = uploadHarness(client({ putFile: async () => { throw new Error("transfer failed"); } }), client({ connect: async () => { throw new Error("offline"); } }));
    await expect(upload("/unused", target, { log: h.log }, h.deps)).rejects.toThrow("transfer failed");
    expect(h.logs.some((line) => line.includes("未能确认清理") && line.includes("offline"))).toBe(true);
    expect(h.removed).toHaveLength(1);
  });

  test("periodic cleanup preserves an old archive until upload finishes", async () => {
    const base = scratch();
    const archive = join(base, "shipyard-quickbuypk-audit.tar.gz");
    await upload("/unused", target, {}, {
      tmpBase: base,
      stamp: () => "audit",
      run: async () => {
        writeFileSync(archive, "archive");
        utimesSync(archive, new Date(0), new Date(0));
        expect(isTempPathActive(archive)).toBe(true);
        expect(await cleanTmp(1, base)).toBe(0);
        expect(existsSync(archive)).toBe(true);
        return runSuccess;
      },
      sshFactory: () => client(),
    });
    expect(existsSync(archive)).toBe(false);
    expect(isTempPathActive(archive)).toBe(false);
  });
});

function pipelineDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    clone: async () => {}, headCommit: async () => undefined, runInstall: async () => {},
    runBuild: async () => ({ distPath: "/unused/dist" }), upload: async () => {},
    mkdtemp: async () => "/unused/work", rmrf: async () => {}, now: () => performance.now(),
    ...overrides,
  };
}

describe("working directory cleanup", () => {
  test("cleanup warnings with a throwing observer never reject the pipeline", async () => {
    const outcome = await runPipeline(SPEC, target, pipelineDeps({
      rmrf: async () => { throw new Error("cleanup failed"); },
    }), { onLog: () => { throw new Error("observer failed"); } });
    expect(outcome.ok).toBe(true);
    expect(isTempPathActive("/unused/work")).toBe(false);
  });

  test("retries transient removal failures before releasing ownership", async () => {
    let attempts = 0;
    const outcome = await runPipeline(SPEC, target, pipelineDeps({ rmrf: async (path) => {
      expect(isTempPathActive(path)).toBe(true);
      if (++attempts < 3) throw new Error("directory temporarily busy");
    } }));
    expect(outcome.ok).toBe(true);
    expect(attempts).toBe(3);
    expect(isTempPathActive("/unused/work")).toBe(false);
  });

  test("persistent cleanup failure warns while preserving the build failure", async () => {
    const logs: string[] = [];
    let attempts = 0;
    const outcome = await runPipeline(SPEC, target, pipelineDeps({
      runBuild: async () => { throw new Error("build failed"); },
      rmrf: async () => { attempts++; throw new Error("permission denied"); },
    }), { onLog: (_stage, _stream, text) => { logs.push(text); } });
    expect(outcome).toMatchObject({ ok: false, failedStage: "build", error: "build failed" });
    expect(attempts).toBe(3);
    expect(logs.some((line) => line.includes("清理失败") && line.includes("permission denied"))).toBe(true);
    expect(isTempPathActive("/unused/work")).toBe(false);
  });

  test("old active work directories survive sweeping while orphans are removed", async () => {
    const base = scratch();
    const active = join(base, "shipyard-active");
    const orphan = join(base, "shipyard-orphan");
    mkdirSync(active);
    mkdirSync(orphan);
    for (const path of [active, orphan]) utimesSync(path, new Date(0), new Date(0));
    const outcome = await runPipeline(SPEC, target, pipelineDeps({
      mkdtemp: async () => active,
      runBuild: async () => {
        expect(await cleanTmp(1, base)).toBe(1);
        expect(existsSync(active)).toBe(true);
        expect(existsSync(orphan)).toBe(false);
        throw new Error("build failed");
      },
      rmrf: async (path) => { rmSync(path, { recursive: true, force: true }); },
    }));
    expect(outcome.ok).toBe(false);
    expect(existsSync(active)).toBe(false);
    expect(isTempPathActive(active)).toBe(false);
  });
});
