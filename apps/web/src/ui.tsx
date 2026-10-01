import { useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";

/** The few shapes every screen shares, so that a button looks the same wherever it is. */

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");
export { cx };

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "plain" | "quiet" | "danger"; size?: "md" | "sm" };

export function Button({ tone = "plain", size = "md", className, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg font-semibold whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-45",
        size === "md" ? "h-10 px-4" : "h-8 px-3 text-xs",
        tone === "primary" && "bg-accent text-accent-ink",
        tone === "plain" && "border border-line-strong text-ink hover:bg-hover",
        tone === "quiet" && "bg-hover text-ink",
        tone === "danger" && "bg-warn text-[#2a0e00]",
        className,
      )}
    />
  );
}

/**
 * The one text box of the app: as tall as what is written in it, never with a scroll bar of its own.
 * `rows` is how tall it is while empty.
 */
export function AutoText({ value, className, rows = 2, ...rest }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value"> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      // the border is not part of what scrollHeight measures
      el.style.height = `${el.scrollHeight + 2}px`;
    };
    fit();
    // the same text takes more lines when the box gets narrower
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, [value]);
  return <textarea ref={ref} rows={rows} value={value} {...rest} className={cx("resize-none overflow-hidden", className)} />;
}

/**
 * A number to type: what is written is taken when the box is left or Enter is pressed, brought back
 * within its limits and onto its steps. A comma works as a decimal point.
 */
export function NumberBox({ value, min, max, step = 1, unit, label, id, onCommit, className }: {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  label: string;
  id?: string;
  onCommit(value: number): void;
  className?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const decimals = (String(step).split(".")[1] ?? "").length;
  const commit = () => {
    if (text === null) return;
    const typed = Number(text.replace(",", ".").trim());
    setText(null);
    if (!Number.isFinite(typed) || text.trim() === "") return;
    const snapped = Number((Math.round(Math.max(min, Math.min(max, typed)) / step) * step).toFixed(decimals));
    if (snapped !== value) onCommit(snapped);
  };
  return (
    <span className={cx("inline-flex items-baseline gap-1 font-mono text-ink-2", className)}>
      <input
        id={id}
        aria-label={label}
        inputMode="decimal"
        value={text ?? value.toFixed(decimals)}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setText(null);
        }}
        className="h-7 w-16 rounded-md border border-line bg-raised px-1.5 text-right text-ink focus:border-accent"
      />
      {unit && <span>{unit.trim()}</span>}
    </span>
  );
}

export function Toggle({ on, onChange, label, note }: { on: boolean; onChange(on: boolean): void; label: string; note?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => onChange(!on)}
        className={cx("h-[22px] w-[38px] shrink-0 rounded-full p-[3px]", on ? "bg-accent" : "bg-line-strong")}
      >
        <span className={cx("block h-4 w-4 rounded-full bg-white transition-[margin]", on && "ml-4")} />
      </button>
      <span>{label}</span>
      {note && <span className="text-xs text-ink-2">{note}</span>}
    </div>
  );
}

/** A row of choices where one is on. */
export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange(value: T): void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex shrink-0 gap-1 rounded-[9px] bg-raised p-[3px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx("h-7 grow rounded-md px-2 text-xs font-semibold whitespace-nowrap", o.value === value ? "bg-line-strong text-white" : "text-ink-2")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">{children}</div>;
}

export function Bar({ value, tone = "accent" }: { value: number; tone?: "accent" | "picture" | "warn" }) {
  const color = tone === "accent" ? "bg-accent" : tone === "warn" ? "bg-warn" : "bg-picture";
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-line">
      <div className={cx("h-full", color)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

/** Shown where a list has nothing in it yet: says what will appear and how to get it there. */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-line-strong px-8 py-14 text-center">
      <div className="text-base font-semibold">{title}</div>
      {children && <div className="max-w-md text-ink-2">{children}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div role="alert" className="rounded-lg bg-warn-wash px-3 py-2 text-warn-ink">{children}</div>;
}
