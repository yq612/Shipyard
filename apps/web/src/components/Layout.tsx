import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet, useLocation } from "react-router";
import type { ServerStatus } from "@shipyard/shared";
import { api } from "../api.ts";
import { pollEvery } from "../lib/poll.ts";
import { ThemeSwitch } from "./ThemeSwitch.tsx";

function useWhoami() {
  return useQuery({ queryKey: ["whoami"], queryFn: api.whoami, staleTime: 60_000, refetchInterval: pollEvery(60_000) });
}

export function useCanExecute(): { allowed: boolean; ip: string | undefined; loading: boolean } {
  const q = useWhoami();
  return { allowed: q.data?.allowed ?? false, ip: q.data?.ip, loading: q.isLoading };
}

function Topbar() {
  const who = useWhoami();
  // Only the counters in this bar use it: poll fast while something runs, slowly when idle.
  const status = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    refetchInterval: pollEvery<ServerStatus>((q) => (q.state.data && q.state.data.runningEnvs + q.state.data.queuedEnvs > 0 ? 3000 : 15000)),
    retry: false,
  });
  const { pathname } = useLocation();
  const onDeployments = pathname.startsWith("/deployments");

  return (
    <nav className="nav topbar" aria-label="主导航">
      <NavLink to="/" className="nav__brand" aria-label="Shipyard 首页">
        <span className="topbar__prompt" aria-hidden="true">&gt;_</span>Shipyard
        <span className="topbar__cursor" aria-hidden="true" />
      </NavLink>
      <NavLink to="/" end className={({ isActive }) => `nav__link${isActive ? " is-current" : ""}`}>
        新建发布
      </NavLink>
      <NavLink to="/deployments" className={() => `nav__link${onDeployments ? " is-current" : ""}`}>
        发布记录
      </NavLink>

      <div className="topbar__right">
        {status.data && (
          <span className="topbar__stat" title={`同时最多执行 ${status.data.maxConcurrent} 个环境`}>
            执行中 <b>{status.data.runningEnvs}</b> · 排队 <b>{status.data.queuedEnvs}</b>
            {status.data.shuttingDown && <span className="warn"> · 服务停止中</span>}
          </span>
        )}
        <span className="topbar__sep" aria-hidden="true" />
        {who.data ? (
          <span className="topbar__ip" title={who.data.allowed ? "该 IP 在白名单内，可以发起、取消、重试" : "该 IP 不在白名单，只能查看"}>
            IP {who.data.ip || "未知"} ·{" "}
            {who.data.allowed ? <span className="status status--ok">可执行</span> : <span className="status status--warn">仅可查看</span>}
          </span>
        ) : who.isError ? (
          <span className="topbar__ip err">服务未连接</span>
        ) : null}
        <ThemeSwitch />
      </div>
    </nav>
  );
}

export function Layout() {
  return (
    <div className="page">
      <Topbar />
      <main className="page__main">
        <Outlet />
      </main>
      <footer className="foot">
        <span>Shipyard · 构建与发布</span>
      </footer>
    </div>
  );
}
