import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { HelpCircle, Trash2 } from "lucide-react";
import { PANEL, useExplain, usePanelWidth } from "./store";

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
        tone === "danger" && "bg-warn text-warn-on",
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

/** `bare`: the switch alone, where what it switches is already written beside it; the label is still what a screen reader says. */
export function Toggle({ on, onChange, label, note, bare }: { on: boolean; onChange(on: boolean): void; label: string; note?: string; bare?: boolean }) {
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
        <span className={cx("block h-4 w-4 rounded-full transition-[margin]", on ? "ml-4 bg-knob" : "bg-white")} />
      </button>
      {!bare && <span>{label}</span>}
      {!bare && <Note text={note} />}
    </div>
  );
}

/**
 * A small ? that tells something on hover or focus: where a line of explanation would be noise. The
 * text is drawn over everything (not inside the panel, which would cut it), under the ? when there is
 * room and above it otherwise, kept on the screen.
 */
export function Help({ text, className }: { text: string; className?: string }) {
  const [at, setAt] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const width = 272;
    const left = Math.max(8, Math.min(r.left - 8, window.innerWidth - width - 8));
    // under it when there is room for a few lines, else above
    setAt(window.innerHeight - r.bottom > 120 ? { left, top: r.bottom + 6 } : { left, bottom: window.innerHeight - r.top + 6 });
  };
  return (
    <span className={cx("inline-flex shrink-0 items-center", className)}>
      <button
        type="button"
        aria-label={text}
        onMouseEnter={(e) => show(e.currentTarget)}
        onFocus={(e) => show(e.currentTarget)}
        onMouseLeave={() => setAt(null)}
        onBlur={() => setAt(null)}
        className="flex h-4 w-4 items-center justify-center rounded-full text-ink-3 hover:text-ink focus:text-ink"
      >
        <HelpCircle size={13} />
      </button>
      {at && createPortal(
        <span role="tooltip" style={{ left: at.left, top: at.top, bottom: at.bottom, width: 272 }} className="pointer-events-none fixed z-[80] rounded-lg border border-line-strong bg-raised px-2.5 py-2 text-left text-xs leading-snug font-normal normal-case tracking-normal text-ink shadow-xl shadow-shade/40">
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}

/** A control's explanation: a line while forms explain themselves, else a ? that tells on hover. Nothing when there is nothing to say. */
export function Note({ text, className }: { text?: string; className?: string }) {
  const on = useExplain((s) => s.on);
  if (!text) return null;
  return on ? <span className={cx("text-xs text-ink-2", className)}>{text}</span> : <Help text={text} className={className} />;
}

/** The edge of a side panel: dragged, it makes the panel wider or narrower (remembered). `side`: which edge of the panel it is. */
export function PanelEdge({ side }: { side: "left" | "right" }) {
  const set = usePanelWidth((s) => s.set);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Drag to make the panel wider or narrower"
      title="Drag to make the panel wider or narrower"
      onPointerDown={(e) => {
        const startX = e.clientX;
        const startWidth = usePanelWidth.getState().width;
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => set(startWidth + (side === "right" ? ev.clientX - startX : startX - ev.clientX));
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      onDoubleClick={() => set(PANEL.usual)}
      className={cx("absolute top-0 bottom-0 z-20 w-1.5 cursor-col-resize hover:bg-accent/40 active:bg-accent/60", side === "right" ? "-right-0.5" : "-left-0.5")}
    />
  );
}

/** A row of choices where one is on. */
export function Segmented<T extends string>({ value, options, onChange, label, oneLine }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange(value: T): void;
  label: string;
  /** Kept on one line, whatever the room (a bar of switches in a header); otherwise the chips wrap. */
  oneLine?: boolean;
}) {
  return (
    // the chips wrap onto another line rather than run past the edge of a narrow panel (seven shapes do)
    <div role="radiogroup" aria-label={label} className={cx("flex gap-1 rounded-[9px] bg-raised p-[3px]", oneLine ? "shrink-0 flex-nowrap" : "max-w-full flex-wrap")}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx("h-7 grow rounded-md px-2 text-xs font-semibold whitespace-nowrap", o.value === value ? "bg-line-strong text-ink-strong" : "text-ink-2")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A column that scrolls. While there is more under what is shown, its bottom fades out and an arrow
 * says so: a list cut at the edge of its box otherwise looks like it ends there.
 */
export function ScrollColumn({ className, children }: { className?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const look = () => {
    const el = box.current;
    if (el) setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 12);
  };
  // what it holds changes height with every setting that shows or hides another: looked at whenever its size changes
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    look();
    const watch = new ResizeObserver(look);
    watch.observe(el);
    for (const child of el.children) watch.observe(child);
    const added = new MutationObserver(() => {
      for (const child of el.children) watch.observe(child);
      look();
    });
    added.observe(el, { childList: true });
    return () => {
      watch.disconnect();
      added.disconnect();
    };
  }, []);
  return (
    <div className="relative flex min-h-0 grow flex-col">
      <div ref={box} onScroll={look} className={cx("min-h-0 grow overflow-y-auto", className)}>{children}</div>
      {more && (
        <button
          type="button"
          aria-label="There is more below: go down"
          title="There is more below"
          onClick={() => box.current?.scrollBy({ top: box.current.clientHeight * 0.8, behavior: "smooth" })}
          style={{ background: "linear-gradient(to top, var(--color-panel) 35%, transparent)" }}
          className="absolute inset-x-0 bottom-0 flex h-12 items-end justify-center pb-1 text-ink-2 hover:text-ink"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </button>
      )}
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

/**
 * A button that asks once more before it does something that cannot simply be undone: pressed, it
 * becomes a word about what happens, the button that does it, and a way back. Left alone for a few
 * seconds, it folds back. Without `label` it is the small icon button (a bin unless `icon` says
 * otherwise), named by `title`.
 */
export function TwoStep({ label, icon, title, note, yes, cancel = "Cancel", onYes, onAsk, disabled, busy, className }: {
  /** What the button says before it asks; left out, a small icon button. */
  label?: ReactNode;
  icon?: ReactNode;
  title: string;
  /** What happens, in a few words, shown beside the two buttons. */
  note?: string;
  /** What the button that goes ahead says. */
  yes: ReactNode;
  cancel?: string;
  onYes(): void;
  /** Something to do as it starts asking (clear what an earlier go left on screen). */
  onAsk?(): void;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const back = setTimeout(() => setAsking(false), 6000);
    return () => clearTimeout(back);
  }, [asking]);
  if (asking) {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        {note && <span className="text-xs text-ink-2">{note}</span>}
        <Button size="sm" tone="danger" autoFocus disabled={busy} onClick={() => { setAsking(false); onYes(); }}>{yes}</Button>
        <Button size="sm" tone="quiet" onClick={() => setAsking(false)}>{cancel}</Button>
      </span>
    );
  }
  const ask = () => {
    onAsk?.();
    setAsking(true);
  };
  if (label === undefined) {
    return (
      <button type="button" aria-label={title} title={title} disabled={disabled} onClick={ask} className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40", className)}>
        {icon ?? <Trash2 size={14} />}
      </button>
    );
  }
  return (
    <Button size="sm" title={title} disabled={disabled} onClick={ask} className={className}>
      {icon}
      {label}
    </Button>
  );
}
