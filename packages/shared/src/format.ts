export function formatDuration(ms: number): string {
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h > 0 ? `${h}h${m}m${s}s` : `${m}m${s}s`;
}

export function shortSha(sha: string | undefined | null): string {
  return sha ? sha.slice(0, 7) : "";
}

// Strips credentials out of URLs (https://user:token@host → https://***@host)
// so repo addresses can be shown in logs and API responses.
export function redactUrl(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@");
}

// "充值网站 · 巴基斯坦", or just the project for ungrouped projects.
export function scopeLabel(projectName: string, countryName: string | null): string {
  return countryName ? `${projectName} · ${countryName}` : projectName;
}

// Every environment of a project, whichever way it is grouped.
export function projectEnvs<E>(project: { countries: { environments: E[] }[]; environments: E[] }): E[] {
  return [...project.environments, ...project.countries.flatMap((c) => c.environments)];
}
