import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuild } from "../src/core/builder.ts";

test("bun run build uses real Node for a framework CLI with a node shebang", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "build-runtime-test-"));
  try {
    await mkdir(join(cwd, "node_modules/.bin"), { recursive: true });
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { build: "framework-build" } }));
    const cli = join(cwd, "node_modules/.bin/framework-build");
    await writeFile(cli, `#!/usr/bin/env node
if (process.versions.bun) throw new Error('Framework CLI unexpectedly running under Bun');
require('node:fs').mkdirSync('dist');
`);
    await chmod(cli, 0o755);
    expect(await runBuild(cwd, "bun run build", "dist")).toEqual({ distPath: join(cwd, "dist") });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
