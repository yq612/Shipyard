import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { CheckIcon } from "./ui.tsx";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  /** Muted note on the right of the option, e.g. a country code. */
  hint?: string;
  disabled?: boolean;
}

const PAGE = 8; // PageUp / PageDown step: one screenful of the list

// Scroll inside the list only — scrollIntoView would drag the page along too.
function reveal(list: HTMLElement | null, i: number) {
  const el = list?.children[i];
  if (!list || !(el instanceof HTMLElement)) return;
  const pad = (list.firstElementChild as HTMLElement).offsetTop;
  if (el.offsetTop - pad < list.scrollTop) list.scrollTop = el.offsetTop - pad;
  else if (el.offsetTop + el.offsetHeight + pad > list.scrollTop + list.clientHeight) {
    list.scrollTop = el.offsetTop + el.offsetHeight + pad - list.clientHeight;
  }
}

// Stand-in for <select>, whose option list can't be styled.
// Follows the WAI-ARIA select-only combobox: focus stays on the box and the
// highlighted option is announced through aria-activedescendant.
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: ReactNode;
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [up, setUp] = useState(false);

  const selected = options.findIndex((o) => o.value === value);
  const optionId = (i: number) => `${id}opt${i}`;
  const enabled = (i: number) => !!options[i] && !options[i].disabled;

  // `count` enabled options away from `from` in direction `dir`, stopping at the ends.
  const step = (from: number, dir: 1 | -1, count = 1) => {
    let found = from;
    for (let i = from + dir; i >= 0 && i < options.length && count > 0; i += dir) {
      if (enabled(i)) {
        found = i;
        count--;
      }
    }
    return found;
  };

  // Type to jump: keys typed in quick succession match the start of a label or
  // hint; a single key searches from the next option, so repeating it cycles.
  const find = (key: string, from: number) => {
    const now = Date.now();
    const t = typed.current;
    t.text = (now - t.at < 600 ? t.text : "") + key.toLowerCase();
    t.at = now;
    const start = t.text.length === 1 ? from + 1 : Math.max(from, 0);
    for (let n = 0; n < options.length; n++) {
      const i = (start + n) % options.length;
      const o = options[i]!;
      if (!o.disabled && [o.label, o.hint ?? ""].some((s) => s.toLowerCase().startsWith(t.text))) return i;
    }
    return -1;
  };

  const show = (i: number) => {
    if (disabled) return;
    setActive(enabled(i) ? i : step(-1, 1));
    setOpen(true);
  };
  const move = (i: number) => {
    if (i < 0) return;
    setActive(i);
    reveal(listRef.current, i);
  };
  const pick = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    setOpen(false);
    boxRef.current?.focus();
    if (o.value !== value) onChange(o.value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const { key } = e;
    if (key.length === 1 && key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const i = find(key, open ? active : selected);
      if (i >= 0) (open ? move : show)(i);
      return;
    }
    if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") show(selected);
      else if (key === "Home") show(step(-1, 1));
      else if (key === "End") show(step(options.length, -1));
      else return;
      e.preventDefault();
      return;
    }
    switch (key) {
      case "ArrowDown": move(step(active, 1)); break;
      case "ArrowUp": move(active < 0 ? step(options.length, -1) : step(active, -1)); break;
      case "PageDown": move(step(active, 1, PAGE)); break;
      case "PageUp": move(step(active, -1, PAGE)); break;
      case "Home": move(step(-1, 1)); break;
      case "End": move(step(options.length, -1)); break;
      case "Enter":
      case " ": pick(active); break;
      case "Escape": setOpen(false); break;
      case "Tab": setOpen(false); return;
      default: return;
    }
    e.preventDefault();
  };

  // Runs only as it opens: flip upwards when the list would run off the bottom
  // of the visible content area and there's more room above, then scroll to the highlight.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const list = listRef.current;
    if (!open || !root || !list) return;
    const box = root.getBoundingClientRect();
    // The fixed header and footer cover the window's edges; on narrow screens
    // the whole page scrolls instead and the window is the limit.
    const view = root.closest(".page__main")?.getBoundingClientRect();
    const below = Math.min(view?.bottom ?? Infinity, window.innerHeight) - box.bottom;
    const above = box.top - Math.max(view?.top ?? 0, 0);
    setUp(below < list.offsetHeight && above > below);
    reveal(list, active);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const labelId = `${id}label`;
  return (
    <div className="field">
      <span className="field__label" id={labelId} onClick={() => boxRef.current?.focus()}>{label}</span>
      <div ref={rootRef} className={`select${open ? " is-open" : ""}${up ? " is-up" : ""}`}>
        <div
          ref={boxRef}
          className="select__box"
          role="combobox"
          tabIndex={disabled ? -1 : 0}
          aria-labelledby={labelId}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={`${id}list`}
          aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
          aria-disabled={disabled || undefined}
          onClick={() => (open ? setOpen(false) : show(selected))}
          onKeyDown={onKeyDown}
          onBlur={(e) => {
            // Clicking the list's scrollbar blurs to <body> (no relatedTarget): stay open.
            if (e.relatedTarget && !rootRef.current?.contains(e.relatedTarget)) setOpen(false);
          }}
        >
          {/* All labels share one grid cell, so the box is as wide as the longest
              and keeps its width when the value changes. */}
          <span className="select__value">
            {options.map((o) => (
              <span key={o.value} className="select__sizer" aria-hidden="true">{o.label}</span>
            ))}
            <span>{options[selected]?.label ?? value}</span>
          </span>
          <span className="select__caret" aria-hidden="true" />
        </div>
        <ul ref={listRef} id={`${id}list`} className="select__list" role="listbox" aria-labelledby={labelId} hidden={!open}>
          {options.map((o, i) => (
            <li
              key={o.value}
              id={optionId(i)}
              role="option"
              aria-selected={i === selected}
              aria-disabled={o.disabled || undefined}
              className={`select__opt${i === active ? " is-active" : ""}`}
              // Keep focus on the box so the keyboard keeps working.
              onMouseDown={(e) => e.preventDefault()}
              onPointerMove={() => {
                if (i !== active && !o.disabled) setActive(i);
              }}
              onClick={() => pick(i)}
            >
              <span className="select__mark">{i === selected && <CheckIcon />}</span>
              <span className="grow">{o.label}</span>
              {o.hint && <span className="select__hint">{o.hint}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
