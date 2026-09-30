import { NavLink } from "react-router";
import type { ProjectView } from "@shipyard/shared";
import { flagUrl } from "./CountryCard.tsx";

// 9×9 pixel icons shown at 18px (2×). A project's `icon` picks one by file
// name; none or an unknown name gets the folder.
const ICONS = import.meta.glob<string>("../assets/projects/*.svg", { import: "default", eager: true });
const ICON_URLS = new Map(Object.entries(ICONS).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -4), url]));

function iconUrl(name: string | null): string | undefined {
  return ICON_URLS.get(name ?? "") ?? ICON_URLS.get("folder");
}

// Left column of the planner: every project, and under the current one (when
// it is grouped by country) its countries, so the country can be switched
// from any step without going back to ①.
export function ProjectNav({
  projects,
  current,
  country,
  onCountry,
}: {
  projects: ProjectView[];
  current: string;
  country: string | null;
  onCountry: (code: string) => void;
}) {
  return (
    <nav className="pnav" aria-label="项目">
      <p className="pnav__cap">项目 · {projects.length}</p>
      {projects.map((p) => {
        const here = p.key === current;
        const icon = iconUrl(p.icon);
        return (
          <div key={p.key} className="pnav__group">
            <NavLink to={`/p/${p.key}`} className={`pnav__item${here ? " is-current" : ""}`} aria-current={here ? "page" : undefined}>
              <span className="pnav__icon" style={icon ? { maskImage: `url("${icon}")` } : undefined} aria-hidden="true" />
              <span className="ellipsis">{p.name}</span>
              <span className="pnav__meta">
                {p.error ? (
                  <span className="err" title={p.error}>!</span>
                ) : p.busyCount > 0 ? (
                  <span className="status status--ok" title={`${p.busyCount} 个环境发布中`}>{p.busyCount}</span>
                ) : null}
                {p.envCount}
              </span>
            </NavLink>
            {here && p.grouping === "country" && p.countries.length > 0 && (
              <ul className="pnav__tree">
                {p.countries.map((c, i) => {
                  const flag = flagUrl(c.code);
                  return (
                    <li key={c.code}>
                      <button
                        type="button"
                        className={`pnav__leaf${c.code === country ? " is-current" : ""}`}
                        aria-current={c.code === country ? "true" : undefined}
                        onClick={() => onCountry(c.code)}
                      >
                        <span className="pnav__branch" aria-hidden="true">{i === p.countries.length - 1 ? "└─" : "├─"}</span>
                        {flag ? <img className="pnav__flag" src={flag} alt="" /> : <span />}
                        <span className="ellipsis">{c.name}</span>
                        <span className="pnav__meta">
                          {c.busyCount > 0 && <span className="status status--ok" title={`${c.busyCount} 个环境发布中`}>{c.busyCount}</span>}
                          {c.environments.length}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}
