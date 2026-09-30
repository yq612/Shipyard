import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnRunner } from "./process.ts";
import type { RunOptions, Runner, Toolchain } from "./types.ts";

// A pinned node goes first on PATH, so `node`, `npx` and every node-shebang
// CLI that `bun run build` starts resolve to it.
export function toolchainEnv(toolchain: Toolchain, basePath = process.env.PATH ?? ""): Record<string, string> {
  if (!toolchain.nodeBin) return {};
  return { PATH: basePath ? `${toolchain.nodeBin}${delimiter}${basePath}` : toolchain.nodeBin };
}

export function parseCommand(cmd: string): { file: string; args: string[] } {
  const parts = cmd.trim().split(/\s+/);
  const file = parts[0];
  if (!file) throw new Error(`无效的命令：${cmd}`);
  return { file, args: parts.slice(1) };
}

export async function runInstall(
  cwd: string,
  installCmd: string,
  opts: Omit<RunOptions, "cwd"> = {},
  run: Runner = spawnRunner,
): Promise<void> {
  const { file, args } = parseCommand(installCmd);
  await run(file, args, { ...opts, cwd });
}

export async function runBuild(
  cwd: string,
  buildCmd: string,
  dist: string,
  opts: Omit<RunOptions, "cwd"> = {},
  deps: { run?: Runner; dirExists?: (p: string) => boolean } = {},
): Promise<{ distPath: string }> {
  const run = deps.run ?? spawnRunner;
  const dirExists = deps.dirExists ?? existsSync;
  const { file, args } = parseCommand(buildCmd);
  await run(file, args, { ...opts, cwd });
  const distPath = join(cwd, dist);
  if (!dirExists(distPath)) {
    throw new Error(`构建产物目录不存在：${distPath}`);
  }
  return { distPath };
}
