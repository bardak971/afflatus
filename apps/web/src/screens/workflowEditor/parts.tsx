import type { ReactNode } from "react";
import { AlertTriangle, Check, Minus } from "lucide-react";
import type { Control, Target } from "@afflatus/workflows";
import { fileLabel } from "../../format";
import { cx, Note } from "../../ui";

export const keyOf = (t: Target | undefined) => (t ? `${t.node}.${t.input}` : "");
export const link = "font-semibold text-accent underline underline-offset-2 hover:text-ink";
/** Where to look for a model file by its name, when the workflow does not say where it comes from. */
export const searchLinks = (file: string) => [
  { label: "Civitai", url: `https://civitai.com/search/models?query=${encodeURIComponent(fileLabel(file))}` },
  { label: "Hugging Face", url: `https://huggingface.co/models?search=${encodeURIComponent(fileLabel(file))}` },
];
export const text = "h-10 w-full rounded-lg border border-line bg-raised px-3";

/**
 * One thing Afflatus looked for: a mark that says whether it has it (found; not found but fine; not found and
 * the form is poorer for it), its name, what was found or what to do about it, and the way to change it.
 */
export function Found({ ok, role, note, matters, what, children }: {
  ok: boolean;
  role: string;
  /** What was found (ok), or what to do (not ok): shown as a line, not behind a "?". */
  what?: string;
  /** Background, behind a "?". */
  note?: string;
  /** Not found and it shows: the form will lack it. */
  matters?: boolean;
  children?: ReactNode;
}) {
  const tone = ok ? "good" : matters ? "warn" : "plain";
  return (
    <div className={cx("flex flex-col gap-1.5 rounded-lg border px-3 py-2.5", tone === "warn" ? "border-warn/40 bg-panel" : "border-line bg-panel")}>
      <div className="flex items-center gap-2.5">
        <span className={cx("flex h-5 w-5 shrink-0 items-center justify-center rounded-full", tone === "good" ? "bg-good/20 text-good" : tone === "warn" ? "bg-warn-wash text-warn-ink" : "bg-hover text-ink-2")}>
          {tone === "good" ? <Check size={12} strokeWidth={3} /> : tone === "warn" ? <AlertTriangle size={11} strokeWidth={2.6} /> : <Minus size={12} strokeWidth={3} />}
        </span>
        <span className="font-semibold">{role}</span>
        {what && <span className={cx("min-w-0 truncate text-xs", tone === "warn" ? "text-warn-ink" : "text-ink-2")} title={what}>{what}</span>}
        <Note text={note} />
      </div>
      {children}
    </div>
  );
}

/** A short line of the verdict strip. */
export function Chip({ tone, children }: { tone: "good" | "plain" | "warn"; children: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold", tone === "good" ? "border-good/40 text-good" : tone === "warn" ? "border-warn/50 bg-warn-wash text-warn-ink" : "border-line text-ink-2")}>
      {tone === "good" ? <Check size={11} strokeWidth={3} /> : tone === "warn" ? <AlertTriangle size={11} strokeWidth={2.6} /> : <Minus size={11} strokeWidth={3} />}
      {children}
    </span>
  );
}

/** A step of the screen: its number, name and what to do in it. */
export function Step({ n, title, hint }: { n: number; title: string; hint: string }) {
  return (
    <div className="flex flex-col gap-0.5 pb-1">
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ink text-[11px] font-bold text-ground">{n}</span>
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <span className="text-xs text-ink-2">{hint}</span>
    </div>
  );
}

/** What a control lets you set, in a few words. */
export function rangeOf(c: Control): string {
  if (c.kind === "number") return `a number, ${c.min ?? 0} to ${c.max ?? 100}`;
  if (c.kind === "toggle") return "on or off";
  if (c.kind === "choice") return c.file ? "one of the model files in your ComfyUI" : "one of the choices ComfyUI offers";
  return "text";
}
