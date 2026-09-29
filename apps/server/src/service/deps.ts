import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactUrl } from "@shipyard/shared";
import { runBuild, runInstall } from "../core/builder.ts";
import { upload } from "../core/deployer.ts";
import { buildCloneArgs, clone, headCommit } from "../core/git.ts";
import { isTempPathActive } from "../core/temp.ts";
import type { PipelineDeps, StageContext } from "../core/pipeline.ts";

export const TMP_PREFIX = "shipyard-";

const forward = (ctx: StageContext) => (stream: "stdout" | "stderr", line: string) => ctx.log(stream, redactUrl(line));

// The real side effects behind runPipeline: git, the build commands, SFTP.
// Every command is announced as a `system` log line before it runs.
export function realPipelineDeps(): PipelineDeps {
  return {
    async clone(repoUrl, branch, dest, ctx) {
      ctx.log("system", `$ git ${buildCloneArgs(redactUrl(repoUrl), branch, dest).join(" ")}`);
      await clone(repoUrl, branch, dest, { signal: ctx.signal, onLine: forward(ctx) });
    },
    headCommit: (dir, ctx) => headCommit(dir, { signal: ctx.signal }),
    async runInstall(cwd, installCmd, ctx) {
      ctx.log("system", `$ ${installCmd}（目录：${cwd}）`);
      await runInstall(cwd, installCmd, { signal: ctx.signal, onLine: forward(ctx) });
    },
    async runBuild(cwd, buildCmd, dist, ctx) {
      ctx.log("system", `$ ${buildCmd}（目录：${cwd}）`);
      return runBuild(cwd, buildCmd, dist, { signal: ctx.signal, onLine: forward(ctx) });
    },
    upload: (distPath, target, ctx) => upload(distPath, target, { signal: ctx.signal, log: ctx.log }),
    mkdtemp: () => mkdtemp(join(tmpdir(), TMP_PREFIX)),
    rmrf: (p) => rm(p, { recursive: true, force: true }),
    now: () => performance.now(),
  };
}

// Age limits orphan cleanup; the registry protects running jobs even when
// their directory mtime has not changed during a long build or upload.
export async function cleanTmp(olderThanMs = 0, base = tmpdir()): Promise<number> {
  let removed = 0;
  const cutoff = Date.now() - olderThanMs;
  for (const name of await readdir(base).catch(() => [] as string[])) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const path = join(base, name);
    if (isTempPathActive(path)) continue;
    try {
      if (olderThanMs > 0 && (await stat(path)).mtimeMs > cutoff) continue;
      if (isTempPathActive(path)) continue;
      await rm(path, { recursive: true, force: true });
      removed++;
    } catch {
      // raced with another cleanup, or permission issue — ignore
    }
  }
  return removed;
}
