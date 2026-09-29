import type { CommitInfo } from "@shipyard/shared";
import { spawnRunner } from "./process.ts";
import type { RunOptions, Runner } from "./types.ts";

export function buildCloneArgs(repoUrl: string, branch: string, dest: string): string[] {
  return ["clone", "--depth", "1", "-b", branch, repoUrl, dest];
}

export async function clone(
  repoUrl: string,
  branch: string,
  dest: string,
  opts: RunOptions = {},
  run: Runner = spawnRunner,
): Promise<void> {
  await run("git", buildCloneArgs(repoUrl, branch, dest), opts);
}

export function parseHeadCommit(stdout: string): CommitInfo | undefined {
  const [sha, ...rest] = stdout.trim().split("\n");
  if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha)) return undefined;
  return { sha, message: rest.join("\n").trim() };
}

export async function headCommit(
  dir: string,
  opts: RunOptions = {},
  run: Runner = spawnRunner,
): Promise<CommitInfo | undefined> {
  const { stdout } = await run("git", ["-C", dir, "log", "-1", "--format=%H%n%s"], { signal: opts.signal });
  return parseHeadCommit(stdout);
}
