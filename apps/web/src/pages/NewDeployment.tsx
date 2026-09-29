import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router";
import type { ConfigView, CountryView, EnvBusyDetail, EnvView, PlanResponse } from "@shipyard/shared";
import { STAGE_NAMES, TASK_STATUS_NAMES, shortSha } from "@shipyard/shared";
import { ApiError, api, errorMessage } from "../api.ts";
import { CountryCard } from "../components/CountryCard.tsx";
import { useCanExecute } from "../components/Layout.tsx";
import { CheckIcon, Loading, Notice, PageHead, Steps, type StepState } from "../components/ui.tsx";
import { useOperatorName } from "../lib/operator.ts";
import { formatDateTime } from "../lib/time.ts";

type Step = 0 | 1 | 2;

// Wizard state lives in the URL (?country=PK&envs=A,B&step=2) so refresh and
// the browser back button behave.
const SEP = "\u0001"; // env names may contain commas and spaces

function readParams(params: URLSearchParams) {
  const rawStep = Number(params.get("step") ?? 0);
  return {
    country: params.get("country") ?? "",
    envs: (params.get("envs") ?? "").split(SEP).filter(Boolean),
    step: (rawStep === 1 || rawStep === 2 ? rawStep : 0) as Step,
  };
}

function useWizardParams() {
  const [params, setParams] = useSearchParams();
  const { country, step } = readParams(params);
  const envsKey = params.get("envs") ?? "";
  const envs = useMemo(() => envsKey.split(SEP).filter(Boolean), [envsKey]);
  // react-router's functional setSearchParams still sees the params of the
  // current render, so quick successive clicks would overwrite each other.
  // Track the latest params we asked for ourselves.
  const latest = useRef(params);
  latest.current = params;
  const update = (
    next: { country?: string; envs?: string[] | ((prev: string[]) => string[]); step?: Step },
    replace = false,
  ) => {
    const prev = readParams(latest.current);
    const p = new URLSearchParams();
    const c = next.country ?? prev.country;
    const e = typeof next.envs === "function" ? next.envs(prev.envs) : (next.envs ?? prev.envs);
    const s = next.step ?? prev.step;
    if (c) p.set("country", c);
    if (e.length) p.set("envs", e.join(SEP));
    if (s) p.set("step", String(s));
    latest.current = p;
    setParams(p, { replace });
  };
  return { country, envs, step, update };
}

export function NewDeployment() {
  const config = useQuery({ queryKey: ["config"], queryFn: api.config, refetchInterval: 5000 });
  const { country, envs, step, update } = useWizardParams();
  const current = config.data?.countries.find((c) => c.code === country);

  // Guard against stale URLs (country removed from config, etc.).
  const effectiveStep: Step = !current ? 0 : step === 2 && envs.length === 0 ? 1 : step;

  const states: StepState[] = [0, 1, 2, 3, 4].map((i) => (i < effectiveStep ? "done" : i === effectiveStep ? "current" : "todo"));

  return (
    <>
      <PageHead
        title="新建发布"
        meta={
          effectiveStep === 0
            ? "选一个国家开始。每次发布只针对一个国家下的若干环境。"
            : effectiveStep === 1
              ? `${current?.name} · 选择要发布的环境`
              : `${current?.name} · 确认每个环境接下来要执行的步骤`
        }
      />
      <Steps states={states} onStep={(i) => update({ step: i as Step })} />

      {config.data?.configError && (
        <Notice tone="err">
          配置文件校验失败，已暂停发起新发布（正在执行的任务不受影响）：{config.data.configError}
        </Notice>
      )}

      {config.isLoading ? (
        <Loading text="读取配置" />
      ) : config.isError ? (
        <Notice tone="err">读取配置失败：{errorMessage(config.error)}</Notice>
      ) : effectiveStep === 0 ? (
        <CountryStep config={config.data!} selected={country} onPick={(code) => update({ country: code, envs: code === country ? envs : [], step: 1 })} />
      ) : effectiveStep === 1 ? (
        <EnvStep
          country={current!}
          selected={envs}
          onChange={(fn) => update({ envs: fn }, true)}
          onBack={() => update({ step: 0 })}
          onNext={() => update({ step: 2 })}
        />
      ) : (
        <PlanStep country={current!} envNames={envs} onBack={() => update({ step: 1 })} />
      )}
    </>
  );
}

// ------------------------------------------------------------ ① 选择国家

function CountryStep({ config, selected, onPick }: { config: ConfigView; selected: string; onPick: (code: string) => void }) {
  if (config.countries.length === 0) return <div className="empty">配置里还没有国家，先在 config.yaml 里添加</div>;
  return (
    <div className="countries" role="list">
      {config.countries.map((c) => (
        <CountryCard key={c.code} country={c} current={c.code === selected} onPick={onPick} />
      ))}
    </div>
  );
}

// ------------------------------------------------------------ ② 选择环境

function LastDeploy({ env }: { env: EnvView }) {
  const last = env.last;
  if (!last) return <span className="muted">—</span>;
  const when = formatDateTime(last.finishedAt ?? last.startedAt);
  const href = `/deployments/${last.deploymentId}`;
  if (last.status === "done") {
    return <a className="link" href={href} onClick={(e) => e.stopPropagation()}>{when} <span className="ok"><CheckIcon /></span> {shortSha(last.commitSha)}</a>;
  }
  if (last.status === "error" || last.status === "interrupted") {
    return (
      <a className="link" href={href} onClick={(e) => e.stopPropagation()}>
        {when} <span className="err">✗</span> {last.failedStage ? STAGE_NAMES[last.failedStage] : TASK_STATUS_NAMES[last.status]}
      </a>
    );
  }
  return <a className="link" href={href} onClick={(e) => e.stopPropagation()}>{when} {TASK_STATUS_NAMES[last.status]}</a>;
}

function EnvStep({
  country,
  selected,
  onChange,
  onBack,
  onNext,
}: {
  country: CountryView;
  selected: string[];
  onChange: (update: (prev: string[]) => string[]) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const rows = country.environments.filter(
    (e) => !q || [e.name, e.branch, e.server, e.host, e.repo].some((v) => v.toLowerCase().includes(q)),
  );
  // Busy envs can't be picked; drop them if they became busy after selection.
  const selectable = rows.filter((e) => !e.busy);
  const chosen = new Set(selected.filter((n) => country.environments.some((e) => e.name === n && !e.busy)));
  const allOn = selectable.length > 0 && selectable.every((e) => chosen.has(e.name));
  const someOn = selectable.some((e) => chosen.has(e.name));

  // Keep config order, and never keep a name that is gone or busy.
  const ordered = (names: Set<string>) => country.environments.filter((e) => names.has(e.name) && !e.busy).map((e) => e.name);
  const toggle = (name: string) =>
    onChange((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return ordered(next);
    });
  const toggleAll = () =>
    onChange((prev) => {
      const next = new Set(prev);
      for (const e of selectable) {
        if (allOn) next.delete(e.name);
        else next.add(e.name);
      }
      return ordered(next);
    });

  return (
    <>
      <div className="toolbar">
        <label className="field field--inline field--sm">
          <span className="visually-hidden">搜索环境</span>
          <span className="field__box">
            <span className="field__prompt" aria-hidden="true">/</span>
            <input className="field__input" type="search" placeholder="搜索环境、分支、server、主机" value={search} onChange={(e) => setSearch(e.target.value)} />
          </span>
        </label>
        <span className="toolbar__count">
          已选 <b>{chosen.size}</b> / {country.environments.length}
        </span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="col-check">
                <input
                  className="check"
                  type="checkbox"
                  aria-label="全选"
                  checked={allOn}
                  ref={(el) => {
                    if (el) el.indeterminate = !allOn && someOn;
                  }}
                  onChange={toggleAll}
                  disabled={selectable.length === 0}
                />
              </th>
              <th>环境</th>
              <th>分支</th>
              <th>server</th>
              <th>主机</th>
              <th>仓库</th>
              <th>上次发布</th>
              <th>当前状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">没有匹配「{search}」的环境</td>
              </tr>
            )}
            {rows.map((e) => {
              const on = chosen.has(e.name);
              return (
                <tr
                  key={e.name}
                  className={e.busy ? "is-disabled" : `is-clickable${on ? " is-selected" : ""}`}
                  onClick={() => !e.busy && toggle(e.name)}
                >
                  <td className="col-check">
                    <input
                      className="check"
                      type="checkbox"
                      aria-label={`选择 ${e.name}`}
                      checked={on}
                      disabled={!!e.busy}
                      onClick={(ev) => ev.stopPropagation()}
                      onChange={() => toggle(e.name)}
                    />
                  </td>
                  <td className="nowrap">{e.name}</td>
                  <td className="mono dim">{e.branch}</td>
                  <td className="mono dim">{e.server}</td>
                  <td className="mono dim">{e.host}</td>
                  <td><span className="tag tag--sm">{e.repo}</span></td>
                  <td className="nowrap"><LastDeploy env={e} /></td>
                  <td className="nowrap">
                    {e.busy ? (
                      <a className="link warn" href={`/deployments/${e.busy.deploymentId}`} onClick={(ev) => ev.stopPropagation()}>
                        占用：#{e.busy.deploymentId}
                      </a>
                    ) : (
                      <span className="status">空闲</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="footer-actions">
        <span className="footer-actions__hint">正在被其他任务占用的环境不能选，等它结束后再发。</span>
        <button type="button" className="btn btn--ghost" onClick={onBack}>上一步</button>
        <button type="button" className="btn btn--primary" disabled={chosen.size === 0} onClick={onNext}>
          下一步：确认执行计划
        </button>
      </div>
    </>
  );
}

// ------------------------------------------------------------ ③ 确认执行计划

function PlanStep({ country, envNames, onBack }: { country: CountryView; envNames: string[]; onBack: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { allowed, ip } = useCanExecute();
  const [operator, setOperator] = useOperatorName();
  const plan = useQuery({
    queryKey: ["plan", country.code, envNames],
    queryFn: () => api.plan({ countryCode: country.code, envNames }),
    retry: false,
  });

  const create = useMutation({
    mutationFn: () => api.create({ countryCode: country.code, envNames, operatorName: operator.trim() || undefined }),
    onSuccess: ({ id }) => {
      void queryClient.invalidateQueries({ queryKey: ["config"] });
      void queryClient.invalidateQueries({ queryKey: ["deployments"] });
      navigate(`/deployments/${id}`);
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ["config"] });
      void plan.refetch();
    },
  });

  const busy = plan.data?.envs.filter((e) => e.busy) ?? [];
  const createErr = create.error;
  const busyDetails = createErr instanceof ApiError && createErr.code === "ENV_BUSY" ? (createErr.body.details as EnvBusyDetail[]) : null;

  return (
    <>
      {plan.isLoading && <Loading text="生成执行计划" />}
      {plan.isError && <Notice tone="err">生成执行计划失败：{errorMessage(plan.error)}</Notice>}
      {plan.data && <PlanList plan={plan.data} />}

      {plan.data && (
        <div className="confirm">
          <div>
            <Notice tone="warn">发布会直接覆盖线上目录。替换前的版本会保留为 dist.prev，需要回滚时可以登录服务器手工切回。</Notice>
            {busy.length > 0 && (
              <Notice tone="err">
                {busy.map((e) => `「${e.name}」正被 #${e.busy!.deploymentId} 占用`).join("，")}，请回到上一步取消勾选，或等它结束。
              </Notice>
            )}
            {!allowed && (
              <Notice tone="err">当前 IP {ip ?? ""} 不在白名单，只能查看执行计划。需要发布请联系管理员把 IP 加进 access.allowIps。</Notice>
            )}
            {createErr && !busyDetails && <Notice tone="err">发起失败：{errorMessage(createErr)}</Notice>}
            {busyDetails && (
              <Notice tone="err">
                发起失败：
                {busyDetails.map((d) => (
                  <span key={d.requestedEnv}>
                    「{d.requestedEnv}」被 <a className="link" href={`/deployments/${d.deploymentId}`}>#{d.deploymentId}</a> 占用；
                  </span>
                ))}
              </Notice>
            )}
          </div>
          <label className="field">
            <span className="field__label">操作人（选填，用于记录和飞书通知，只存在本机浏览器）</span>
            <span className="field__box">
              <span className="field__prompt" aria-hidden="true">&gt;</span>
              <input
                className="field__input"
                type="text"
                maxLength={40}
                placeholder="你的名字"
                value={operator}
                onChange={(e) => setOperator(e.target.value)}
              />
            </span>
          </label>
        </div>
      )}

      <div className="footer-actions">
        <span className="footer-actions__hint">
          {plan.data ? `${plan.data.countryName} · ${plan.data.envs.length} 个环境 · 同时最多执行 ${plan.data.maxConcurrent} 个，其余排队` : ""}
        </span>
        <button type="button" className="btn btn--ghost" onClick={onBack}>上一步</button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!allowed || !plan.data || busy.length > 0 || create.isPending}
          aria-busy={create.isPending}
          title={!allowed ? "当前 IP 不在白名单" : undefined}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "发起中…" : "开始发布"}
        </button>
      </div>
    </>
  );
}

function PlanList({ plan }: { plan: PlanResponse }) {
  return (
    <div className="plan">
      <p className="sec-title">
        <span>执行计划 · {plan.countryName} · {plan.envs.length} 个环境</span>
        <span>点击展开查看每一步的具体命令</span>
      </p>
      {plan.envs.map((e, i) => (
        <details key={e.name} className="plan-env" open={i === 0}>
          <summary className="plan-env__sum">
            <span className="plan-env__caret" aria-hidden="true">▶</span>
            <span className="ellipsis">
              <span className="plan-env__name">{e.name}</span>{" "}
              <span className="plan-env__route mono">
                {e.branch} → {e.host} : {e.remotePath}
              </span>
            </span>
            {e.busy ? <span className="tag tag--err tag--sm">占用：#{e.busy.deploymentId}</span> : <span className="tag tag--sm">{e.repo}</span>}
          </summary>
          <div className="plan-env__body">
            {e.steps.map((s, si) => (
              <div key={s.stage} className="plan-step">
                <span className="plan-step__no">{si + 1}</span>
                <span className="plan-step__name">{STAGE_NAMES[s.stage]}</span>
                <div className="plan-step__cmds">
                  {s.commands.map((c) => (
                    <p key={c} className="plan-step__cmd">{c}</p>
                  ))}
                  {s.note && <p className="plan-step__note">{s.note}</p>}
                </div>
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
