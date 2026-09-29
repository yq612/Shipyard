import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { LogLine } from "@ease-deploy/shared";

export const MAX_LINE_BYTES = 4 * 1024;
export const MAX_LOG_BYTES = 20 * 1024 * 1024;

export type LogListener = (msg: { type: "line"; line: LogLine } | { type: "end" }) => void;

interface Writer {
  fd: number;
  bytes: number;
  capped: boolean;
}

function truncateLine(text: string): string {
  if (text.length * 3 <= MAX_LINE_BYTES) return text; // fast path: can't exceed even if all 3-byte chars
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= MAX_LINE_BYTES) return text;
  return new TextDecoder().decode(bytes.slice(0, MAX_LINE_BYTES)).replace(/�$/, "") + " …（该行过长，已截断）";
}

// One JSON-lines file per environment: data/logs/<deploymentId>/<idx>.log.
// Writes are synchronous so a reader that subscribes and then reads the file
// in the same tick sees every line exactly once.
export class LogStore {
  private writers = new Map<string, Writer>();
  private listeners = new Map<string, Set<LogListener>>();

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private key(deploymentId: number, idx: number): string {
    return `${deploymentId}/${idx}`;
  }

  path(deploymentId: number, idx: number): string {
    return join(this.dir, String(deploymentId), `${idx}.log`);
  }

  private writer(deploymentId: number, idx: number): Writer {
    const key = this.key(deploymentId, idx);
    let w = this.writers.get(key);
    if (!w) {
      mkdirSync(join(this.dir, String(deploymentId)), { recursive: true });
      w = { fd: openSync(this.path(deploymentId, idx), "a"), bytes: 0, capped: false };
      this.writers.set(key, w);
    }
    return w;
  }

  append(deploymentId: number, idx: number, line: LogLine): void {
    const w = this.writer(deploymentId, idx);
    if (w.capped) return;
    let entry: LogLine = { ...line, text: truncateLine(line.text) };
    let data = JSON.stringify(entry) + "\n";
    if (w.bytes + data.length > MAX_LOG_BYTES) {
      w.capped = true;
      entry = { ts: line.ts, stream: "system", ...(line.stage ? { stage: line.stage } : {}), text: "! 日志超过 20MB，之后的输出不再记录" };
      data = JSON.stringify(entry) + "\n";
    }
    w.bytes += writeSync(w.fd, data);
    this.emit(this.key(deploymentId, idx), { type: "line", line: entry });
  }

  // Closes the log for good; followers get `end`. Safe to call without any
  // line ever written (e.g. an env cancelled while still queued).
  end(deploymentId: number, idx: number): void {
    const key = this.key(deploymentId, idx);
    const w = this.writers.get(key);
    if (w) {
      closeSync(w.fd);
      this.writers.delete(key);
    }
    this.emit(key, { type: "end" });
    this.listeners.delete(key);
  }

  isOpen(deploymentId: number, idx: number): boolean {
    return this.writers.has(this.key(deploymentId, idx));
  }

  subscribe(deploymentId: number, idx: number, listener: LogListener): () => void {
    const key = this.key(deploymentId, idx);
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(key) === set) this.listeners.delete(key);
    };
  }

  private emit(key: string, msg: Parameters<LogListener>[0]): void {
    for (const listener of this.listeners.get(key) ?? []) {
      try {
        listener(msg);
      } catch {
        // a broken follower must not affect the deployment
      }
    }
  }

  readAll(deploymentId: number, idx: number): LogLine[] {
    const path = this.path(deploymentId, idx);
    if (!existsSync(path)) return [];
    const lines: LogLine[] = [];
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      if (!raw) continue;
      try {
        lines.push(JSON.parse(raw));
      } catch {
        // a torn last line after a crash — skip it
      }
    }
    return lines;
  }

  removeDeployment(deploymentId: number): void {
    rmSync(join(this.dir, String(deploymentId)), { recursive: true, force: true });
  }

  closeAll(): void {
    for (const w of this.writers.values()) closeSync(w.fd);
    this.writers.clear();
  }
}
