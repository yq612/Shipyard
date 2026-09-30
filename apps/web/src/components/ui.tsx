import type { ReactNode } from "react";
import type { DeploymentStatus, NotifyStatus, TaskStatus } from "@shipyard/shared";
import { DEPLOYMENT_STATUS_NAMES, TASK_STATUS_NAMES } from "@shipyard/shared";
import { useSpinner } from "../lib/time.ts";

export function PageHead({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="head">
      <div className="grow">
        <h1 className="head__title ty-display">
          <span className="head__mark" aria-hidden="true">#</span> {title}
        </h1>
        {meta && <p className="head__meta">{meta}</p>}
      </div>
      {actions && <div className="head__actions">{actions}</div>}
    </header>
  );
}

// Pixel check / cross (assets/*.svg as a mask, so they take the text colour);
// the ✔ ✗ glyphs render too small in the pixel font.
export function CheckIcon() {
  return <span className="ico-check" aria-hidden="true" />;
}

export function CrossIcon() {
  return <span className="ico-cross" aria-hidden="true" />;
}

export type StepState = "todo" | "current" | "done" | "error";

export const WIZARD_STEPS = ["选择国家", "选择环境", "确认执行计划", "执行中", "完成"] as const;

const STEP_STATE_NAMES: Partial<Record<StepState, string>> = { done: "已完成", error: "失败" };

// ① 选择国家 / 项目 → ② 选择环境 → ③ 确认执行计划 → ④ 执行中 → ⑤ 完成, as pixel
// chevrons. `notes` adds an optional second line per step: what was picked for
// a done step, live progress for the current one.
// Ungrouped projects have no country step: `first` renames it, and it is not
// a step one can go back to (the project is picked in the sidebar).
export function Steps({
  states,
  onStep,
  first,
  notes,
}: {
  states: StepState[];
  onStep?: (index: number) => void;
  first?: string;
  notes?: ReactNode[];
}) {
  return (
    <div className="chevs-wrap">
      <ol className="chevs" aria-label="发布步骤">
        {WIZARD_STEPS.map((step, i) => {
          const name = i === 0 && first ? first : step;
          const state = states[i] ?? "todo";
          const note = notes?.[i];
          const stateName = STEP_STATE_NAMES[state];
          const body = (
            <>
              <span className={`chev__icon chev__icon--${i + 1}`} aria-hidden="true" />
              <span className="chev__txt">
                <span className="chev__name">
                  {name}
                  {stateName && <span className="visually-hidden">（{stateName}）</span>}
                </span>
                {note ? <span className="chev__note">{note}</span> : null}
              </span>
            </>
          );
          const clickable = onStep && state === "done" && !(i === 0 && first);
          return (
            <li key={step} className={`chev is-${state}`} aria-current={state === "current" ? "step" : undefined}>
              {clickable ? (
                <button type="button" className="chev__hit" onClick={() => onStep(i)} title={`回到「${name}」`}>{body}</button>
              ) : (
                <div className="chev__hit">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const TASK_TONE: Record<TaskStatus, string> = {
  queued: "",
  running: "status--ok",
  done: "status--ok",
  error: "status--err",
  cancelled: "",
  interrupted: "status--warn",
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`status ${TASK_TONE[status]}`}>{TASK_STATUS_NAMES[status]}</span>;
}

const DEPLOY_TONE: Record<DeploymentStatus, string> = {
  queued: "tag tag--solid",
  running: "tag tag--accent",
  succeeded: "tag tag--solid tag--accent",
  partial: "tag tag--solid tag--warn",
  failed: "tag tag--solid tag--err",
  cancelled: "tag tag--solid",
  interrupted: "tag tag--solid tag--warn",
};

export function DeploymentStatusTag({ status, small }: { status: DeploymentStatus; small?: boolean }) {
  return <span className={`${DEPLOY_TONE[status]}${small ? " tag--sm" : ""}`}>{DEPLOYMENT_STATUS_NAMES[status]}</span>;
}

export function TaskIcon({ status }: { status: TaskStatus }) {
  const frame = useSpinner(status === "running");
  switch (status) {
    case "running":
      return <span className="task__icon spin" aria-label="执行中">{frame}</span>;
    case "done":
      return <span className="task__icon ok" aria-label="成功"><CheckIcon /></span>;
    case "error":
      return <span className="task__icon err" aria-label="失败"><CrossIcon /></span>;
    case "cancelled":
      return <span className="task__icon muted" aria-label="已取消">■</span>;
    case "interrupted":
      return <span className="task__icon warn" aria-label="已中断">!</span>;
    default:
      return <span className="task__icon muted" aria-label="排队中">◷</span>;
  }
}

// Value only — the caller supplies the "飞书通知" label.
export function NotifyValue({ status, error }: { status: NotifyStatus | null; error: string | null }) {
  if (!status) return <span className="muted">等待任务结束</span>;
  if (status === "sent") return <span className="ok">已发送</span>;
  if (status === "failed") return <span className="err" title={error ?? undefined}>发送失败</span>;
  return <span className="muted">{error ?? "未配置"}</span>;
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "err" | "ok"; children: ReactNode }) {
  const icon = tone === "err" ? <CrossIcon /> : tone === "warn" ? "!" : tone === "ok" ? <CheckIcon /> : ">";
  return (
    <div className={`notice notice--${tone}`} role={tone === "err" ? "alert" : "status"}>
      <span className="notice__icon" aria-hidden="true">{icon}</span>
      <div className="grow">{children}</div>
    </div>
  );
}

export function Loading({ text = "读取中" }: { text?: string }) {
  return (
    <p className="loading">
      {text}<span className="cursor" aria-hidden="true" />
    </p>
  );
}
