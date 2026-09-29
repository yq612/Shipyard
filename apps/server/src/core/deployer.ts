import { rm as fsRm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeSSH } from "node-ssh";
import { formatDuration } from "@shipyard/shared";
import { CancelledError, spawnRunner, throwIfAborted } from "./process.ts";
import type { LogFn, Runner, UploadTarget } from "./types.ts";

export interface SshClient {
  connect(cfg: { host: string; username: string; port: number; privateKey: string }): Promise<void>;
  putFile(local: string, remote: string): Promise<void>;
  execCommand(cmd: string): Promise<{ code: number; stdout: string; stderr: string }>;
  dispose(): void;
}

export function createNodeSshClient(): SshClient {
  const ssh = new NodeSSH();
  return {
    async connect(cfg) {
      await ssh.connect({ ...cfg, readyTimeout: 20_000 });
    },
    async putFile(local, remote) {
      await ssh.putFile(local, remote);
    },
    async execCommand(cmd) {
      const r = await ssh.execCommand(cmd);
      return { code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr };
    },
    dispose() {
      ssh.dispose();
    },
  };
}

export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function buildTarArgs(distPath: string, tarPath: string): string[] {
  return ["-C", distPath, "-czf", tarPath, "."];
}

export function stagingDir(server: string, ts: string): string {
  return `/tmp/ease-deploy-${server}-${ts}`;
}

// Extract into `<remotePath>.tmp`, then swap it in with a single `mv`, so the
// live directory is never half-written. With keepPrevious the replaced build
// is kept as `<remotePath>.prev` for manual rollback.
export function buildRemoteScript(
  remotePath: string,
  remoteTarFile: string,
  staging: string,
  keepPrevious = false,
): string {
  const live = shellQuote(remotePath);
  const tmp = shellQuote(`${remotePath}.tmp`);
  const prev = shellQuote(`${remotePath}.prev`);
  const replace = keepPrevious
    ? [`rm -rf ${prev}`, `{ [ ! -e ${live} ] || mv ${live} ${prev}; }`]
    : [`rm -rf ${live}`];
  return [
    `rm -rf ${tmp}`,
    `mkdir -p ${tmp}`,
    `tar -xzf ${shellQuote(remoteTarFile)} -C ${tmp}`,
    ...replace,
    `mv ${tmp} ${live}`,
    `rm -rf ${shellQuote(staging)}`,
  ].join(" && ");
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface UploadDeps {
  sshFactory: () => SshClient;
  run: Runner;
  stamp: () => string;
  tmpBase: string;
  rm: (p: string) => Promise<void>;
  fileSize: (p: string) => Promise<number>;
  clock: () => number;
}

export interface UploadOptions {
  signal?: AbortSignal;
  log?: LogFn;
}

// tar → SFTP to /tmp staging → remote extract & atomic swap.
// Cancellation is honoured until the remote swap starts; once it has started
// it runs to completion (it is short and atomic) and the real result counts.
export async function upload(
  distPath: string,
  target: UploadTarget,
  opts: UploadOptions = {},
  deps: Partial<UploadDeps> = {},
): Promise<void> {
  const sshFactory = deps.sshFactory ?? createNodeSshClient;
  const run = deps.run ?? spawnRunner;
  const stamp = deps.stamp ?? (() => Date.now().toString());
  const tmpBase = deps.tmpBase ?? tmpdir();
  const rm = deps.rm ?? ((p: string) => fsRm(p, { force: true }));
  const fileSize = deps.fileSize ?? (async (p: string) => (await stat(p)).size);
  const clock = deps.clock ?? (() => performance.now());
  const log = opts.log ?? (() => {});
  const { signal } = opts;

  const ts = stamp();
  const localTar = join(tmpBase, `ease-deploy-${target.server}-${ts}.tar.gz`);
  const staging = stagingDir(target.server, ts);
  const remoteTarFile = `${staging}/dist.tar.gz`;

  throwIfAborted(signal);
  log("system", `打包 ${distPath}`);
  await run("tar", buildTarArgs(distPath, localTar), { signal });

  const ssh = sshFactory();
  const onAbort = () => ssh.dispose();
  try {
    const size = await fileSize(localTar).catch(() => undefined);
    log("system", `✔ 打包完成${size === undefined ? "" : `（${formatSize(size)}）`}`);

    throwIfAborted(signal);
    signal?.addEventListener("abort", onAbort, { once: true });
    log("system", `连接 ${target.user}@${target.host}:${target.port}`);
    await ssh.connect({ host: target.host, username: target.user, port: target.port, privateKey: target.privateKey });

    log("system", `创建远端暂存目录 ${staging}`);
    const mk = await ssh.execCommand(`mkdir -p ${shellQuote(staging)}`);
    if (mk.code !== 0) throw new Error(`创建远端暂存目录失败：${mk.stderr}`);

    const t0 = clock();
    await ssh.putFile(localTar, remoteTarFile);
    log("system", `✔ 上传完成（${formatDuration(clock() - t0)}）`);

    // Last chance to cancel. From here on the swap runs to completion.
    throwIfAborted(signal);
    signal?.removeEventListener("abort", onAbort);

    log("system", `远端解压并替换 ${target.remotePath}${target.keepPrevious ? `（旧版本保留为 ${target.remotePath}.prev）` : ""}`);
    const swap = await ssh.execCommand(buildRemoteScript(target.remotePath, remoteTarFile, staging, target.keepPrevious));
    if (swap.code !== 0) throw new Error(`远端发布失败：${swap.stderr || swap.stdout}`);
    log("system", `✔ 已发布到 ${target.host}:${target.remotePath}`);
  } catch (e) {
    if (signal?.aborted && !(e instanceof CancelledError)) throw new CancelledError();
    throw e;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    ssh.dispose();
    await rm(localTar).catch(() => {});
  }
}
