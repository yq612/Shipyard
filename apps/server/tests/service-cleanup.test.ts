import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { DeploymentMessage } from "../src/service/deployments.ts";
import { OPERATOR, setupService, until, type TestEnv } from "./helpers.ts";

let env: TestEnv | undefined;
const restore: Array<() => void> = [];
afterEach(async () => {
  for (const fn of restore.splice(0).reverse()) fn();
  env?.cleanup();
  env?.repo.db.close();
  env = undefined;
});

function captureWarnings() {
  const messages: string[] = [];
  const spy = spyOn(console, "warn").mockImplementation((...args) => { messages.push(args.join(" ")); });
  restore.push(() => spy.mockRestore());
  return messages;
}

function internals(service: TestEnv["service"]) {
  return service as unknown as {
    runtimes: Map<number, { controllers: Map<number, AbortController> }>;
    listeners: Map<number, unknown>;
    closing: Set<number>;
    finalizing: Set<Promise<void>>;
  };
}

async function finished(e: TestEnv, id: number) {
  await until(() => !e.service.isActive(id) && e.service.scheduler.runningCount === 0);
  await e.service.idle();
  expect(e.service.holderOf("1.1.1.1", "/home/topup-web/quickbuypk/dist")).toBeNull();
  expect(e.logs.isOpen(id, 0)).toBe(false);
  const state = internals(e.service);
  expect(state.runtimes.size).toBe(0);
  expect(state.closing.size).toBe(0);
  expect(state.finalizing.size).toBe(0);
  expect(state.listeners.size).toBe(0);
}

describe("service resource cleanup after observer failures", () => {
  test("initial database write failure never starts the pipeline and releases controllers and locks", async () => {
    env = setupService();
    const warnings = captureWarnings();
    const write = env.repo.updateEnv.bind(env.repo);
    const spy = spyOn(env.repo, "updateEnv").mockImplementation((id, idx, patch) => {
      if (patch.status === "running") throw new Error("disk full https://oauth2:private-token@repo.invalid/x");
      write(id, idx, patch);
    });
    restore.push(() => spy.mockRestore());
    const { id } = env.service.create("PK", ["QuickBuy 环境"], OPERATOR);
    const rt = internals(env.service).runtimes.get(id)!;
    await finished(env, id);
    expect(rt.controllers.size).toBe(0);
    expect(env.pipeline.calls).toEqual([]);
    expect(env.service.detail(id)!.state.tasks[0]!.status).toBe("interrupted");
    expect(env.service.status().shuttingDown).toBe(true);
    expect(() => env!.service.create("PK", ["QuickBuy 环境"], OPERATOR)).toThrow("发布记录保存异常");
    expect(warnings.join("\n")).toContain("https://***@repo.invalid/x");
    expect(warnings.join("\n")).not.toContain("private-token");
  });

  test("final log write failure cannot change a successful result or retain its writer", async () => {
    env = setupService();
    const warnings = captureWarnings();
    const append = env.logs.append.bind(env.logs);
    const spy = spyOn(env.logs, "append").mockImplementation((id, idx, line) => {
      if (line.text === "✔ 发布成功") throw new Error("log filesystem full");
      append(id, idx, line);
    });
    restore.push(() => spy.mockRestore());
    const { id } = env.service.create("PK", ["QuickBuy 环境"], OPERATOR);
    const rt = internals(env.service).runtimes.get(id)!;
    env.pipeline.pass("PK-QuickBuy");
    await finished(env, id);
    expect(rt.controllers.size).toBe(0);
    expect(env.repo.envs(id)[0]!.status).toBe("done");
    expect(env.repo.summary(id)!.status).toBe("succeeded");
    expect(env.service.status().shuttingDown).toBe(false);
    expect(warnings.join("\n")).toContain("log filesystem full");
    expect(env.pipeline.calls.filter((call) => call.endsWith(":upload"))).toHaveLength(1);
    expect(() => env!.service.retry(id, OPERATOR)).toThrow("没有失败、取消或中断的环境");
  });

  test("terminal transaction failure releases resources and pauses new work without fabricating a failed outcome", async () => {
    env = setupService();
    captureWarnings();
    const write = env.repo.updateEnv.bind(env.repo);
    const spy = spyOn(env.repo, "updateEnv").mockImplementation((id, idx, patch) => {
      if (patch.status === "done") throw new Error("terminal write failed");
      write(id, idx, patch);
    });
    restore.push(() => spy.mockRestore());
    const { id } = env.service.create("PK", ["QuickBuy 环境"], OPERATOR);
    const rt = internals(env.service).runtimes.get(id)!;
    const messages: DeploymentMessage[] = [];
    env.service.subscribe(id, (message) => { messages.push(message); });
    env.pipeline.pass("PK-QuickBuy");
    await finished(env, id);
    expect(rt.controllers.size).toBe(0);
    const outcomes = messages.flatMap((message) => message.type === "progress" && message.event.type === "pipelineDone" ? [message.event.outcome] : []);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.ok).toBe(true);
    expect(messages.at(-1)!.type).toBe("end");
    expect(env.pipeline.calls.filter((call) => call.endsWith(":upload"))).toHaveLength(1);
    expect(env.service.status().shuttingDown).toBe(true);
    expect(() => env!.service.create("PK", ["QuickBuy 环境"], OPERATOR)).toThrow("发布记录保存异常");
    expect(() => env!.service.retry(id, OPERATOR)).toThrow();
  });

  test("progress persistence failure still reduces the in-memory state and completes exactly once", async () => {
    env = setupService();
    captureWarnings();
    const append = env.repo.appendEvent.bind(env.repo);
    const spy = spyOn(env.repo, "appendEvent").mockImplementation((id, seq, event) => {
      if (event.type === "stageStart" && event.stage === "build") throw new Error("event write failed");
      append(id, seq, event);
    });
    restore.push(() => spy.mockRestore());
    const { id } = env.service.create("PK", ["QuickBuy 环境"], OPERATOR);
    env.pipeline.pass("PK-QuickBuy");
    await finished(env, id);
    expect(env.service.detail(id)!.state.tasks[0]!.status).toBe("done");
    expect(env.repo.summary(id)!.status).toBe("succeeded");
    expect(env.pipeline.calls.filter((call) => call.endsWith(":upload"))).toHaveLength(1);
    expect(env.service.status().shuttingDown).toBe(true);
  });

  test("failed finalize persistence still sends end and clears closing, listeners and finalizing", async () => {
    env = setupService();
    const warnings = captureWarnings();
    const write = env.repo.updateDeployment.bind(env.repo);
    const spy = spyOn(env.repo, "updateDeployment").mockImplementation((id, patch) => {
      if (patch.notifyStatus) throw new Error("finalize failed https://oauth2:private-token@repo.invalid/x");
      write(id, patch);
    });
    restore.push(() => spy.mockRestore());
    const { id } = env.service.create("PK", ["QuickBuy 环境"], OPERATOR);
    const messages: DeploymentMessage[] = [];
    env.service.subscribe(id, (message) => { messages.push(message); });
    env.pipeline.pass("PK-QuickBuy");
    await finished(env, id);
    expect(messages.at(-1)!.type).toBe("end");
    expect(env.repo.summary(id)!.status).toBe("succeeded");
    expect(env.repo.envs(id)[0]!.status).toBe("done");
    expect(env.service.status().shuttingDown).toBe(true);
    expect(warnings.join("\n")).toContain("finalize failed");
    expect(warnings.join("\n")).not.toContain("private-token");
  });

  test("a transient close error is retried independently of result persistence", async () => {
    env = setupService();
    captureWarnings();
    const end = env.logs.end.bind(env.logs);
    let calls = 0;
    const spy = spyOn(env.logs, "end").mockImplementation((id, idx) => {
      if (++calls === 1) throw new Error("temporary close failure");
      end(id, idx);
    });
    restore.push(() => spy.mockRestore());
    const { id } = env.service.create("PK", ["QuickBuy 环境"], OPERATOR);
    env.pipeline.pass("PK-QuickBuy");
    await finished(env, id);
    expect(calls).toBe(2);
    expect(env.repo.summary(id)!.status).toBe("succeeded");
  });
});
