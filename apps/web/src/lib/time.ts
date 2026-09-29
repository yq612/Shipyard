import { useEffect, useState } from "react";

const pad = (n: number) => String(n).padStart(2, "0");

export function formatTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDateTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const now = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() !== now.getFullYear()) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

// Ticks every `intervalMs` while `active`, returning Date.now().
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return now;
}

// Braille spinner frame, ticking only while something runs.
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function useSpinner(active: boolean): string {
  const now = useNow(active, 100);
  return FRAMES[Math.floor(now / 100) % FRAMES.length]!;
}
