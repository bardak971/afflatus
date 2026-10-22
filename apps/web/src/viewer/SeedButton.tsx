import { Check, Copy } from "lucide-react";
import { cx } from "../ui";
import { useCopied } from "../hooks";

/** The seed a render went out with, as a small button that copies it: "Copied" for a moment once it is on the clipboard. */
export function SeedButton({ seed, className }: { seed: number; className?: string }) {
  const { copied, copy: copyIt } = useCopied();
  const copy = () => copyIt(String(seed));
  return (
    <button
      type="button"
      onClick={copy}
      data-tip="Copy the seed"
      aria-label={`Copy the seed ${seed}`}
      className={cx("inline-flex max-w-full cursor-copy items-center gap-1 rounded-md border border-line-strong bg-raised px-1.5 font-mono text-meta leading-[18px] text-ink hover:bg-hover", className)}
    >
      {/* both laid in one cell: the button keeps its width while it says "Copied" */}
      <span className="grid">
        <span className={cx("col-start-1 row-start-1", copied && "invisible")}>{seed}</span>
        <span aria-live="polite" className={cx("col-start-1 row-start-1 font-sans", !copied && "invisible")}>{copied ? "Copied" : ""}</span>
      </span>
      {copied ? <Check size={11} aria-hidden className="shrink-0 text-accent" /> : <Copy size={11} aria-hidden className="shrink-0 text-ink-3" />}
    </button>
  );
}
