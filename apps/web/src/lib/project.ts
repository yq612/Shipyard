// Remembers the project last opened in the wizard, so `/` returns to it.
const KEY = "shipyard:project";

export function lastProject(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function rememberProject(key: string): void {
  try {
    localStorage.setItem(KEY, key);
  } catch {
    // private mode etc. — `/` falls back to the first project
  }
}

// The wizard, opened at the plan step with these environments preselected.
export function plannerUrl(project: string, countryCode: string | null, envNames: string[]): string {
  const p = new URLSearchParams();
  if (countryCode) p.set("country", countryCode);
  p.set("envs", envNames.join("\u0001"));
  p.set("step", "2");
  return `/p/${encodeURIComponent(project)}?${p}`;
}
