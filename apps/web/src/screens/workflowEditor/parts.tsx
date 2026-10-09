import type { ReactNode } from "react";
import { AlertTriangle, Check, Minus } from "lucide-react";
import type { Control, Target } from "@afflatus/workflows";
import { fileLabel } from "../../format";
import { cx, Help, Note } from "../../ui";

export const keyOf = (t: Target | undefined) => (t ? `${t.node}.${t.input}` : "");
export const link = "font-semibold text-accent underline underline-offset-2 hover:text-ink";
/** Where to look for a model file by its name, when the workflow does not say where it comes from. */
export const searchLinks = (file: string) => [
  { label: "Civitai", url: `https://civitai.com/search/models?query=${encodeURIComponent(fileLabel(file))}` },
  { label: "Hugging Face", url: `https://huggingface.co/models?search=${encodeURIComponent(fileLabel(file))}` },
];
export const text = "h-10 w-full rounded-lg border border-line bg-raised px-3";

/**
 * One thing Afflatus looked for, as a row of step 1's card: a mark that says whether it has it (found; not found
 * but fine; not found and the form is poorer for it), its name, then the way to change it (`children`) or a short
 * state (`what`) with its background behind a "?". `below` is what takes more than one line (a list of loaders).
 */
export function Found({ ok, role, tag, note, matters, what, children, below }: {
  ok: boolean;
  role: string;
  /** A word after the name: optional, required. */
  tag?: string;
  /** What was found (ok), or what to do (not ok), in a few words. */
  what?: string;
  /** Background, behind a "?". */
  note?: string;
  /** Not found and it shows: the form will lack it. */
  matters?: boolean;
  children?: ReactNode;
  below?: ReactNode;
}) {
  const tone = ok ? "good" : matters ? "warn" : "plain";
  return (
    <div data-dash={ok ? undefined : ""} className="grid scroll-mt-3 grid-cols-[18px_120px_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 px-3 py-2 text-[13px] [&+&]:border-t [&+&]:border-line">
      <span className={cx("flex h-[18px] w-[18px] items-center justify-center rounded-full", tone === "good" ? "bg-good/20 text-good" : tone === "warn" ? "bg-warn-wash text-warn-ink" : "bg-hover text-ink-3")}>
        {tone === "good" ? <Check size={11} strokeWidth={3} /> : tone === "warn" ? <AlertTriangle size={10} strokeWidth={2.6} /> : <Minus size={11} strokeWidth={3} />}
      </span>
      <span className="min-w-0 truncate font-semibold">{role}{tag && <span className="pl-1.5 text-xs font-normal text-ink-3" data-tip={tag === "opt." ? "optional" : tag === "req." ? "required" : undefined}>{tag}</span>}</span>
      <div className="flex min-w-0 items-center gap-1.5">
        {(children || what) && (
          <div className={cx("flex min-w-0 flex-col gap-1", children ? "grow" : "")}>
            {children}
            {what && <span className={cx("min-w-0 truncate text-xs", tone === "warn" ? "text-warn-ink" : ok ? "text-ink-2" : "text-ink-3")} data-tip={what}>{what}</span>}
          </div>
        )}
        <Note text={note} />
      </div>
      {below && <div className="col-span-2 col-start-2 flex min-w-0 flex-col gap-1.5 text-xs">{below}</div>}
    </div>
  );
}

/** A step of the screen: its number and name, with what to do in it behind a "?". */
export function Step({ n, title, hint }: { n: number; title: string; hint: string }) {
  return (
    <div className="flex items-center gap-2 pb-1">
      <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-ink text-xs font-extrabold text-ground">{n}</span>
      <span className="text-[15px] font-bold">{title}</span>
      <Help title={title} text={hint} />
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
