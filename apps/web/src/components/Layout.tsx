import { useLayoutEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet, useLocation } from "react-router";
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

// Right side only shows a marker when something is off: IP not allowlisted, or server unreachable.
function Topbar() {
  const who = useWhoami();
  const { pathname } = useLocation();
  const onDeployments = pathname.startsWith("/deployments");
  const onPlanner = pathname === "/" || pathname.startsWith("/p/");

  return (
    <nav className="topbar" aria-label="主导航">
      <NavLink to="/" className="topbar__brand" aria-label="Shipyard 首页">
        <span className="topbar__prompt" aria-hidden="true">&gt;_</span>Shipyard
        <span className="topbar__cursor" aria-hidden="true" />
      </NavLink>
      <div className="topbar__tabs">
        <NavLink to="/" className={() => `topbar__tab${onPlanner ? " is-current" : ""}`}>
          新建发布
        </NavLink>
        <NavLink to="/deployments" className={() => `topbar__tab${onDeployments ? " is-current" : ""}`}>
          发布记录
        </NavLink>
      </div>

      <div className="topbar__right">
        {who.data && !who.data.allowed && (
          <span className="status status--warn" title={`当前 IP ${who.data.ip || "未知"} 不在白名单，只能查看`}>只读</span>
        )}
        {who.isError && <span className="status status--err">服务未连接</span>}
        <ThemeSwitch />
      </div>
    </nav>
  );
}

export function Layout() {
  const main = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  // Start every page at its top. The content area is the scroller; on narrow
  // screens the whole page scrolls instead (see app.css), so reset both.
  useLayoutEffect(() => {
    main.current?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="page">
      <header className="page__head">
        <Topbar />
      </header>
      <main ref={main} className="page__main">
        <div className="page__body">
          <Outlet />
        </div>
      </main>
      <footer className="page__foot">
        <div className="foot">
          <span>Shipyard · 构建与发布</span>
        </div>
      </footer>
    </div>
  );
}
