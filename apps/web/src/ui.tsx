import { useEffect, useLayoutEffect, useRef, useState, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { Check, Trash2 } from "lucide-react";
import { PANEL, useExplain, usePanelWidth } from "./store";

/** The few shapes every screen shares, so that a button looks the same wherever it is. */

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");
export { cx };

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "plain" | "quiet" | "danger"; size?: "md" | "sm" };

/** The look of a button of the kit, for what is not a <button>: a link (wouter's Link takes it as its className), a download. */
export const buttonClass = ({ tone = "plain", size = "md", className }: { tone?: ButtonProps["tone"]; size?: ButtonProps["size"]; className?: string } = {}) =>
  cx(
    "inline-flex items-center justify-center gap-2 font-semibold whitespace-nowrap transition-[filter,background-color] disabled:cursor-not-allowed disabled:opacity-45",
    size === "md" ? "h-10 rounded-[10px] px-4" : "h-8 rounded-lg px-3 text-xs",
    // off, a button does not answer the mouse either: a hover that still lights it would read as half on
    tone === "primary" && "bg-accent font-bold text-accent-ink hover:brightness-110 disabled:hover:brightness-100",
    tone === "plain" && "border border-line-strong text-ink hover:bg-hover disabled:hover:bg-transparent",
    tone === "quiet" && "bg-hover text-ink hover:brightness-110 disabled:hover:brightness-100",
    tone === "danger" && "bg-warn-wash font-bold text-warn-ink hover:brightness-125 disabled:hover:brightness-100",
    className,
  );

export function Button({ tone = "plain", size = "md", className, ...rest }: ButtonProps) {
  return <button type="button" {...rest} className={buttonClass({ tone, size, className })} />;
}

/** A link that looks like a button of the kit: a download, a page outside the app. */
export function ButtonLink({ tone, size, className, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { tone?: ButtonProps["tone"]; size?: ButtonProps["size"] }) {
  return <a {...rest} className={buttonClass({ tone, size, className })} />;
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
        className="h-[30px] w-[60px] rounded-lg border border-line bg-raised px-1.5 text-center text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-wash)]"
      />
      {unit && <span>{unit.trim()}</span>}
    </span>
  );
}

/** `bare`: the switch alone, where what it switches is already written beside it; the label is still what a screen reader says. */
export function Toggle({ on, onChange, label, note, bare, disabled }: { on: boolean; onChange(on: boolean): void; label: string; note?: string; bare?: boolean; disabled?: boolean }) {
  return (
    <div className={cx("flex items-center gap-2.5", disabled && "opacity-50")}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={cx(
          "h-6 w-10 shrink-0 rounded-full p-[3px] transition-[background-color,box-shadow]",
          on ? "bg-accent" : "bg-line-strong",
          disabled ? "cursor-not-allowed" : "hover:shadow-[0_0_0_4px_var(--color-accent-wash)]",
        )}
      >
        <span className={cx("block h-[18px] w-[18px] rounded-full transition-[margin] motion-reduce:transition-none", on ? "ml-4 bg-knob" : "bg-ink")} />
      </button>
      {!bare && <span>{label}</span>}
      {!bare && <Note text={note} />}
    </div>
  );
}

/**
 * A small ? that tells something on hover or focus: where a line of explanation would be noise. What it says
 * is the app's tooltip (Tip.tsx), with its arrow; `title` is a bold first line over it.
 */
export function Help({ text, title, className }: { text: string; title?: string; className?: string }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center", className)}>
      <button
        type="button"
        data-help=""
        aria-label={title ? `${title}: ${text}` : text}
        data-tip={text}
        data-tip-head={title}
        className="flex h-4 w-4 items-center justify-center rounded-full bg-accent-wash text-[10px] leading-none font-bold text-accent hover:brightness-125 focus-visible:brightness-125"
      >
        ?
      </button>
    </span>
  );
}

/** A control's explanation: a line while forms explain themselves, else a ? that tells on hover. Nothing when there is nothing to say. */
export function Note({ text, className }: { text?: string; className?: string }) {
  const on = useExplain((s) => s.on);
  if (!text) return null;
  return on ? <span className={cx("text-xs text-ink-2", className)}>{text}</span> : <Help text={text} className={className} />;
}

/**
 * The edge of a side panel: dragged, it makes the panel wider or narrower (remembered). `side`: which edge of the
 * panel it is. `size`: a panel with a width of its own (the timeline editor's column); the form's panel otherwise.
 */
export function PanelEdge({ side, size }: { side: "left" | "right"; size?: { get(): number; set(width: number): void; usual: number } }) {
  const setPanel = usePanelWidth((s) => s.set);
  const set = size?.set ?? setPanel;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Drag to make the panel wider or narrower"
      data-tip="Drag to make the panel wider or narrower"
      onPointerDown={(e) => {
        const startX = e.clientX;
        const startWidth = size ? size.get() : usePanelWidth.getState().width;
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
      onDoubleClick={() => set(size?.usual ?? PANEL.usual)}
      className={cx("absolute top-0 bottom-0 z-20 w-1.5 cursor-col-resize hover:bg-accent/40 active:bg-accent/60", side === "right" ? "-right-0.5" : "-left-0.5")}
    />
  );
}

/** A row of choices where one is on: a pill holding them, the one on lit. `sm`: smaller, for a dense bar (time windows). `mono`: choices that are figures (1H, 24H). */
export function Segmented<T extends string>({ value, options, onChange, label, oneLine, size = "md", mono, className }: {
  value: T;
  options: Array<{ value: T; label: ReactNode; tip?: string }>;
  onChange(value: T): void;
  label: string;
  /** Kept on one line, whatever the room (a bar of switches in a header); otherwise the chips wrap. */
  oneLine?: boolean;
  size?: "md" | "sm";
  mono?: boolean;
  className?: string;
}) {
  return (
    // the chips wrap onto another line rather than run past the edge of a narrow panel (seven shapes do)
    <div role="radiogroup" aria-label={label} className={cx("flex gap-0.5 rounded-xl bg-raised p-[3px]", oneLine ? "shrink-0 flex-nowrap" : "max-w-full flex-wrap", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          data-tip={o.tip}
          onClick={() => onChange(o.value)}
          className={cx(
            "grow rounded-[9px] whitespace-nowrap transition-colors",
            size === "md" ? "h-[30px] px-3 text-[12.5px]" : "h-[26px] px-2.5 text-xs",
            mono && "font-mono",
            o.value === value ? "bg-line-strong font-bold text-ink" : "font-semibold text-ink-2 hover:bg-hover hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The kit's text box look: a rounded box on the raised colour, an accent ring while typing, the warn colour when what is in it is wrong (aria-invalid). */
export const fieldClass =
  "rounded-[10px] border border-line bg-raised px-3 text-ink outline-none placeholder:text-ink-3 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-wash)] aria-[invalid=true]:border-warn";

/** A box to tick: the app's own, with a third state for "some of them" (a selection that holds part of a list). */
export function Checkbox({ checked, onChange, label, children, disabled, className }: {
  checked: boolean | "some";
  onChange(checked: boolean): void;
  /** What a screen reader says, when there is no text beside it. */
  label?: string;
  children?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const on = checked !== false;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked === "some" ? "mixed" : checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(checked !== true);
      }}
      className={cx("group/check inline-flex items-center gap-2.5 text-left disabled:cursor-not-allowed disabled:opacity-50", className)}
    >
      <span
        aria-hidden
        className={cx(
          "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[6px] transition-colors",
          on ? "bg-accent text-accent-ink" : "border-[1.5px] border-line-strong group-hover/check:border-ink-3",
        )}
      >
        {checked === true && <Check size={12} strokeWidth={3.5} />}
        {checked === "some" && <span className="h-[2.5px] w-2 rounded-full bg-accent-ink" />}
      </span>
      {children}
    </button>
  );
}

/** A status chip: what something is (to render, unused, exported), or where it is (a folder), then clickable. */
export function Chip({ tone = "neutral", children, onClick, tip, className }: { tone?: "neutral" | "warn" | "good" | "accent" | "link"; children: ReactNode; onClick?(): void; tip?: string; className?: string }) {
  const look = cx(
    "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold whitespace-nowrap",
    tone === "neutral" && "bg-hover text-ink-2",
    tone === "warn" && "bg-warn-wash text-warn-ink",
    tone === "good" && "bg-good/15 text-good",
    tone === "accent" && "bg-accent-wash text-accent",
    tone === "link" && "border border-line-strong text-ink",
    onClick && "hover:brightness-125",
    className,
  );
  return onClick ? <button type="button" data-tip={tip} onClick={onClick} className={look}>{children}</button> : <span data-tip={tip} className={look}>{children}</span>;
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
          data-tip="There is more below"
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
    <div className="h-1.5 overflow-hidden rounded-full bg-line-strong">
      <div className={cx("h-full rounded-full transition-[width] motion-reduce:transition-none", color)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

/** Shown where a list has nothing in it yet: says what will appear and how to get it there. `help`: the why and the how, behind a "?" beside the title. */
export function Empty({ title, help, children }: { title: string; help?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-line-strong px-8 py-14 text-center">
      <div className="flex items-center gap-2 text-base font-semibold">{title}{help && <Help text={help} />}</div>
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
 * seconds, it folds back, unless it `stay`s (a delete: the question waits for an answer rather than
 * quietly giving up); Cancel and Escape always fold it. Without `label` it is the small icon button (a bin unless `icon` says
 * otherwise), named by `title`. With `open`, the asking is held from outside (a menu item asked it): only
 * the two buttons show while it is true, and `onCancel` folds it back.
 */
export function TwoStep({ label, icon, title, note, yes, cancel = "Cancel", onYes, onAsk, onCancel, open, disabled, busy, tone, stay = tone === "danger", className }: {
  /** What the button says before it asks; left out, a small icon button. */
  label?: ReactNode;
  /** "danger" for what erases for good (emptying the bin, forgetting every render time): it looks it before it asks. */
  tone?: "danger";
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
  /** The question stays until it is answered (deletes, and what erases for good): no folding back by itself. */
  stay?: boolean;
  /** Held from outside: asking while true. */
  open?: boolean;
  onCancel?(): void;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
}) {
  const [own, setOwn] = useState(false);
  const asking = open ?? own;
  const setAsking = (on: boolean) => (open === undefined ? setOwn(on) : !on && onCancel?.());
  useEffect(() => {
    if (!asking || stay) return;
    const back = setTimeout(() => setAsking(false), 6000);
    return () => clearTimeout(back);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asking, stay]);
  if (asking) {
    return (
      // Escape is Cancel: it folds the question back, and goes no further (the menu or dialog around it stays open)
      <span
        className="flex flex-wrap items-center gap-1.5"
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          setAsking(false);
        }}
      >
        {note && <span className="text-xs text-ink-2">{note}</span>}
        {/* the focus on Cancel: an Enter pressed twice by habit does not go ahead */}
        <Button size="sm" tone="danger" disabled={busy} onClick={() => { setAsking(false); onYes(); }}>{yes}</Button>
        <Button size="sm" tone="quiet" autoFocus onClick={() => setAsking(false)}>{cancel}</Button>
      </span>
    );
  }
  if (open !== undefined) return null;
  const ask = () => {
    onAsk?.();
    setAsking(true);
  };
  if (label === undefined) {
    return (
      <button type="button" aria-label={title} data-tip={title} disabled={disabled} onClick={ask} className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40", className)}>
        {icon ?? <Trash2 size={14} />}
      </button>
    );
  }
  return (
    <Button size="sm" tone={tone} data-tip={title} disabled={disabled} onClick={ask} className={className}>
      {icon}
      {label}
    </Button>
  );
}
