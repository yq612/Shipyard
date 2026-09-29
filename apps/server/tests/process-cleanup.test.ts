import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CancelledError, CommandError, spawnRunner } from "../src/core/process.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // An exited child awaiting its container init is no longer doing work.
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
    }
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("process group cleanup", () => {
  test("cancellation escalates when the command leader itself ignores TERM", async () => {
    const ctl = new AbortController();
    let ready = false;
    const run = spawnRunner("sh", ["-c", "trap '' TERM; echo ready; while :; do sleep 1; done"], {
      signal: ctl.signal,
      onLine: () => { ready = true; },
    }).catch((e: unknown) => e);
    for (let i = 0; !ready && i < 100; i++) await Bun.sleep(10);
    ctl.abort();
    expect(await run).toBeInstanceOf(CancelledError);
    expect(ready).toBe(true);
  }, 10_000);

  for (const mode of ["success", "failure", "cancel"] as const) {
    test(`${mode} stops descendants even when they ignore TERM and close their pipes`, async () => {
      const ctl = new AbortController();
      let parent = 0;
      let descendant = 0;
      const ending = mode === "cancel" ? "sleep 30" : `sleep 0.2; exit ${mode === "success" ? 0 : 3}`;
      const run = spawnRunner("sh", ["-c",
        `(trap '' TERM; while :; do sleep 1; done) >/dev/null 2>&1 & echo "$$ $!"; ${ending}`,
      ], {
        signal: ctl.signal,
        onLine: (_stream, line) => { [parent, descendant] = line.split(" ").map(Number) as [number, number]; },
      }).catch((e: unknown) => e);
      try {
        for (let i = 0; !descendant && i < 100; i++) await Bun.sleep(10);
        expect(descendant).toBeGreaterThan(0);
        if (mode === "cancel") {
          await Bun.sleep(100); // let the descendant install its TERM handler
          ctl.abort();
        }
        const result = await run;
        if (mode === "cancel") expect(result).toBeInstanceOf(CancelledError);
        else if (mode === "failure") expect(result).toBeInstanceOf(CommandError);
        else expect(result).toMatchObject({ exitCode: 0 });
        for (let i = 0; alive(descendant) && i < 100; i++) await Bun.sleep(10);
        expect(alive(descendant)).toBe(false);
      } finally {
        ctl.abort();
        if (parent) { try { process.kill(-parent, "SIGKILL"); } catch {} }
        if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch {} }
      }
    });
  }

  test("a background descendant holding output pipes cannot keep a completed stage open", async () => {
    const ctl = new AbortController();
    const run = spawnRunner("sh", ["-c", "sleep 30 & exit 0"], { signal: ctl.signal });
    const timeout = setTimeout(() => ctl.abort(), 1500);
    try {
      expect((await run).exitCode).toBe(0);
      expect(ctl.signal.aborted).toBe(false);
    } finally {
      clearTimeout(timeout);
      ctl.abort();
    }
  });
});
