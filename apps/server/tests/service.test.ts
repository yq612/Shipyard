import { afterEach, describe, expect, test } from "bun:test";
import { replayProgress } from "@shipyard/shared";
import { ServiceError } from "../src/service/errors.ts";
import { Scheduler } from "../src/service/scheduler.ts";
import { CONFIG_YAML, OPERATOR, setupService, until, type TestEnv } from "./helpers.ts";

let env: TestEnv;
afterEach(() => env?.cleanup());

const WITH_WEBHOOK = CONFIG_YAML + `\nnotify:\n  feishu:\n    webhook: https://hook/x\n`;

function statuses(e: TestEnv, id: number) {
  return e.repo.envs(id).map((x) => x.status);
}

async function expectError(fn: () => unknown, code: string): Promise<ServiceError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe(code as any);
    return err as ServiceError;
  }
  throw new Error(`expected ${code}`);
}

describe("Scheduler", () => {
  test("never runs more than max jobs and keeps FIFO order", async () => {
    const s = new Scheduler(2);
    const started: string[] = [];
    const release: Record<string, () => void> = {};
    for (const id of ["a", "b", "c", "d"]) {
      s.enqueue({ id, run: () => new Promise<void>((r) => { started.push(id); release[id] = r; }) });
    }
    await Bun.sleep(1);
    expect(started).toEqual(["a", "b"]);
    expect(s.runningCount).toBe(2);
    expect(s.dequeue("c")).toBe(true);
    release.a!();
    await until(() => started.length === 3);
    expect(started).toEqual(["a", "b", "d"]);
    expect(s.dequeue("b")).toBe(false); // already running
  });
});

describe("DeploymentService", () => {
  test("happy path: events, env rows, commit, logs, deployment status, notification", async () => {
    env = setupService({ yaml: WITH_WEBHOOK });
    const { id } = env.service.create("PK", ["QuickBuy 环境"], OPERATOR);
    expect(env.repo.summary(id)).toMatchObject({ status: "queued", operatorName: "张三", envCount: 1 });

    env.pipeline.pass("PK-QuickBuy");
    await until(() => !env.service.isActive(id));
    await env.service.idle();

    const summary = env.repo.summary(id)!;
    expect(summary).toMatchObject({ status: "succeeded", doneCount: 1, notifyStatus: "sent" });
    expect(summary.startedAt).not.toBeNull();
    expect(summary.finishedAt).not.toBeNull();

    const [row] = env.repo.envs(id);
    expect(row).toMatchObject({ status: "done", commitSha: "a1b2c3d4e5f6", commitMessage: "fix: test", failedStage: null });
    // credentials are stripped before anything is persisted
    expect(row!.repoUrl).toBe("https://***@codeup.example.com/out.git");

    // the persisted event stream replays to the same final state
    const replayed = replayProgress(1, 0, env.repo.events(id).map((e) => e.event));
    expect(replayed.tasks[0]!.status).toBe("done");
    expect(replayed.tasks[0]!.stages).toEqual({ clone: "done", install: "done", build: "done", upload: "done" });

    const lines = env.logs.readAll(id, 0).map((l) => l.text);
    expect(lines).toContain("install output for PK-QuickBuy");
    expect(lines.at(-1)).toBe("✔ 发布成功");
    expect(env.logs.isOpen(id, 0)).toBe(false);

    expect(env.notified).toHaveLength(1);
    expect(env.notified[0]!.card.card.header.title.content).toContain(`#${id}`);
  });

  test("respects maxConcurrent: extra envs wait in the queue", async () => {
    env = setupService(); // maxConcurrent: 2
    const { id } = env.service.create("PK", ["QuickBuy 环境", "Kbunique 环境", "Saink 环境"], OPERATOR);
    await until(() => env.pipeline.calls.length === 2);
    expect(env.service.status()).toMatchObject({ runningEnvs: 2, queuedEnvs: 1 });
    expect(statuses(env, id)).toEqual(["running", "running", "queued"]);

    env.pipeline.pass("PK-QuickBuy");
    await until(() => env.pipeline.calls.includes("PK-saink:clone"));
    env.pipeline.pass("PK-kbunique");
    env.pipeline.pass("PK-saink");
    await until(() => !env.service.isActive(id));
    expect(env.repo.summary(id)!.status).toBe("succeeded");
  });

  test("environment lock: a busy directory is refused with 409 and who holds it", async () => {
    env = setupService();
    const first = env.service.create("PK", ["QuickBuy 环境"], OPERATOR);
    const err = await expectError(() => env.service.create("PK", ["QuickBuy 环境", "Kbunique 环境"], OPERATOR), "ENV_BUSY");
    expect(err.status).toBe(409);
    expect(err.details).toEqual([{ deploymentId: first.id, envIdx: 0, envName: "QuickBuy 环境", requestedEnv: "QuickBuy 环境" }]);

    // same host, different directory → allowed
    const other = env.service.create("PK", ["Saink 环境"], OPERATOR);
    expect(other.id).toBeGreaterThan(first.id);

    const view = env.service.configView();
    const pk = view.countries.find((c) => c.code === "PK")!;
    expect(pk.busyCount).toBe(2);
    expect(pk.environments.find((e) => e.name === "QuickBuy 环境")!.busy?.deploymentId).toBe(first.id);

    env.pipeline.pass("PK-QuickBuy");
    await until(() => !env.service.isActive(first.id));
    expect(env.service.holderOf("1.1.1.1", "/home/topup-web/quickbuypk/dist")).toBeNull();
    expect(env.service.create("PK", ["QuickBuy 环境"], OPERATOR).id).toBeGreaterThan(other.id);
  });

  test("a failing stage marks the env failed, records the summary, others continue", async () => {
    env = setupService();
    const { id } = env.service.create("PK", ["QuickBuy 环境", "Kbunique 环境"], OPERATOR);
    env.pipeline.open("PK-QuickBuy", "clone");
    env.pipeline.fail("PK-QuickBuy", "install", "npm ERR! https://oauth2:tok@codeup.example.com boom");
    env.pipeline.pass("PK-kbunique");
    await until(() => !env.service.isActive(id));
    await env.service.idle();

    expect(env.repo.summary(id)).toMatchObject({ status: "partial", doneCount: 1, failedCount: 1, notifyStatus: "skipped" });
    const failed = env.repo.envs(id)[0]!;
    expect(failed).toMatchObject({ status: "error", failedStage: "install" });
    expect(failed.errorSummary).toContain("https://***@codeup.example.com boom");
    const detail = env.service.detail(id)!;
    expect(detail.state.tasks[0]!.stages).toEqual({ clone: "done", install: "error", build: "skipped", upload: "skipped" });
  });

  test("cancel: queued envs are dropped at once, running envs are aborted", async () => {
    env = setupService();
    const { id } = env.service.create("PK", ["QuickBuy 环境", "Kbunique 环境", "Saink 环境"], OPERATOR);
    await until(() => env.pipeline.calls.length === 2);

    expect(env.service.cancel(id, 2)).toEqual({ cancelled: 1 }); // still queued
    expect(statuses(env, id)[2]).toBe("cancelled");
    await expectError(() => env.service.cancel(id, 2), "NOTHING_TO_CANCEL");

    expect(env.service.cancel(id, 0)).toEqual({ cancelled: 1 }); // running → aborted
    env.pipeline.pass("PK-kbunique");
    await until(() => !env.service.isActive(id));

    const envs = env.repo.envs(id);
    expect(envs.map((e) => e.status)).toEqual(["cancelled", "done", "cancelled"]);
    expect(envs[0]).toMatchObject({ failedStage: "clone", errorSummary: null });
    expect(env.repo.summary(id)!.status).toBe("partial");
    const state = env.service.detail(id)!.state;
    expect(state.tasks[0]!.stages.clone).toBe("cancelled");
    expect(env.logs.readAll(id, 0).at(-1)!.text).toBe("■ 已取消");
    await expectError(() => env.service.cancel(id), "NOTHING_TO_CANCEL");
  });

  test("cancelling everything frees the locks and ends as cancelled", async () => {
    env = setupService();
    const { id } = env.service.create("PK", ["QuickBuy 环境"], OPERATOR);
    await until(() => env.pipeline.calls.length === 1);
    env.service.cancel(id);
    await until(() => !env.service.isActive(id));
    expect(env.repo.summary(id)!.status).toBe("cancelled");
    expect(env.service.holderOf("1.1.1.1", "/home/topup-web/quickbuypk/dist")).toBeNull();
  });

  test("retry re-runs only failed / cancelled envs as a new deployment", async () => {
    env = setupService();
    const { id } = env.service.create("PK", ["QuickBuy 环境", "Kbunique 环境"], OPERATOR);
    env.pipeline.fail("PK-QuickBuy", "clone", "no such branch");
    env.pipeline.pass("PK-kbunique");
    await until(() => !env.service.isActive(id));

    const retry = env.service.retry(id, { ...OPERATOR, name: "李四" });
    const summary = env.repo.summary(retry.id)!;
    expect(summary).toMatchObject({ retryOf: id, envNames: ["QuickBuy 环境"], operatorName: "李四" });
    await expectError(() => env.service.retry(9999, OPERATOR), "NOT_FOUND");
  });

  test("create validates input and the config", async () => {
    env = setupService();
    await expectError(() => env.service.create("XX", ["a"], OPERATOR), "NOT_FOUND");
    await expectError(() => env.service.create("PK", [], OPERATOR), "BAD_REQUEST");
    await expectError(() => env.service.create("PK", ["Nope"], OPERATOR), "NOT_FOUND");

    env.writeConfig("ssh: [");
    const err = await expectError(() => env.service.create("PK", ["QuickBuy 环境"], OPERATOR), "CONFIG_INVALID");
    expect(err.status).toBe(422);
    expect(env.service.configView().configError).toContain("YAML");
  });

  test("hot reload: config edits apply to the next deployment", async () => {
    env = setupService();
    env.writeConfig(CONFIG_YAML.replace("PK-QuickBuy", "PK-QuickBuy-v2"));
    const { id } = env.service.create("PK", ["QuickBuy 环境"], OPERATOR);
    expect(env.repo.envs(id)[0]!.branch).toBe("PK-QuickBuy-v2");
  });

  test("plan lists concrete commands without leaking credentials", () => {
    env = setupService();
    const plan = env.service.plan("PK", ["QuickBuy 环境"]);
    expect(plan.maxConcurrent).toBe(2);
    const e = plan.envs[0]!;
    expect(e.repoUrl).toBe("https://***@codeup.example.com/out.git");
    expect(e.sshTarget).toBe("root@1.1.1.1:22");
    expect(e.steps.map((s) => s.stage)).toEqual(["clone", "install", "build", "upload"]);
    expect(JSON.stringify(plan)).not.toContain("secret");
    expect(e.steps[0]!.commands[0]).toContain("-b PK-QuickBuy");
  });

  test("recover marks leftovers from a crashed process as interrupted", async () => {
    env = setupService();
    const { id } = env.service.create("PK", ["QuickBuy 环境", "Kbunique 环境"], OPERATOR);
    await until(() => env.pipeline.calls.length === 2);

    // simulate a restart: a fresh service over the same database
    const { DeploymentService } = await import("../src/service/deployments.ts");
    const fresh = new DeploymentService({ repo: env.repo, logs: env.logs, config: env.config, pipeline: env.pipeline.deps() });
    expect(fresh.recover()).toEqual([id]);
    expect(statuses(env, id)).toEqual(["interrupted", "interrupted"]);
    expect(env.repo.summary(id)!.status).toBe("interrupted");
    const state = fresh.detail(id)!.state;
    expect(state.tasks[0]!.status).toBe("interrupted");
    expect(state.tasks[0]!.error).toContain("中断");
  });

  test("shutdown interrupts queued envs and waits for running ones", async () => {
    env = setupService();
    const { id } = env.service.create("PK", ["QuickBuy 环境", "Kbunique 环境", "Saink 环境"], OPERATOR);
    await until(() => env.pipeline.calls.length === 2);
    const done = env.service.shutdown(5000);
    await expectError(() => env.service.create("MX", ["ZenLix 环境"], OPERATOR), "SHUTTING_DOWN");
    expect(statuses(env, id)[2]).toBe("interrupted");
    env.pipeline.pass("PK-QuickBuy");
    env.pipeline.pass("PK-kbunique");
    await done;
    expect(statuses(env, id)).toEqual(["done", "done", "interrupted"]);
    expect(env.repo.summary(id)!.status).toBe("partial");
  });

  test("subscribers get progress, status and end messages", async () => {
    env = setupService();
    const { id } = env.service.create("PK", ["QuickBuy 环境"], OPERATOR);
    const types: string[] = [];
    env.service.subscribe(id, (msg) => types.push(msg.type));
    env.pipeline.pass("PK-QuickBuy");
    await until(() => types.includes("end"));
    expect(types.filter((t) => t === "progress").length).toBeGreaterThan(5);
    expect(types).toContain("deployment");
    expect(types.at(-1)).toBe("end");
  });

  test("list filters by country, env and status", async () => {
    env = setupService();
    const a = env.service.create("PK", ["QuickBuy 环境"], OPERATOR);
    env.service.create("MX", ["ZenLix 环境"], OPERATOR);
    env.pipeline.pass("PK-QuickBuy");
    await until(() => !env.service.isActive(a.id));

    expect(env.service.list({}).total).toBe(2);
    expect(env.service.list({ country: "MX" }).items.map((d) => d.countryCode)).toEqual(["MX"]);
    expect(env.service.list({ env: "QuickBuy 环境" }).items.map((d) => d.id)).toEqual([a.id]);
    expect(env.service.list({ status: "succeeded" }).items.map((d) => d.id)).toEqual([a.id]);
    expect(env.service.list({ pageSize: 1, page: 2 }).items).toHaveLength(1);

    const last = env.service.configView().countries[0]!.environments[0]!.last;
    expect(last).toMatchObject({ deploymentId: a.id, status: "done", commitSha: "a1b2c3d4e5f6" });
  });
});
