import { spawn } from "node:child_process";
import { redactUrl } from "@ease-deploy/shared";
import type { Runner } from "./types.ts";

export class CancelledError extends Error {
  constructor() {
    super("已取消");
    this.name = "CancelledError";
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CancelledError();
}

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly tail: string[],
  ) {
    const head = exitCode === null ? `命令被终止：${command}` : `命令失败（退出码 ${exitCode}）：${command}`;
    super(tail.length ? `${head}\n${tail.join("\n")}` : head);
    this.name = "CommandError";
  }
}

const ERROR_TAIL_LINES = 30;
const MAX_CAPTURE = 1024 * 1024;
const KILL_GRACE_MS = 5000;

// Keeps the last `size` lines, for the error summary.
class TailBuffer {
  private lines: string[] = [];
  constructor(private size: number) {}
  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.size) this.lines.shift();
  }
  get(): string[] {
    return this.lines.slice();
  }
}

// Splits a byte stream into lines. A bare `\r` (progress-bar redraw) keeps only
// the last segment, like a terminal would.
function lineSplitter(emit: (line: string) => void) {
  const decoder = new TextDecoder();
  let partial = "";
  const out = (raw: string) => {
    const line = raw.split("\r").filter(Boolean).pop() ?? "";
    if (line.trim()) emit(line);
  };
  return {
    push(chunk: Uint8Array) {
      partial += decoder.decode(chunk, { stream: true });
      const parts = partial.split("\n");
      partial = parts.pop() ?? "";
      for (const part of parts) out(part);
    },
    end() {
      partial += decoder.decode();
      if (partial) out(partial);
      partial = "";
    },
  };
}

// Kills the whole process group: `bun run build` spawns vite & friends, and
// killing only the parent would leave them running as orphans.
function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

export const spawnRunner: Runner = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const { signal } = opts;
    if (signal?.aborted) return reject(new CancelledError());

    const command = redactUrl([file, ...args].join(" "));
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        // Never block on a credential prompt; keep colours for the web log view.
        GIT_TERMINAL_PROMPT: "0",
        FORCE_COLOR: "1",
        ...opts.env,
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stderrTail = new TailBuffer(ERROR_TAIL_LINES);
    const stdoutTail = new TailBuffer(ERROR_TAIL_LINES);
    let stdout = "";
    let stderr = "";
    const capture = (acc: string, line: string) => (acc.length < MAX_CAPTURE ? acc + line + "\n" : acc);

    const outLines = lineSplitter((line) => {
      stdout = capture(stdout, line);
      stdoutTail.push(line);
      opts.onLine?.("stdout", line);
    });
    const errLines = lineSplitter((line) => {
      stderr = capture(stderr, line);
      stderrTail.push(line);
      opts.onLine?.("stderr", line);
    });
    child.stdout?.on("data", (chunk: Uint8Array) => outLines.push(chunk));
    child.stderr?.on("data", (chunk: Uint8Array) => errLines.push(chunk));

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      killTree(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killTree(child.pid, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
      fn();
    };

    child.on("error", (err) => finish(() => reject(new Error(`无法执行 ${file}：${err.message}`))));
    child.on("close", (code) => {
      outLines.end();
      errLines.end();
      finish(() => {
        if (signal?.aborted) return reject(new CancelledError());
        if (code === 0) return resolve({ stdout, stderr, exitCode: 0 });
        const tail = stderrTail.get().length ? stderrTail.get() : stdoutTail.get();
        reject(new CommandError(command, code, tail.map(redactUrl)));
      });
    });
  });
