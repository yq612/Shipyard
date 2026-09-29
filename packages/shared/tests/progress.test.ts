import { test, expect } from "bun:test";
import {
  completedStageCount,
  deploymentStatusOf,
  deriveDeploymentStatus,
  initialProgressState,
  reduceProgress,
  replayProgress,
  sanitizeText,
  stageTotals,
  taskCounts,
  taskElapsed,
} from "../src/progress.ts";
import type { ProgressEvent } from "../src/types.ts";

test("new tasks start queued with every stage pending", () => {
  const state = initialProgressState(2, 0);
  expect(state.tasks[0]!.status).toBe("queued");
  expect(state.tasks[1]!.stages).toEqual({ clone: "pending", install: "pending", build: "pending", upload: "pending" });
});

test("progress reducer counts only completed stages", () => {
  let state = initialProgressState(1, 0);
  state = reduceProgress(state, { type: "pipelineStart", index: 0, at: 1 });
  state = reduceProgress(state, { type: "stageStart", index: 0, stage: "clone", at: 2 });
  expect(completedStageCount(state.tasks[0]!)).toBe(0);
  expect(stageTotals(state, "clone").running).toBe(1);

  state = reduceProgress(state, { type: "stageDone", index: 0, stage: "clone", ms: 20, at: 22 });
  state = reduceProgress(state, { type: "stageStart", index: 0, stage: "install", at: 23 });
  expect(completedStageCount(state.tasks[0]!)).toBe(1);
  expect(stageTotals(state, "clone").done).toBe(1);
  expect(stageTotals(state, "install").running).toBe(1);
});

test("stage error fails the task and skips later stages", () => {
  let state = initialProgressState(1, 0);
  state = reduceProgress(state, { type: "stageStart", index: 0, stage: "build", at: 5 });
  state = reduceProgress(state, { type: "stageError", index: 0, stage: "build", ms: 3, error: "\x1b[31mboom\x1b[0m", at: 8 });
  const task = state.tasks[0]!;
  expect(task.status).toBe("error");
  expect(task.error).toBe("boom");
  expect(task.stages.build).toBe("error");
  expect(task.stages.upload).toBe("skipped");
  expect(task.endedAt).toBe(8);
});

test("pipeline outcome corrects errors and marks later stages skipped", () => {
  let state = initialProgressState(1, 0);
  state = reduceProgress(state, {
    type: "pipelineDone",
    index: 0,
    at: 100,
    outcome: {
      ok: false,
      stages: [
        { stage: "clone", durationMs: 10 },
        { stage: "install", durationMs: 20 },
      ],
      failedStage: "build",
      error: "boom",
      totalMs: 100,
    },
  });
  expect(state.tasks[0]!.status).toBe("error");
  expect(state.tasks[0]!.stages).toEqual({ clone: "done", install: "done", build: "error", upload: "skipped" });
  expect(completedStageCount(state.tasks[0]!)).toBe(2);
});

test("pipeline outcome handles failures before the first stage hook", () => {
  let state = initialProgressState(1, 0);
  state = reduceProgress(state, {
    type: "pipelineDone",
    index: 0,
    at: 5,
    outcome: { ok: false, stages: [], failedStage: "clone", error: "tmp failed", totalMs: 5 },
  });
  expect(state.tasks[0]!.status).toBe("error");
  expect(state.tasks[0]!.stages).toEqual({ clone: "error", install: "skipped", build: "skipped", upload: "skipped" });
});

test("a cancelled pipeline marks the running stage cancelled, not failed", () => {
  const events: ProgressEvent[] = [
    { type: "pipelineStart", index: 0, at: 1 },
    { type: "stageStart", index: 0, stage: "clone", at: 1 },
    { type: "stageDone", index: 0, stage: "clone", ms: 4, at: 5 },
    { type: "stageStart", index: 0, stage: "install", at: 5 },
    {
      type: "pipelineDone",
      index: 0,
      at: 9,
      outcome: { ok: false, cancelled: true, stages: [{ stage: "clone", durationMs: 4 }], failedStage: "install", error: "已取消", totalMs: 8 },
    },
  ];
  const task = replayProgress(1, 0, events).tasks[0]!;
  expect(task.status).toBe("cancelled");
  expect(task.error).toBeUndefined();
  expect(task.stages).toEqual({ clone: "done", install: "cancelled", build: "skipped", upload: "skipped" });
});

test("queued envs can be cancelled; settled envs ignore cancel/interrupt", () => {
  let state = initialProgressState(2, 0);
  state = reduceProgress(state, { type: "envCancelled", index: 0, at: 3 });
  expect(state.tasks[0]!.status).toBe("cancelled");
  expect(state.tasks[0]!.stages.clone).toBe("skipped");

  state = reduceProgress(state, { type: "pipelineDone", index: 1, at: 9, outcome: { ok: true, stages: [], totalMs: 1 } });
  const before = state;
  state = reduceProgress(state, { type: "envInterrupted", index: 1, at: 10 });
  expect(state).toBe(before);
});

test("interrupted envs carry an explanation", () => {
  let state = initialProgressState(1, 0);
  state = reduceProgress(state, { type: "stageStart", index: 0, stage: "build", at: 1 });
  state = reduceProgress(state, { type: "envInterrupted", index: 0, at: 2 });
  expect(state.tasks[0]!.status).toBe("interrupted");
  expect(state.tasks[0]!.stages.build).toBe("error");
  expect(state.tasks[0]!.error).toContain("中断");
});

test("commit events attach commit info", () => {
  let state = initialProgressState(1, 0);
  state = reduceProgress(state, { type: "commit", index: 0, sha: "abc1234def", message: "fix: 文案", at: 1 });
  expect(state.tasks[0]!.commit).toEqual({ sha: "abc1234def", message: "fix: 文案" });
});

test("events for unknown tasks are ignored", () => {
  const state = initialProgressState(1, 0);
  expect(reduceProgress(state, { type: "pipelineStart", index: 5, at: 1 })).toBe(state);
});

test("deployment status is derived from task statuses", () => {
  expect(deploymentStatusOf(["queued", "queued"])).toBe("queued");
  expect(deploymentStatusOf(["running", "queued"])).toBe("running");
  expect(deploymentStatusOf(["done", "queued"])).toBe("running");
  expect(deploymentStatusOf(["done", "done"])).toBe("succeeded");
  expect(deploymentStatusOf(["done", "error"])).toBe("partial");
  expect(deploymentStatusOf(["error", "cancelled"])).toBe("failed");
  expect(deploymentStatusOf(["interrupted", "error"])).toBe("interrupted");
  expect(deploymentStatusOf(["cancelled", "cancelled"])).toBe("cancelled");
  expect(deriveDeploymentStatus(initialProgressState(3, 0))).toBe("queued");
});

test("taskCounts and taskElapsed", () => {
  let state = initialProgressState(2, 0);
  state = reduceProgress(state, { type: "pipelineStart", index: 0, at: 100 });
  expect(taskCounts(state)).toMatchObject({ queued: 1, running: 1, total: 2 });
  expect(taskElapsed(state.tasks[0]!, 250)).toBe(150);
  expect(taskElapsed(state.tasks[1]!, 250)).toBe(0);
});

test("sanitizeText strips terminal controls and keeps errors on one line", () => {
  expect(sanitizeText("\x1b[31m失败\x1b[0m\nnext\trow")).toBe("失败 next row");
});
