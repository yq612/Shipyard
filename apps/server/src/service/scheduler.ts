export interface Job {
  id: string;
  run: () => Promise<void>;
}

// First-come-first-served queue with a global concurrency limit. Each
// environment of a deployment is one job; heavy `bun install` + build steps
// must not all run at once.
export class Scheduler {
  private queue: Job[] = [];
  private running = new Set<string>();

  constructor(private max: number) {}

  setMax(max: number): void {
    this.max = Math.max(1, max);
    this.pump();
  }

  get maxConcurrent(): number {
    return this.max;
  }

  get runningCount(): number {
    return this.running.size;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  enqueue(job: Job): void {
    this.queue.push(job);
    this.pump();
  }

  // Removes a job that has not started yet. Returns false if it is already running (or unknown).
  dequeue(id: string): boolean {
    const i = this.queue.findIndex((job) => job.id === id);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    return true;
  }

  isQueued(id: string): boolean {
    return this.queue.some((job) => job.id === id);
  }

  private pump(): void {
    while (this.running.size < this.max && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running.add(job.id);
      void Promise.resolve()
        .then(job.run)
        .catch((e) => console.error(`[scheduler] job ${job.id} crashed:`, e))
        .finally(() => {
          this.running.delete(job.id);
          this.pump();
        });
    }
  }
}
