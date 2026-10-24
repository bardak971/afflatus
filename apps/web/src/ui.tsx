import { useEffect, useLayoutEffect, useRef, useState, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type TextareaHTMLAttributes } from "react";
import { Check, Search, Trash2, X } from "lucide-react";
import { cx } from "./cx";
import { Progress } from "./progress/Progress";
import { snapTo } from "./snap";
import { useFit } from "./useFit";
import { PANEL, useExplain, usePanelWidth } from "./store";

/** The few shapes every screen shares, so that a button looks the same wherever it is. */

export { cx };

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "plain" | "quiet" | "danger"; size?: "md" | "sm" };

/** The look of a button of the kit, for what is not a <button>: a link (wouter's Link takes it as its className), a download. */
export const buttonClass = ({ tone = "plain", size = "md", className }: { tone?: ButtonProps["tone"]; size?: ButtonProps["size"]; className?: string } = {}) =>
  cx(
    "inline-flex items-center justify-center gap-2 font-semibold whitespace-nowrap transition-[filter,background-color] disabled:cursor-not-allowed disabled:opacity-45",
    size === "md" ? "h-10 rounded-control px-4" : "h-8 rounded-lg px-3 text-xs",
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
 * The heights of a square button: dense (the track, rows), small, and the height of the form's bar; and 24, the least a
 * target may be (WCAG 2.5.8), for one inside something smaller than a row: the × of a chip, a pick in a file's line;
 * and 36, the height of the library's and the media bar's switches, for the buttons that sit in their row.
 */
export type IconSize = 24 | 28 | 32 | 36 | 40;
const ICON_BOX: Record<IconSize, string> = { 24: "size-6", 28: "size-7", 32: "size-8", 36: "size-9", 40: "size-10" };
const ICON_GLYPH: Record<IconSize, number> = { 24: 12, 28: 14, 32: 15, 36: 16, 40: 17 };

/**
 * A button that is an icon alone, in the kit's sizes and one radius. Its `label` is required: it is what a screen
 * reader says and the app's tip (`tip` when the tip says more than the name; `keys` drawn as keycaps after it).
 * `outline`: edged, for one standing on its own; `inherit`: in the colour of what it sits on (a failure's banner);
 * `primary`: filled in the accent, as Button's primary, for the one act of its place (the folded form's "+", a pick);
 * `badge`: round, in the panel's colour and edged, on the corner of a picture (a reference's remove), where a square
 * of the kit's radius would read as part of the picture;
 * `pressed`: a toggle that is on. One that is on and cannot be changed (all picked already) is not greyed: it says so.
 */
export function IconButton({ label, tip, keys, size = 32, tone = "ghost", pressed, className, children, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "aria-pressed"> & {
  label: string;
  tip?: string;
  keys?: string;
  size?: IconSize;
  tone?: "ghost" | "outline" | "inherit" | "primary" | "badge";
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      {...rest}
      aria-label={label}
      aria-pressed={pressed}
      data-tip={tip ?? label}
      data-tip-keys={keys}
      className={cx(
        "inline-flex shrink-0 items-center justify-center transition-[color,background-color,filter,opacity] disabled:cursor-not-allowed",
        ICON_BOX[size],
        tone === "badge" ? "rounded-full border border-line" : "rounded-control",
        tone === "outline" && "border border-line-strong",
        !pressed && "disabled:opacity-40",
        pressed
          ? "bg-accent-wash text-accent"
          : tone === "primary"
            ? "bg-accent text-accent-ink hover:brightness-110 disabled:hover:brightness-100"
            : tone === "badge"
              ? "bg-panel text-ink-2 hover:text-ink"
              : tone === "inherit"
                ? "hover:bg-hover disabled:hover:bg-transparent"
                : "text-ink-2 hover:bg-hover hover:text-ink disabled:hover:bg-transparent disabled:hover:text-ink-2",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** The one close of the app: an × that says what it closes in its tip (Esc drawn after it where Esc does the same). */
export function CloseButton({ onClose, label = "Close", size = 32, ...rest }: Omit<Parameters<typeof IconButton>[0], "label" | "children" | "onClick"> & { onClose(): void; label?: string }) {
  return (
    <IconButton {...rest} label={label} size={size} onClick={onClose}>
      <X size={ICON_GLYPH[size]} />
    </IconButton>
  );
}

/**
 * The one search box of the app, its focus marked on the box it sits in (the field inside draws none: styles.css).
 * `box`: a field of the kit's small height (`size` 36 beside the library's and the media bar's 36 px switches);
 * `head`: the search line heading a panel or a popover (drafts, load a model), edge to edge with a line under it, its
 * focus an accent underline; its height and padding are the panel's (className).
 * `onClear`: an × after the text while there is some, that empties it and gives the focus back to the field.
 * `end`: what follows the text (a keycap). `inputClassName`: the text's size, in place of the body size.
 * `wrapperProps`: what the box itself takes beyond its classes (a place worked out on the fly, in `style`).
 */
export function SearchField({ value, onChange, onClear, clearLabel = "Clear the search", label, placeholder, look = "box", size = 32, icon, end, className, inputClassName, inputRef, wrapperProps, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "className" | "size"> & {
  value: string;
  onChange(value: string): void;
  onClear?(): void;
  clearLabel?: string;
  label: string;
  look?: "box" | "head";
  size?: 32 | 36;
  icon?: ReactNode;
  end?: ReactNode;
  className?: string;
  inputClassName?: string;
  inputRef?: Ref<HTMLInputElement>;
  wrapperProps?: Omit<HTMLAttributes<HTMLLabelElement>, "className" | "children">;
}) {
  const own = useRef<HTMLInputElement | null>(null);
  // the caller's ref and the field's own (the × gives the focus back): both are handed the element
  const bind = (el: HTMLInputElement | null) => {
    own.current = el;
    if (typeof inputRef === "function") inputRef(el);
    else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = el;
  };
  return (
    <label
      {...wrapperProps}
      className={cx(
        "flex min-w-0 items-center text-ink",
        look === "box"
          ? cx(size === 36 ? "h-9" : "h-8", "gap-2 rounded-control border border-line bg-raised px-2.5 focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--color-accent-wash)]", onClear && value && "pr-1")
          : "shrink-0 border-b border-line focus-within:shadow-[inset_0_-2px_0_var(--color-accent)]",
        className,
      )}
    >
      {icon ?? <Search size={14} className="shrink-0 text-ink-3" />}
      <input
        ref={bind}
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        placeholder={placeholder ?? label}
        className={cx("min-w-0 grow bg-transparent outline-none placeholder:text-ink-3", inputClassName ?? "text-body")}
      />
      {onClear && value && (
        <CloseButton
          size={24}
          label={clearLabel}
          // pressed with the pointer, the × would take the focus from the field first: a box that folds away on blur
          // (the library's, the media bar's) would be gone before the click
          onMouseDown={(e) => e.preventDefault()}
          onClose={() => {
            onClear();
            own.current?.focus();
          }}
        />
      )}
      {end}
    </label>
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
  // no spell check: what is written here is prompts (danbooru tags, model words, in English whatever the browser's
  // language), which a spell checker underlines in red as if each were a mistake. A box can ask for it back.
  return <textarea ref={ref} rows={rows} value={value} spellCheck={false} {...rest} className={cx("resize-none overflow-hidden", className)} />;
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
  // Escape gives up what was typed and leaves the box (its blur then commits nothing): kept in it, the editor's own Escape
  // never came (a box being typed in keeps it), and the recording's or the source's panel could not be closed (card #75)
  const dropped = useRef(false);
  const decimals = (String(step).split(".")[1] ?? "").length;
  const commit = () => {
    if (dropped.current) {
      dropped.current = false;
      return;
    }
    if (text === null) return;
    const typed = Number(text.replace(",", ".").trim());
    setText(null);
    if (!Number.isFinite(typed) || text.trim() === "") return;
    const snapped = snapTo(typed, min, max, step);
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
          if (e.key === "Escape") {
            dropped.current = true;
            setText(null);
            e.currentTarget.blur();
          }
        }}
        className="h-[30px] w-[60px] rounded-lg border border-line bg-raised px-1.5 text-center text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-wash)]"
      />
      {unit && <span>{unit.trim()}</span>}
    </span>
  );
}

/** `bare`: the switch alone, where what it switches is already written beside it; the label is still what a screen reader says. */
export function Toggle({ on, onChange, label, note, bare, disabled, tip }: { on: boolean; onChange(on: boolean): void; label: string; note?: string; bare?: boolean; disabled?: boolean; tip?: string }) {
  return (
    <div className={cx("flex items-center gap-2.5", disabled && "opacity-50")}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        data-tip={tip}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={cx(
          // the colour changes at once with the click; only the knob travels
          "relative h-6 w-10 shrink-0 rounded-full transition-[box-shadow]",
          on ? "bg-accent" : "bg-line-strong",
          disabled ? "cursor-not-allowed" : "hover:shadow-[0_0_0_4px_var(--color-accent-wash)]",
        )}
      >
        {/* the knob stretches toward where it goes: its leading edge moves first, the other follows (--t-trail later) */}
        <span
          className={cx(
            "absolute top-[3px] h-[18px] rounded-full",
            on
              ? "right-[3px] left-[calc(100%-21px)] bg-knob motion-safe:[transition:right_var(--t-travel)_var(--ease-snap),left_var(--t-travel)_var(--ease-snap)_var(--t-trail)]"
              : "right-[calc(100%-21px)] left-[3px] bg-ink motion-safe:[transition:left_var(--t-travel)_var(--ease-snap),right_var(--t-travel)_var(--ease-snap)_var(--t-trail)]",
          )}
        />
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
export function Help({ text, title, className, inside }: { text: string; title?: string; className?: string; /** Within a button of its own (a row that opens): a mark that tells on hover, not a button in a button. */ inside?: boolean }) {
  const Mark = inside ? "span" : "button";
  return (
    <span className={cx("inline-flex shrink-0 items-center", className)}>
      {/* a 24 px target (WCAG 2.5.8) around the 16 px mark, its margins taken back so the row around it keeps its height.
          Neutral at rest: there are well over a hundred, and in the accent they read as things to do (review 4, P2) */}
      <Mark
        {...(inside ? {} : { type: "button" as const })}
        data-help=""
        aria-label={title ? `${title}: ${text}` : text}
        data-tip={text}
        data-tip-head={title}
        className="group/help -m-1 flex size-6 items-center justify-center rounded-full"
      >
        <span aria-hidden className="flex size-4 items-center justify-center rounded-full bg-raised text-micro leading-none font-bold text-ink-3 group-hover/help:bg-accent-wash group-hover/help:text-accent group-focus-visible/help:bg-accent-wash group-focus-visible/help:text-accent">?</span>
      </Mark>
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

/** Where the lit pill of a Segmented (or of the form's strip) sits, in its box's own pixels. */
export interface PillBox {
  left: number;
  right: number;
  top: number;
  height: number;
}

/**
 * The box of the option on (null when none is), read from the page so that any labels and any wrapping work. `which`:
 * how the option on is found, when it is not a checked radio (the form's strip marks its part with data-on).
 */
export function pillBox(group: HTMLElement, which: string = ':scope > [role="radio"][aria-checked="true"]'): PillBox | null {
  const on = group.querySelector<HTMLElement>(which);
  if (!on) return null;
  return { left: on.offsetLeft, right: group.clientWidth - on.offsetLeft - on.offsetWidth, top: on.offsetTop, height: on.offsetHeight };
}

export const sameBox = (a: PillBox | null, b: PillBox | null) => a === b || (a !== null && b !== null && a.left === b.left && a.right === b.right && a.top === b.top && a.height === b.height);

/**
 * Puts the pill on `to`. `travel`: a new choice, which stretches there (the edge on the side it goes leads, the other one
 * follows --t-trail later); anything else (a resize, a label turning bold) puts it there at once.
 */
export function placePill(pill: HTMLElement, from: PillBox | null, to: PillBox | null, travel: boolean) {
  if (!to) {
    pill.style.opacity = "0";
    return;
  }
  const toRight = from !== null && to.left > from.left;
  pill.toggleAttribute("data-travel", travel && from !== null);
  pill.style.setProperty("--edge-l", toRight ? "var(--t-trail)" : "0ms");
  pill.style.setProperty("--edge-r", toRight ? "0ms" : "var(--t-trail)");
  Object.assign(pill.style, { opacity: "1", left: `${to.left}px`, right: `${to.right}px`, top: `${to.top}px`, height: `${to.height}px` });
}

/**
 * A row of choices where one is on: a pill holding them, the one on lit. `sm`: smaller, for a dense bar (time windows).
 * `mono`: choices that are figures (1H, 24H). The lit pill is one box behind the options that stretches from the old
 * choice to the new one; the value itself changes on the click.
 */
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
  const group = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const at = useRef<PillBox | null>(null);
  // until the pill is placed (before the first paint), the option on is lit by its own background: nothing flashes
  const [placed, setPlaced] = useState(false);
  useLayoutEffect(() => {
    if (!group.current || !pill.current) return;
    const to = pillBox(group.current);
    placePill(pill.current, at.current, to, true);
    at.current = to;
    setPlaced(true);
  }, [value]);
  // the options change size (the room, the labels, a font loading): the pill follows at once, without travel; a box
  // that has not moved (the one just measured for a new choice) is left alone, so its stretch is not cut short
  const keys = options.map((o) => o.value).join("\u0000");
  useLayoutEffect(() => {
    const g = group.current;
    if (!g) return;
    const watch = new ResizeObserver(() => {
      const to = pillBox(g);
      if (!pill.current || sameBox(to, at.current)) return;
      placePill(pill.current, at.current, to, false);
      at.current = to;
    });
    watch.observe(g);
    for (const b of g.querySelectorAll(':scope > [role="radio"]')) watch.observe(b);
    return () => watch.disconnect();
  }, [keys]);
  return (
    // the chips wrap onto another line rather than run past the edge of a narrow panel (seven shapes do)
    <div ref={group} role="radiogroup" aria-label={label} className={cx("relative flex gap-0.5 rounded-xl bg-raised p-[3px]", oneLine ? "shrink-0 flex-nowrap" : "max-w-full flex-wrap", className)}>
      <span
        ref={pill}
        aria-hidden
        // design: the pill's radius is the group's 12 less its 3 px inset, so the two curves run side by side
        className="pointer-events-none absolute rounded-[9px] bg-line-strong motion-safe:data-[travel]:[transition:left_var(--t-travel)_var(--ease-snap)_var(--edge-l),right_var(--t-travel)_var(--ease-snap)_var(--edge-r),top_var(--t-travel)_var(--ease-snap)]"
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          data-tip={o.tip}
          onClick={() => onChange(o.value)}
          className={cx(
            // design: over the pill, at its radius (the group's 12 less its 3 px inset)
            "relative grow rounded-[9px] whitespace-nowrap transition-colors",
            size === "md" ? "h-[30px] px-3 text-body" : "h-[26px] px-2.5 text-xs",
            mono && "font-mono",
            o.value === value ? cx("font-bold text-ink", !placed && "bg-line-strong") : "font-semibold text-ink-2 hover:bg-hover hover:text-ink",
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
  "rounded-control border border-line bg-raised px-3 text-ink outline-none placeholder:text-ink-3 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-wash)] aria-[invalid=true]:border-warn";

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
          "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md transition-colors",
          // unticked, the edge is all there is of the box: it takes the theme's control edge (styles.css), which a light
          // theme draws darker than its quiet lines
          on ? "bg-accent text-accent-ink" : "border-[1.5px] border-(--control-edge) group-hover/check:border-ink-2",
        )}
      >
        {checked === true && <Check size={12} strokeWidth={3.5} />}
        {checked === "some" && <span className="h-[2.5px] w-2 rounded-full bg-accent-ink" />}
      </span>
      {children}
    </button>
  );
}

/** The words of what is only words ("Only ", a name), for a tip; undefined when it holds anything else (an icon). */
function plainText(node: ReactNode): string | undefined {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node) && node.every((n) => typeof n === "string" || typeof n === "number")) return node.join("");
  return undefined;
}

/**
 * A status chip: what something is (to render, unused, exported), or where it is (a folder), then clickable.
 * `truncate`: a chip that may be narrower than its words (a model's name, a cast): they end in "…" at the width it is
 * given (a max-w in className, or its column's), and the whole of them is its tip.
 * `onRemove`: a filter that can be taken off (Only …, By …): a 24 px × after the words, in the chip's colour.
 */
export function Chip({ tone = "neutral", size = "sm", truncate, children, onClick, onRemove, removeLabel = "Remove", tip, className }: {
  /**
   * warn: failed or broken; attention: needs a look (a stale join, a clip before that changed); neutral: to do, not
   * ready; solid: the one mark of its place filled in the accent (here, picked, main, a count on a button).
   */
  tone?: "neutral" | "warn" | "attention" | "good" | "accent" | "solid" | "link";
  /** xs: 18 px, for a chip on a picture or in a dense row. */
  size?: "sm" | "xs";
  truncate?: boolean;
  children: ReactNode;
  onClick?(): void;
  onRemove?(): void;
  /** What the × says it does ("Show every job's lines again"). */
  removeLabel?: string;
  tip?: string;
  className?: string;
}) {
  const look = cx(
    "inline-flex items-center rounded-full whitespace-nowrap",
    truncate ? "min-w-0 max-w-full" : "shrink-0",
    tone === "solid" ? "font-bold" : "font-semibold",
    size === "xs" ? cx("h-4.5 gap-1 text-micro", onRemove ? "pr-0 pl-1.5" : "px-1.5") : cx("h-6 text-xs", onRemove ? "gap-1 pr-0 pl-2.5" : "gap-1.5 px-2.5"),
    tone === "neutral" && "bg-hover text-ink-2",
    tone === "warn" && "bg-warn-wash text-warn-ink",
    tone === "attention" && "bg-attention-wash text-attention-ink",
    tone === "good" && "bg-good/15 text-good",
    tone === "accent" && "bg-accent-wash text-accent",
    tone === "solid" && "bg-accent text-accent-ink",
    tone === "link" && "border border-line-strong text-ink",
    onClick && !onRemove && "hover:brightness-125",
    className,
  );
  const said = tip ?? (truncate ? plainText(children) : undefined);
  const words = truncate ? <span className="min-w-0 truncate">{children}</span> : children;
  if (onRemove) {
    return (
      <span data-tip={onClick ? undefined : said} className={look}>
        {onClick ? <button type="button" data-tip={said} onClick={onClick} className="flex min-w-0 items-center gap-1.5 hover:underline">{words}</button> : words}
        {/* 24 px on an 18 px chip too: it stands out of the chip's height rather than be a smaller target */}
        <CloseButton size={24} tone="inherit" label={removeLabel} onClose={onRemove} className={size === "xs" ? "-my-0.75" : undefined} />
      </span>
    );
  }
  return onClick ? <button type="button" data-tip={said} onClick={onClick} className={look}>{words}</button> : <span data-tip={said} className={look}>{words}</span>;
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

/**
 * A heading inside a page or a panel, in two levels: a section (small capitals, quiet: MODEL, NEEDS A LOOK · 3) and a
 * group within it (sentence case, a step stronger than the text: After sampling). Two looks only, so that the levels read.
 */
export function SectionTitle({ level = "section", className, children }: { level?: "section" | "group"; className?: string; children: ReactNode }) {
  return <div className={cx(level === "section" ? "text-meta font-semibold tracking-label text-ink-3 uppercase" : "text-body font-semibold text-ink-2", className)}>{children}</div>;
}

/**
 * The head of a page (Queue, Settings, Prompt kit, Workflows): its title, then what switches its views (the page's
 * Segmented), then its actions on the right, at one height, so that the title and the views are where the eye left them
 * on the page before. Its side room is the pages' own (px-8), so the title stands over what the page lists.
 *
 * In a narrow window the actions fold before the views do: `actions` given as a function is drawn at a fold level, from
 * 0 (all of it) to `folds` (the most compact), one step more each time the header runs out of room (useFit), and the
 * page decides what each step gives up (a status in fewer words, a switch without its label, a search for its icon, a
 * button's words for an icon and its tip). `after` may fold too, but only what rides on the views (a figure in a tab),
 * never a tab. `titleYields`: at the last step the title is read by screen readers only (Settings, whose nine tabs
 * and the sidebar already say where one is). Only past the last step do the views scroll sideways, so no tab is hidden
 * while room can still be made. `foldKey`: what the actions hold changed (another view), so fold again from nothing.
 * The header does not clip (a search's list of finds hangs below it): it stays on one line, and its width is the page's.
 * Its room is measured inside the side padding: a row that ran into the padding read as fitting (Prompt kit's New button
 * against the window's edge at 1024 px).
 */
export function PageHeader({ title, after, actions, folds = 0, foldKey, titleYields, className }: {
  title: ReactNode;
  after?: ReactNode | ((fold: number) => ReactNode);
  actions?: ReactNode | ((fold: number) => ReactNode);
  folds?: number;
  foldKey?: string;
  titleYields?: boolean;
  className?: string;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const fold = useFit(bar, folds, foldKey);
  const views = typeof after === "function" ? after(fold) : after;
  return (
    <header className={cx("relative flex h-14 shrink-0 border-b border-line px-8", className)}>
      <div ref={bar} className="flex min-w-0 grow flex-nowrap items-center gap-3.5">
        <h1 className={cx("m-0 shrink-0 text-page font-bold", titleYields && folds > 0 && fold >= folds && "sr-only")}>{title}</h1>
        {/* the views keep their width while a fold is left to take; past the last one they scroll rather than push the
            actions out of the header */}
        {views && folds > 0 ? <div className={cx("flex min-w-0 items-center overflow-x-auto [scrollbar-width:none]", fold < folds ? "shrink-0" : "shrink")}>{views}</div> : views}
        <span className="grow" />
        {actions && <div className="flex shrink-0 items-center gap-2">{typeof actions === "function" ? actions(fold) : actions}</div>}
      </div>
    </header>
  );
}

/**
 * What a page's view holds, said in its segment after its name ("Snippets 5", "Storage 237 MB"): muted and in figures,
 * so the name stays what is read first. A dash while it is not known, never a "0" that reads as none.
 */
export function SegmentCount({ children }: { children: ReactNode }) {
  return <span className="font-mono text-micro font-normal text-ink-3 tabular-nums">{children ?? "–"}</span>;
}

/** A job at work behind a page's view (the Queue's segment while one renders): a small dot in the done colour, before its name. */
export function LiveDot({ label }: { label: string }) {
  return <span role="img" aria-label={label} className="inline-block size-1.5 shrink-0 rounded-full bg-good" />;
}

/**
 * The one spinner of the app: a ring with a lit quarter. Under "reduce motion" it stands still, the ring still saying that
 * something works. `current`: in the colour of the text around it rather than the accent.
 */
export function Spinner({ size = 12, tone = "accent", className }: { size?: number; tone?: "accent" | "current"; className?: string }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cx(
        "inline-block shrink-0 animate-spin rounded-full border-2 motion-reduce:animate-none",
        tone === "accent" ? "border-accent/30 border-t-accent" : "border-current/30 border-t-current",
        className,
      )}
    />
  );
}

/**
 * The app's progress bar (0–100), in the progress style this browser chose (progress/Progress.tsx). `steps`: the render's
 * step count, for the ticks of Steps; `loading`: a render with no figure yet (the model loading); `meter`: a gauge, not a
 * progress (a GPU's load), which never glides nor ticks.
 */
export function Bar({ value, tone = "accent", steps, loading, meter }: { value: number; tone?: "accent" | "picture" | "warn"; steps?: number; loading?: boolean; meter?: boolean }) {
  const color = tone === "accent" ? "bg-accent" : tone === "warn" ? "bg-warn" : "bg-picture";
  return <Progress value={value / 100} tone={color} steps={steps} loading={loading} meter={meter} className="h-1.5" />;
}

/** Shown where a list has nothing in it yet: says what will appear and how to get it there. `help`: the why and the how, behind a "?" beside the title. */
export function Empty({ title, help, helpTitle, action, children }: {
  title: string;
  help?: string;
  /** The ? tip's head, when it is about something else than the title says ("Snippets" for "No snippets yet"). */
  helpTitle?: string;
  /** The way to fill it, under what it says: a button, a drop hint with its keys. */
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-line-strong px-8 py-14 text-center">
      <div className="flex items-center gap-1.5 text-base font-semibold">{title}{help && <Help text={help} title={helpTitle} />}</div>
      {children && <div className="max-w-md text-ink-2">{children}</div>}
      {action && <div className="mt-2 flex flex-wrap items-center justify-center gap-2 text-ink-2">{action}</div>}
    </div>
  );
}

/** What went wrong, in a box: red. `attention`: what wants a look but is not broken (a ComfyUI not answering), amber. */
export function ErrorNote({ children, tone = "warn" }: { children: ReactNode; tone?: "warn" | "attention" }) {
  return <div role="alert" className={cx("rounded-lg px-3 py-2", tone === "attention" ? "bg-attention-wash text-attention-ink" : "bg-warn-wash text-warn-ink")}>{children}</div>;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setAsking is new at every render; the wait starts when asking does
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
