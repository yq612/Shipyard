import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import type { DeploymentDetail as Detail, DeploymentEnvView, ProgressTask, Stage } from "@shipyard/shared";
import {
  DEPLOYMENT_STATUS_NAMES,
  STAGES,
  STAGE_NAMES,
  formatDuration,
  isDeploymentActive,
  sanitizeText,
  shortSha,
  taskCounts,
  taskElapsed,
} from "@shipyard/shared";
import { api, errorMessage } from "../api.ts";
import { useCanExecute } from "../components/Layout.tsx";
import { LogViewer } from "../components/LogViewer.tsx";
import { DeploymentStatusTag, Loading, Notice, NotifyValue, PageHead, Steps, TaskIcon, type StepState } from "../components/ui.tsx";
import { useOperatorName } from "../lib/operator.ts";
import { useDeploymentStream } from "../lib/sse.ts";
import { formatDateTime, useNow, useSpinner } from "../lib/time.ts";

export function DeploymentDetail() {
  const rawId = useParams().id;
  const id = Number(rawId);
  const queryClient = useQueryClient();
  const { detail, clockSkew, conn, notFound } = useDeploymentStream(id, () => {
    void queryClient.invalidateQueries({ queryKey: ["deployments"] });
    void queryClient.invalidateQueries({ queryKey: ["config"] });
    void queryClient.invalidateQueries({ queryKey: ["status"] });
  });
  const [selected, setSelected] = useState<number | null>(null);

  const active = detail ? isDeploymentActive(detail.deployment.status) : false;
  const now = useNow(active) + clockSkew;

  // Default selection: the first failed env, else the first running one, else the first.
  useEffect(() => {
    if (!detail || selected !== null) return;
    const tasks = detail.state.tasks;
    const pick = [tasks.findIndex((t) => t.status === "error"), tasks.findIndex((t) => t.status === "running")].find((i) => i >= 0) ?? 0;
    setSelected(pick);
  }, [detail, selected]);

  useTabTitle(detail, active);

  if (!Number.isInteger(id) || id <= 0 || notFound) {
    return (
      <>
        <PageHead title="任务不存在" />
        <Notice tone="err">找不到任务 #{rawId}，可能已超过保留期被清理。</Notice>
        <p><Link className="link" to="/deployments">返回发布记录</Link></p>
      </>
    );
  }
  if (!detail) return <Loading text={`连接任务 #${id}`} />;

  const d = detail.deployment;
  const counts = taskCounts(detail.state);
  const startedAt = d.startedAt ?? d.createdAt;
  const elapsed = (d.finishedAt ?? now) - startedAt;
  const failedAny = counts.error + counts.interrupted > 0;
  const steps: StepState[] = ["done", "done", "done", active ? "current" : "done", active ? "todo" : failedAny ? "error" : "current"];
  const sel = selected !== null ? detail.envs[selected] : undefined;
  const selTask = selected !== null ? detail.state.tasks[selected] : undefined;

  return (
    <>
      <PageHead
        title={<>任务 {d.id} · {d.countryName}</>}
        meta={
          <>
            {d.envCount} 个环境 · 发起人 {d.operatorName ?? "未填写"}（{d.operatorIp}）· {formatDateTime(d.createdAt)} ·{" "}
            {d.startedAt ? `${active ? "已用时" : "总耗时"} ${formatDuration(Math.max(0, elapsed))}` : active ? "等待空闲名额" : "未开始执行"}
            {d.retryOf && (
              <>
                {" "}· 重试自 <Link className="link" to={`/deployments/${d.retryOf}`}>#{d.retryOf}</Link>
              </>
            )}
          </>
        }
        actions={<DeploymentStatusTag status={d.status} />}
      />
      <Steps states={steps} />

      {conn === "reconnecting" && <Notice tone="warn">连接中断，正在重连…重连后会自动恢复到最新状态。</Notice>}

      {active ? <RunningActions detail={detail} /> : <ResultPanel detail={detail} onViewLog={setSelected} />}

      <TaskPanel detail={detail} now={now} selected={selected} onSelect={setSelected} active={active} />

      {sel && selTask && (
        <LogViewer
          key={`${id}-${sel.idx}`}
          deploymentId={id}
          envIdx={sel.idx}
          envName={sel.envName}
          failedStage={selTask.status === "error" ? (selTask.currentStage ?? null) : null}
        />
      )}
    </>
  );
}

function useTabTitle(detail: Detail | null, active: boolean) {
  const frame = useSpinner(active);
  useEffect(() => {
    if (!detail) return;
    const c = taskCounts(detail.state);
    const settled = c.total - c.queued - c.running;
    const prefix = active ? `${frame} ${settled}/${c.total}` : detail.deployment.status === "succeeded" ? "✔" : "✗";
    document.title = `${prefix} #${detail.deployment.id} · Shipyard`;
  }, [detail, active, frame]);
  useEffect(() => () => void (document.title = "Shipyard"), []);
}

// ------------------------------------------------------------ ④ 执行中

function RunningActions({ detail }: { detail: Detail }) {
  const { allowed } = useCanExecute();
  const cancel = useMutation({ mutationFn: () => api.cancel(detail.deployment.id) });
  const c = taskCounts(detail.state);
  return (
    <div className="row" style={{ marginBottom: "var(--s-2)" }}>
      <span className="dim grow" style={{ fontSize: "var(--t-14)" }}>
        执行中 {c.running} · 排队 {c.queued} · 已完成 {c.done} · 失败 {c.error}
        {c.cancelled > 0 && ` · 已取消 ${c.cancelled}`}
      </span>
      {cancel.isError && <span className="err" style={{ fontSize: "var(--t-14)" }}>{errorMessage(cancel.error)}</span>}
      <button
        type="button"
        className="btn btn--danger btn--sm"
        disabled={!allowed || cancel.isPending}
        title={allowed ? "取消所有还没结束的环境。已开始远端替换的环境会执行完。" : "当前 IP 不在白名单"}
        onClick={() => {
          if (confirm(`取消任务 #${detail.deployment.id} 中所有还没结束的环境？`)) cancel.mutate();
        }}
      >
        {cancel.isPending ? "取消中…" : "取消任务"}
      </button>
    </div>
  );
}

// How far the env got, 0–1, for the row's background fill: the running stage
// counts as half, a failed or cancelled stage as reached.
function taskProgress(task: ProgressTask): number {
  if (task.status === "done") return 1;
  let reached = 0;
  for (const stage of STAGES) {
    const st = task.stages[stage];
    if (st === "running") reached += 0.5;
    else if (st === "done" || st === "error" || st === "cancelled") reached += 1;
  }
  return reached / STAGES.length;
}

function StageChips({ task }: { task: ProgressTask }) {
  if (task.status === "queued") return <span className="task__note">排队中（等待空闲名额）</span>;
  return (
    <span className="task__stages">
      {STAGES.map((stage) => {
        const st = task.stages[stage];
        if (st === "pending" || st === "skipped") return null;
        const ms = task.stageDurations[stage];
        const label = STAGE_NAMES[stage].slice(0, 2);
        return (
          <span key={stage} className={`task__stage is-${st}`}>
            {label}
            {st === "running" ? " …" : ms !== undefined ? ` ${formatDuration(ms)}` : ""}
            {st === "cancelled" ? " 已取消" : ""}
          </span>
        );
      })}
      {task.status === "error" && task.error && (
        <span className="task__stage is-error ellipsis" title={task.error} style={{ maxWidth: "100%" }}>
          {sanitizeText(task.error).slice(0, 120)}
        </span>
      )}
      {task.status === "interrupted" && <span className="task__stage warn">{task.error}</span>}
      {task.status === "running" && task.currentStage === undefined && <span className="task__stage">准备中</span>}
    </span>
  );
}

function TaskPanel({
  detail,
  now,
  selected,
  onSelect,
  active,
}: {
  detail: Detail;
  now: number;
  selected: number | null;
  onSelect: (i: number) => void;
  active: boolean;
}) {
  const { allowed } = useCanExecute();
  const cancelEnv = useMutation({ mutationFn: (idx: number) => api.cancel(detail.deployment.id, idx) });
  return (
    <section className="panel" style={{ marginTop: "var(--s-3)" }}>
      <div className="panel__bar">
        <span>环境 · 点击查看日志</span>
        {cancelEnv.isError && <span className="err">{errorMessage(cancelEnv.error)}</span>}
      </div>
      <div className="tasks" role="listbox" aria-label="环境">
        {detail.envs.map((env, i) => {
          const task = detail.state.tasks[i]!;
          const live = task.status === "queued" || task.status === "running";
          const elapsed = task.startedAt ? formatDuration(taskElapsed(task, now)) : "";
          return (
            <div
              key={env.idx}
              role="option"
              aria-selected={selected === i}
              tabIndex={0}
              className={`task${selected === i ? " is-selected" : ""}`}
              onClick={() => onSelect(i)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(i);
                }
              }}
            >
              <span className={`task__fill is-${task.status}`} style={{ width: `${taskProgress(task) * 100}%` }} aria-hidden="true" />
              <TaskIcon status={task.status} />
              <span className="task__name" title={`${env.branch} → ${env.host}:${env.remotePath}`}>{env.envName}</span>
              <StageChips task={task} />
              <span className="task__time">{elapsed}</span>
              <span className="task__act">
                {active && live ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={!allowed || cancelEnv.isPending}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`取消「${env.envName}」？`)) cancelEnv.mutate(env.idx);
                    }}
                  >
                    取消
                  </button>
                ) : task.commit ? (
                  <span className="pixel muted" title={task.commit.message}>{shortSha(task.commit.sha)}</span>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ------------------------------------------------------------ ⑤ 完成

function ResultPanel({ detail, onViewLog }: { detail: Detail; onViewLog: (i: number) => void }) {
  const d = detail.deployment;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { allowed } = useCanExecute();
  const [operator] = useOperatorName();
  const retry = useMutation({
    mutationFn: () => api.retry(d.id, operator.trim() || undefined),
    onSuccess: ({ id }) => {
      void queryClient.invalidateQueries({ queryKey: ["deployments"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
      navigate(`/deployments/${id}`);
    },
  });
  const again = useMutation({
    mutationFn: () => api.create({ countryCode: d.countryCode, envNames: d.envNames, operatorName: operator.trim() || undefined }),
    onSuccess: ({ id }) => {
      void queryClient.invalidateQueries({ queryKey: ["deployments"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
      navigate(`/deployments/${id}`);
    },
  });

  const tone = d.status === "succeeded" ? "ok" : d.status === "partial" || d.status === "cancelled" ? "warn" : "err";
  const retryable = detail.envs.filter((e) => e.status === "error" || e.status === "cancelled" || e.status === "interrupted").length;
  const total = d.startedAt && d.finishedAt ? formatDuration(d.finishedAt - d.startedAt) : "—";
  const mutErr = retry.error ?? again.error;
  const plannerUrl = `/?country=${encodeURIComponent(d.countryCode)}&envs=${encodeURIComponent(d.envNames.join("\u0001"))}&step=2`;

  return (
    <section style={{ marginBottom: "var(--s-2)" }}>
      <div className={`result result--${tone} is-${d.status}`}>
        <span className="result__badge" aria-hidden="true" />
        <p className="result__big">{DEPLOYMENT_STATUS_NAMES[d.status]}</p>
        <dl className="result__stats">
          <div className="result__stat">
            <dt>成功</dt>
            <dd><b>{d.doneCount}</b><span className="result__of">/{d.envCount}</span></dd>
          </div>
          <div className="result__stat">
            <dt>总耗时</dt>
            <dd><b>{total}</b></dd>
          </div>
          <div className="result__stat">
            <dt>飞书通知</dt>
            <dd><NotifyValue status={d.notifyStatus} error={d.notifyError} /></dd>
          </div>
        </dl>
      </div>

      <div className="table-wrap" style={{ marginTop: "var(--s-2)" }}>
        <table className="table">
          <thead>
            <tr>
              <th>环境</th>
              <th>结果</th>
              <th>提交</th>
              <th className="num">耗时</th>
              <th>说明</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {detail.envs.map((e, i) => (
              <ResultRow key={e.idx} env={e} task={detail.state.tasks[i]!} onViewLog={() => onViewLog(i)} />
            ))}
          </tbody>
        </table>
      </div>

      {mutErr && <div style={{ marginTop: "var(--s-2)" }}><Notice tone="err">{errorMessage(mutErr)}</Notice></div>}
      {!allowed && <div style={{ marginTop: "var(--s-2)" }}><Notice tone="warn">当前 IP 不在白名单，不能重试或再次发布。</Notice></div>}

      <div className="footer-actions">
        <span className="footer-actions__hint">重试和再发一次都会重新克隆，用的是最新配置和分支上的最新代码。</span>
        {retryable > 0 && (
          <button type="button" className="btn btn--primary" disabled={!allowed || retry.isPending} onClick={() => retry.mutate()}>
            {retry.isPending ? "发起中…" : `重试失败的环境（${retryable}）`}
          </button>
        )}
        <button
          type="button"
          className={`btn${retryable > 0 ? "" : " btn--primary"}`}
          disabled={!allowed || again.isPending}
          onClick={() => again.mutate()}
        >
          {again.isPending ? "发起中…" : "同样的环境再发一次"}
        </button>
        <Link className="btn btn--ghost" to={plannerUrl}>调整后再发</Link>
        <Link className="btn btn--ghost" to="/">新建发布</Link>
      </div>
    </section>
  );
}

function ResultRow({ env, task, onViewLog }: { env: DeploymentEnvView; task: ProgressTask; onViewLog: () => void }) {
  const failedStage: Stage | null = env.failedStage ?? null;
  let note: ReactNode;
  switch (env.status) {
    case "done":
      note = <span>已发布到 <span className="mono">{env.server}</span></span>;
      break;
    case "error":
      note = (
        <span className="err" title={env.errorSummary ?? ""}>
          失败于「{failedStage ? STAGE_NAMES[failedStage] : "?"}」：{sanitizeText(env.errorSummary ?? task.error ?? "").slice(0, 80)}
        </span>
      );
      break;
    case "cancelled":
      note = <span className="muted">已取消{failedStage ? `（在「${STAGE_NAMES[failedStage]}」阶段）` : "（未开始）"}</span>;
      break;
    case "interrupted":
      note = <span className="warn">{env.errorSummary ?? "已中断"}</span>;
      break;
    default:
      note = null;
  }
  return (
    <tr>
      <td className="nowrap">{env.envName}</td>
      <td><TaskIcon status={env.status} /></td>
      <td className="mono dim" title={env.commitMessage ?? ""}>{shortSha(env.commitSha) || "—"}</td>
      <td className="num dim">{env.totalMs ? formatDuration(env.totalMs) : "—"}</td>
      <td style={{ maxWidth: 520 }} className="ellipsis">{note}</td>
      <td className="nowrap"><button type="button" className="btn btn--ghost btn--sm" onClick={onViewLog}>查看日志</button></td>
    </tr>
  );
}
