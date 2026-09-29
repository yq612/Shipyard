// Ported from the CLI's builder / git / deployer / pipeline / notify tests,
// adapted to the new signatures (log callbacks, cancellation, commit info).
import { describe, expect, test } from "bun:test";
import { parseCommand, runBuild, runInstall } from "../src/core/builder.ts";
import {
  buildRemoteScript,
  buildTarArgs,
  shellQuote,
  stagingDir,
  upload,
  type SshClient,
} from "../src/core/deployer.ts";
import { buildCloneArgs, clone, headCommit, parseHeadCommit } from "../src/core/git.ts";
import { buildFeishuCard, genSign, sendFeishu, type CardInput } from "../src/core/notify.ts";
import { buildUploadTarget, runPipeline, type PipelineDeps } from "../src/core/pipeline.ts";
import { CancelledError, CommandError, spawnRunner } from "../src/core/process.ts";
import type { Runner, SshCredentials, UploadTarget } from "../src/core/types.ts";
import { SPEC } from "./helpers.ts";

const CREDS: SshCredentials = { user: "root", port: 22, privateKey: "PEM", keepPrevious: false };

describe("builder", () => {
  test("parseCommand splits a command string", () => {
    expect(parseCommand("bun install")).toEqual({ file: "bun", args: ["install"] });
    expect(parseCommand("  bun run build ")).toEqual({ file: "bun", args: ["run", "build"] });
    expect(() => parseCommand("   ")).toThrow();
  });

  test("runInstall runs the install command in cwd and forwards options", async () => {
    const calls: any[] = [];
    const run: Runner = async (file, args, opts) => {
      calls.push({ file, args, cwd: opts?.cwd, hasOnLine: !!opts?.onLine });
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await runInstall("/tmp/repo", "bun install", { onLine: () => {} }, run);
    expect(calls[0]).toEqual({ file: "bun", args: ["install"], cwd: "/tmp/repo", hasOnLine: true });
  });

  test("runBuild returns distPath when dist exists, throws otherwise", async () => {
    const run: Runner = async () => ({ stdout: "", stderr: "", exitCode: 0 });
    const res = await runBuild("/tmp/repo", "bun run build", "dist", {}, { run, dirExists: () => true });
    expect(res.distPath).toBe("/tmp/repo/dist");
    await expect(runBuild("/tmp/repo", "bun run build", "dist", {}, { run, dirExists: () => false })).rejects.toThrow(/dist/);
  });
});

describe("git", () => {
  test("buildCloneArgs produces a depth-1 branch clone", () => {
    expect(buildCloneArgs("https://x/y.git", "PK-QuickBuy", "/tmp/dest")).toEqual([
      "clone", "--depth", "1", "-b", "PK-QuickBuy", "https://x/y.git", "/tmp/dest",
    ]);
  });

  test("clone invokes the runner with git + clone args", async () => {
    const calls: { file: string; args: string[] }[] = [];
    const run: Runner = async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await clone("https://x/y.git", "br", "/tmp/dest", {}, run);
    expect(calls).toEqual([{ file: "git", args: buildCloneArgs("https://x/y.git", "br", "/tmp/dest") }]);
  });

  test("headCommit parses sha and subject", async () => {
    const run: Runner = async () => ({ stdout: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\nfix: 支付页文案\n", stderr: "", exitCode: 0 });
    expect(await headCommit("/tmp/dest", {}, run)).toEqual({ sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", message: "fix: 支付页文案" });
    expect(parseHeadCommit("not a sha")).toBeUndefined();
  });
});

describe("deployer", () => {
  test("buildTarArgs tars the dist contents", () => {
    expect(buildTarArgs("/tmp/repo/dist", "/tmp/x.tar.gz")).toEqual(["-C", "/tmp/repo/dist", "-czf", "/tmp/x.tar.gz", "."]);
  });

  test("stagingDir composes a unique /tmp path", () => {
    expect(stagingDir("quickbuypk", "1720000000000")).toBe("/tmp/ease-deploy-quickbuypk-1720000000000");
  });

  test("buildRemoteScript performs an atomic extract-and-swap", () => {
    expect(buildRemoteScript("/home/topup-web/quickbuypk/dist", "/tmp/s/dist.tar.gz", "/tmp/s")).toBe(
      "rm -rf /home/topup-web/quickbuypk/dist.tmp && " +
        "mkdir -p /home/topup-web/quickbuypk/dist.tmp && " +
        "tar -xzf /tmp/s/dist.tar.gz -C /home/topup-web/quickbuypk/dist.tmp && " +
        "rm -rf /home/topup-web/quickbuypk/dist && " +
        "mv /home/topup-web/quickbuypk/dist.tmp /home/topup-web/quickbuypk/dist && " +
        "rm -rf /tmp/s",
    );
  });

  test("buildRemoteScript keeps the previous build as dist.prev when asked", () => {
    const script = buildRemoteScript("/srv/dist", "/tmp/s/dist.tar.gz", "/tmp/s", true);
    expect(script).toContain("rm -rf /srv/dist.prev && { [ ! -e /srv/dist ] || mv /srv/dist /srv/dist.prev; }");
    expect(script).not.toContain("rm -rf /srv/dist &&");
    expect(script).toContain("mv /srv/dist.tmp /srv/dist");
  });

  test("shellQuote leaves safe paths alone and quotes the rest", () => {
    expect(shellQuote("/home/a-b/c_d.1/dist")).toBe("/home/a-b/c_d.1/dist");
    expect(shellQuote("/tmp/it's here")).toBe(`'/tmp/it'\\''s here'`);
  });

  function fakeTarget(): UploadTarget {
    return { ...CREDS, host: "1.2.3.4", remotePath: "/home/topup-web/srv/dist", server: "srv" };
  }

  test("upload tars locally, connects, stages, putFile, runs remote swap, cleans up, logs steps", async () => {
    const target = fakeTarget();
    const events: string[] = [];
    let connected: any = null;
    const fakeSsh: SshClient = {
      async connect(cfg) { connected = cfg; events.push("connect"); },
      async putFile(local, remote) { events.push(`putFile:${local}->${remote}`); },
      async execCommand(cmd) { events.push(`exec:${cmd}`); return { code: 0, stdout: "", stderr: "" }; },
      dispose() { events.push("dispose"); },
    };
    const runCalls: any[] = [];
    const run: Runner = async (file, args) => { runCalls.push({ file, args }); return { stdout: "", stderr: "", exitCode: 0 }; };
    const removed: string[] = [];
    const logs: string[] = [];

    await upload("/tmp/repo/dist", target, { log: (_s, t) => logs.push(t) }, {
      sshFactory: () => fakeSsh,
      run,
      stamp: () => "123",
      tmpBase: "/localtmp",
      rm: async (p) => { removed.push(p); },
      fileSize: async () => 12.3 * 1024 * 1024,
    });

    const local = "/localtmp/ease-deploy-srv-123.tar.gz";
    const staging = "/tmp/ease-deploy-srv-123";
    expect(runCalls[0]).toEqual({ file: "tar", args: buildTarArgs("/tmp/repo/dist", local) });
    expect(connected).toEqual({ host: "1.2.3.4", username: "root", port: 22, privateKey: "PEM" });
    expect(events).toEqual([
      "connect",
      `exec:mkdir -p ${staging}`,
      `putFile:${local}->${staging}/dist.tar.gz`,
      `exec:${buildRemoteScript(target.remotePath, `${staging}/dist.tar.gz`, staging)}`,
      "dispose",
    ]);
    expect(removed).toContain(local);
    expect(logs.some((l) => l.includes("12.3 MB"))).toBe(true);
    expect(logs.some((l) => l.includes("root@1.2.3.4:22"))).toBe(true);
    expect(logs.at(-1)).toContain("已发布到");
  });

  test("upload throws when the remote swap exits non-zero", async () => {
    const fakeSsh: SshClient = {
      async connect() {},
      async putFile() {},
      async execCommand(cmd) {
        return cmd.startsWith("mkdir") ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "boom" };
      },
      dispose() {},
    };
    await expect(
      upload("/tmp/repo/dist", fakeTarget(), {}, {
        sshFactory: () => fakeSsh,
        run: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        stamp: () => "123",
        tmpBase: "/localtmp",
        rm: async () => {},
        fileSize: async () => 1,
      }),
    ).rejects.toThrow(/boom/);
  });

  test("upload honours cancellation before the swap, but never interrupts the swap", async () => {
    const ctl = new AbortController();
    const execs: string[] = [];
    const ssh = (abortAt: "put" | "swap"): SshClient => ({
      async connect() {},
      async putFile() { if (abortAt === "put") ctl.abort(); },
      async execCommand(cmd) {
        execs.push(cmd);
        if (abortAt === "swap" && !cmd.startsWith("mkdir")) ctl.abort();
        return { code: 0, stdout: "", stderr: "" };
      },
      dispose() {},
    });
    const deps = { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }), stamp: () => "1", tmpBase: "/t", rm: async () => {}, fileSize: async () => 1 };

    await expect(upload("/d", fakeTarget(), { signal: ctl.signal }, { ...deps, sshFactory: () => ssh("put") })).rejects.toBeInstanceOf(CancelledError);
    expect(execs.some((c) => c.includes("mv "))).toBe(false);

    const ctl2 = new AbortController();
    execs.length = 0;
    const ssh2: SshClient = {
      async connect() {},
      async putFile() {},
      async execCommand(cmd) {
        execs.push(cmd);
        if (!cmd.startsWith("mkdir")) ctl2.abort(); // cancel arrives mid-swap
        return { code: 0, stdout: "", stderr: "" };
      },
      dispose() {},
    };
    await upload("/d", fakeTarget(), { signal: ctl2.signal }, { ...deps, sshFactory: () => ssh2 });
    expect(execs.some((c) => c.includes("mv "))).toBe(true);
  });
});

describe("process runner", () => {
  test("streams lines and resolves with output", async () => {
    const lines: string[] = [];
    const r = await spawnRunner("sh", ["-c", "echo one; echo two 1>&2; printf 'a\\rb\\n'"], {
      onLine: (stream, line) => lines.push(`${stream}:${line}`),
    });
    expect(r.exitCode).toBe(0);
    expect(lines).toContain("stdout:one");
    expect(lines).toContain("stderr:two");
    expect(lines).toContain("stdout:b"); // \r redraws keep the last segment
  });

  test("rejects with the stderr tail on non-zero exit", async () => {
    const err = await spawnRunner("sh", ["-c", "echo nope 1>&2; exit 3"]).catch((e) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect(err.exitCode).toBe(3);
    expect(err.message).toContain("nope");
  });

  test("abort kills the whole process group", async () => {
    const ctl = new AbortController();
    const marker = `ease-deploy-test-${Date.now()}`;
    const p = spawnRunner("sh", ["-c", `sleep 30 & sleep 30; echo ${marker}`], { signal: ctl.signal });
    await Bun.sleep(100);
    ctl.abort();
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    await Bun.sleep(100);
    const left = await spawnRunner("sh", ["-c", "pgrep -f 'sleep 30' | wc -l"]);
    // other test runs may have their own sleeps, but ours must be gone
    expect(Number(left.stdout.trim())).toBe(0);
  });
});

function baseDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  let clock = 0;
  return {
    clone: async () => {},
    headCommit: async () => ({ sha: "abcdef1234567", message: "feat: x" }),
    runInstall: async () => {},
    runBuild: async () => ({ distPath: "/tmp/x/dist" }),
    upload: async () => {},
    mkdtemp: async () => "/tmp/x",
    rmrf: async () => {},
    now: () => (clock += 1000), // each call advances 1s
    ...overrides,
  };
}

describe("pipeline", () => {
  test("buildUploadTarget combines the spec and credentials", () => {
    expect(buildUploadTarget(SPEC, CREDS)).toEqual({
      ...CREDS,
      host: "1.2.3.4",
      server: "quickbuypk",
      remotePath: "/home/topup-web/quickbuypk/dist",
    });
  });

  test("runs all stages in order, reports ok and the commit", async () => {
    const order: string[] = [];
    const commits: string[] = [];
    const result = await runPipeline(SPEC, CREDS, baseDeps({
      clone: async () => { order.push("clone"); },
      runInstall: async () => { order.push("install"); },
      runBuild: async () => { order.push("build"); return { distPath: "/tmp/x/dist" }; },
      upload: async () => { order.push("upload"); },
      rmrf: async () => { order.push("cleanup"); },
    }), { onCommit: (c) => commits.push(c.sha) });
    expect(order).toEqual(["clone", "install", "build", "upload", "cleanup"]);
    expect(result.ok).toBe(true);
    expect(result.stages.map((s) => s.stage)).toEqual(["clone", "install", "build", "upload"]);
    expect(result.failedStage).toBeUndefined();
    expect(result.commit?.sha).toBe("abcdef1234567");
    expect(commits).toEqual(["abcdef1234567"]);
  });

  test("stops at the failed stage, still cleans up, tags the stage", async () => {
    let cleaned = false;
    let uploaded = false;
    const errors: string[] = [];
    const result = await runPipeline(SPEC, CREDS, baseDeps({
      runBuild: async () => { throw new Error("build blew up"); },
      upload: async () => { uploaded = true; },
      rmrf: async () => { cleaned = true; },
    }), { onStageError: (stage, _ms, err) => errors.push(`${stage}:${err}`) });
    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe("build");
    expect(result.error).toContain("build blew up");
    expect(result.cancelled).toBeUndefined();
    expect(uploaded).toBe(false);
    expect(cleaned).toBe(true);
    expect(result.stages.map((s) => s.stage)).toEqual(["clone", "install"]);
    expect(errors).toEqual(["build:build blew up"]);
  });

  test("cancellation mid-stage is reported as cancelled, not as a failure", async () => {
    const ctl = new AbortController();
    const errors: string[] = [];
    const result = await runPipeline(SPEC, CREDS, baseDeps({
      runInstall: async () => { ctl.abort(); throw new CancelledError(); },
    }), { onStageError: (s) => errors.push(s) }, ctl.signal);
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.failedStage).toBe("install");
    expect(errors).toEqual([]);
  });

  test("an already-aborted signal skips every stage", async () => {
    const ctl = new AbortController();
    ctl.abort();
    let cloned = false;
    const result = await runPipeline(SPEC, CREDS, baseDeps({ clone: async () => { cloned = true; } }), {}, ctl.signal);
    expect(cloned).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.failedStage).toBe("clone");
  });

  test("failure to create the temp dir is a clone-stage failure", async () => {
    const result = await runPipeline(SPEC, CREDS, baseDeps({ mkdtemp: async () => { throw new Error("disk full"); } }));
    expect(result).toMatchObject({ ok: false, failedStage: "clone", error: "disk full" });
  });

  test("hook failures never change a successful deployment", async () => {
    const result = await runPipeline(SPEC, CREDS, baseDeps(), {
      onPipelineStart: () => { throw new Error("ui start"); },
      onStageStart: () => { throw new Error("ui stage start"); },
      onStageDone: () => { throw new Error("ui stage done"); },
      onCommit: () => { throw new Error("ui commit"); },
      onLog: () => { throw new Error("ui log"); },
    });
    expect(result.ok).toBe(true);
  });

  test("stage logs are tagged with their stage", async () => {
    const logs: string[] = [];
    await runPipeline(SPEC, CREDS, baseDeps({
      runInstall: async (_cwd, _cmd, ctx) => { ctx.log("stdout", "installing"); },
    }), { onLog: (stage, stream, text) => logs.push(`${stage}:${stream}:${text}`) });
    expect(logs).toContain("install:stdout:installing");
    expect(logs.some((l) => l.startsWith("clone:system:提交 abcdef1"))).toBe(true);
    expect(logs.some((l) => l.startsWith("upload:system:✔ 上传发布完成"))).toBe(true);
  });
});

describe("notify", () => {
  const input = (over: Partial<CardInput> = {}): CardInput => ({
    deploymentId: 42,
    status: "succeeded",
    countryName: "印尼",
    operatorName: "张三",
    operatorIp: "10.8.1.2",
    totalMs: 125000,
    envs: [
      { name: "A", status: "done", commitSha: "a1b2c3d4e5", totalMs: 60000 },
      { name: "B", status: "done", totalMs: 70000 },
    ],
    ...over,
  });
  const content = (card: ReturnType<typeof buildFeishuCard>) => (card.card.elements[0] as any).text.content as string;

  test("success card: green header, keyword, id, operator, commit, detail link", () => {
    const card = buildFeishuCard(input({ detailUrl: "https://deploy/deployments/42" }));
    expect(card.card.header.template).toBe("green");
    expect(card.card.header.title.content).toContain("Ease-Deploy"); // 关键词，配合自定义关键词安全设置
    expect(card.card.header.title.content).toContain("#42");
    expect(card.card.header.title.content).toContain("印尼");
    const text = content(card);
    expect(text).toContain("成功 2/2");
    expect(text).toContain("张三（10.8.1.2）");
    expect(text).toContain("a1b2c3d");
    expect(JSON.stringify(card.card.elements[1])).toContain("https://deploy/deployments/42");
  });

  test("partial / cancelled cards pick their colour and explain failures", () => {
    const card = buildFeishuCard(input({
      status: "partial",
      envs: [
        { name: "A", status: "done" },
        { name: "B", status: "error", failedStage: "build", error: "tsc boom" },
        { name: "C", status: "cancelled" },
      ],
    }));
    expect(card.card.header.template).toBe("orange");
    expect(content(card)).toContain("B · 失败于「构建产物」：tsc boom");
    expect(content(card)).toContain("C · 已取消");
    expect(buildFeishuCard(input({ status: "cancelled" })).card.header.template).toBe("grey");
    expect(buildFeishuCard(input()).card.elements).toHaveLength(1);
  });

  test("genSign is deterministic and timestamp-sensitive", () => {
    const a = genSign("xyz", 1700000000);
    expect(a).toBe(genSign("xyz", 1700000000));
    expect(a).not.toBe(genSign("xyz", 1700000001));
  });

  test("sendFeishu posts the card, signs only with a secret, reports Feishu errors", async () => {
    let body: any = null;
    const ok = (async (_url: any, init: any) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ code: 0 }) };
    }) as unknown as typeof fetch;
    const card = buildFeishuCard(input());
    expect((await sendFeishu("https://hook/x", card, { deps: { fetch: ok } })).ok).toBe(true);
    expect(body.msg_type).toBe("interactive");
    expect(body.sign).toBeUndefined();

    await sendFeishu("https://hook/x", card, { secret: "s3cret", deps: { fetch: ok, now: () => 1700000000 } });
    expect(body.timestamp).toBe("1700000000");
    expect(body.sign).toBe(genSign("s3cret", 1700000000));

    const bad = (async () => ({ ok: true, json: async () => ({ code: 19021, msg: "sign match fail" }) })) as unknown as typeof fetch;
    const r = await sendFeishu("https://hook/x", card, { deps: { fetch: bad } });
    expect(r).toEqual({ ok: false, error: "sign match fail" });
  });
});
