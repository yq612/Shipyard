import type { CountryView } from "@shipyard/shared";

// Flags and silhouettes are vendored by scripts/gen-country-art.ts; a country
// without them (added to config.yaml since) still renders, just without art.
const FLAGS = import.meta.glob<string>("../assets/flags/*.svg", { import: "default", eager: true });
const MAPS = import.meta.glob<string>("../assets/maps/*.svg", { import: "default", eager: true });

function byCode(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -4).toUpperCase(), url]));
}
const FLAG_URLS = byCode(FLAGS);
const MAP_URLS = byCode(MAPS);

export function flagUrl(code: string): string | undefined {
  return FLAG_URLS.get(code);
}

export function CountryCard({ country, current, onPick }: { country: CountryView; current: boolean; onPick: (code: string) => void }) {
  const flag = FLAG_URLS.get(country.code);
  const map = MAP_URLS.get(country.code);
  return (
    <button
      type="button"
      role="listitem"
      className={`country${current ? " is-current" : ""}`}
      onClick={() => onPick(country.code)}
    >
      {map && <span className="country__map" style={{ maskImage: `url("${map}")` }} aria-hidden="true" />}
      <span className="country__code">{country.code}</span>
      <p className="country__name">
        {flag && <img className="country__flag" src={flag} alt="" />}
        {country.name}
      </p>
      <p className="country__envs">{country.environments.map((e) => e.name.replace(/\s*环境$/, "")).join(" · ")}</p>
      <span className="country__meta">
        <span className="country__count">
          <b>{country.environments.length}</b> 个环境
        </span>
        {country.busyCount > 0 && <span className="status status--ok">{country.busyCount} 个发布中</span>}
      </span>
    </button>
  );
}
