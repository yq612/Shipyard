import type { CommitInfo } from "@shipyard/shared";
import { spawnRunner } from "./process.ts";
import type { GitAuth, RunOptions, Runner } from "./types.ts";

export function buildCloneArgs(repoUrl: string, branch: string, dest: string): string[] {
  return ["clone", "--depth", "1", "-b", branch, repoUrl, dest];
}

// The token reaches git through a one-off credential helper that echoes two
// environment variables. It never appears in argv, the clone's .git/config or
// git's error output. Any helper from the user's git config (e.g. a keychain)
// is cleared first, so only the configured token is ever used.
const CREDENTIAL_HELPER = `!f() { test "$1" = get && printf 'username=%s\\npassword=%s\\n' "$SHIPYARD_GIT_USERNAME" "$SHIPYARD_GIT_TOKEN"; }; f`;

export function gitAuthEnv(auth: GitAuth): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: CREDENTIAL_HELPER,
    SHIPYARD_GIT_USERNAME: auth.username,
    SHIPYARD_GIT_TOKEN: auth.token,
  };
}

export async function clone(
  repoUrl: string,
  branch: string,
  dest: string,
  opts: RunOptions & { auth?: GitAuth | null } = {},
  run: Runner = spawnRunner,
): Promise<void> {
  const { auth, ...rest } = opts;
  await run("git", buildCloneArgs(repoUrl, branch, dest), auth ? { ...rest, env: { ...rest.env, ...gitAuthEnv(auth) } } : rest);
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
