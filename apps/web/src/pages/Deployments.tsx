import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { DeploymentList, DeploymentStatus, DeploymentSummary } from "@shipyard/shared";
import { DEPLOYMENT_STATUS_NAMES, formatDuration, isDeploymentActive } from "@shipyard/shared";
import { api, errorMessage } from "../api.ts";
import { Select } from "../components/Select.tsx";
import { CrossIcon, DeploymentStatusTag, Loading, Notice, PageHead } from "../components/ui.tsx";
import { pollEvery, usePollStopped } from "../lib/poll.ts";
import { formatDateTime } from "../lib/time.ts";

const PAGE_SIZE = 20;
const STATUSES = Object.keys(DEPLOYMENT_STATUS_NAMES) as DeploymentStatus[];
const RANGES: [string, string, number | null][] = [
  ["", "全部时间", null],
  ["1d", "最近 24 小时", 1],
  ["7d", "最近 7 天", 7],
  ["30d", "最近 30 天", 30],
];

export function Deployments() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const country = params.get("country") ?? "";
  const env = params.get("env") ?? "";
  const status = (params.get("status") ?? "") as DeploymentStatus | "";
  const range = params.get("range") ?? "";
  const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
  const days = RANGES.find(([k]) => k === range)?.[2] ?? null;

  const config = useQuery({ queryKey: ["config"], queryFn: api.config });
  const listKey = ["deployments", { country, env, status, range, page }];
  const list = useQuery({
    queryKey: listKey,
    queryFn: () =>
      api.list({
        page,
        pageSize: PAGE_SIZE,
        country: country || undefined,
        env: env || undefined,
        status: status || undefined,
        from: days ? Date.now() - days * 24 * 3600 * 1000 : undefined,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: pollEvery<DeploymentList>((q) => (q.state.data?.items.some((d) => isDeploymentActive(d.status)) ? 3000 : 15000)),
  });
  const listStopped = usePollStopped(listKey);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    if (key === "country") next.delete("env");
    setParams(next);
  };

  const envOptions = (config.data?.countries ?? [])
    .filter((c) => !country || c.code === country)
    .flatMap((c) => c.environments.map((e) => e.name));
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / PAGE_SIZE)) : 1;

  return (
    <>
      <PageHead title="发布记录" meta="点击任意一行查看当时的执行参数、进度和日志。" />

      <div className="filters">
        <Select
          label="国家"
          value={country}
          onChange={(v) => set("country", v)}
          options={[
            { value: "", label: "全部国家" },
            ...(config.data?.countries ?? []).map((c) => ({ value: c.code, label: c.name, hint: c.code })),
          ]}
        />
        <Select
          label="环境"
          value={env}
          onChange={(v) => set("env", v)}
          options={[{ value: "", label: "全部环境" }, ...envOptions.map((n) => ({ value: n, label: n }))]}
        />
        <Select
          label="状态"
          value={status}
          onChange={(v) => set("status", v)}
          options={[{ value: "", label: "全部状态" }, ...STATUSES.map((s) => ({ value: s, label: DEPLOYMENT_STATUS_NAMES[s] }))]}
        />
        <Select label="时间" value={range} onChange={(v) => set("range", v)} options={RANGES.map(([k, label]) => ({ value: k, label }))} />
        {(country || env || status || range) && (
          <button type="button" className="btn filters__clear" onClick={() => setParams(new URLSearchParams())}>
            <CrossIcon />
            清除筛选
          </button>
        )}
      </div>

      {list.isError ? (
        <Notice tone="err">
          读取发布记录失败：{errorMessage(list.error)}
          {listStopped && "。连续多次失败，已停止自动刷新，刷新页面后重试"}
        </Notice>
      ) : !list.data ? (
        <Loading />
      ) : list.data!.items.length === 0 ? (
        <div className="empty">
          没有符合条件的发布记录。<Link className="link" to="/">新建发布</Link>
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>任务</th>
                  <th>发起时间</th>
                  <th>国家</th>
                  <th>环境</th>
                  <th>结果</th>
                  <th>操作人</th>
                  <th className="num">耗时</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {list.data!.items.map((d) => (
                  <Row key={d.id} d={d} onOpen={() => navigate(`/deployments/${d.id}`)} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <span>共 {list.data!.total} 条 · 第 {page}/{totalPages} 页</span>
            <button type="button" className="btn btn--ghost btn--sm" disabled={page <= 1} onClick={() => set("page", String(page - 1))}>上一页</button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={page >= totalPages} onClick={() => set("page", String(page + 1))}>下一页</button>
          </div>
        </>
      )}
    </>
  );
}

function Row({ d, onOpen }: { d: DeploymentSummary; onOpen: () => void }) {
  const took = d.startedAt && d.finishedAt ? formatDuration(d.finishedAt - d.startedAt) : isDeploymentActive(d.status) ? "…" : "—";
  const envs = d.envNames.length > 2 ? `${d.envNames.slice(0, 2).join("、")} 等 ${d.envCount} 个` : d.envNames.join("、");
  return (
    <tr className="is-clickable" onClick={onOpen}>
      <td className="nowrap">
        <Link className="link" to={`/deployments/${d.id}`} onClick={(e) => e.stopPropagation()}>#{d.id}</Link>
        {d.retryOf && <span className="muted pixel"> ↻#{d.retryOf}</span>}
      </td>
      <td className="nowrap dim">{formatDateTime(d.createdAt)}</td>
      <td className="nowrap">{d.countryName}</td>
      <td className="ellipsis" style={{ maxWidth: 320 }} title={d.envNames.join("、")}>{envs}</td>
      <td className="nowrap">
        <span className={d.doneCount === d.envCount ? "ok" : d.doneCount > 0 ? "warn" : "err"}>
          成功 {d.doneCount}/{d.envCount}
        </span>
      </td>
      <td className="nowrap dim">
        {d.operatorName ?? "—"} <span className="muted">{d.operatorIp}</span>
      </td>
      <td className="num dim">{took}</td>
      <td className="nowrap"><DeploymentStatusTag status={d.status} small /></td>
    </tr>
  );
}
