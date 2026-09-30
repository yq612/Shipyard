import { useEffect, useState } from "react";

type Pref = "auto" | "dark" | "light";

declare global {
  interface Window {
    phosphorTheme?: { set(pref: Pref): void; get(): Pref };
  }
}

const OPTIONS: [Pref, string, string][] = [
  ["auto", "跟随系统", "ico-monitor"],
  ["dark", "暗色", "ico-moon"],
  ["light", "亮色", "ico-sun"],
];

// phosphor-theme.js binds clicks on [data-theme-set] by delegation, but only
// syncs aria-pressed for buttons present at page load — React renders later,
// so the pressed state is tracked here from the script's change event.
export function ThemeSwitch() {
  const [pref, setPref] = useState<Pref>(() => window.phosphorTheme?.get() ?? "auto");
  useEffect(() => {
    const onChange = (e: Event) => setPref((e as CustomEvent<{ pref: Pref }>).detail.pref);
    document.addEventListener("phosphor:themechange", onChange);
    return () => document.removeEventListener("phosphor:themechange", onChange);
  }, []);
  return (
    <div className="seg seg--icon" role="group" aria-label="主题">
      {OPTIONS.map(([value, label, icon]) => (
        <button key={value} className="seg__opt" type="button" data-theme-set={value} aria-pressed={pref === value} aria-label={label} title={label}>
          <span className={icon} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
