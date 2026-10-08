import { useState } from "react";
import { Check, RefreshCw, RotateCcw, TriangleAlert, Undo2 } from "lucide-react";
import { changedShare, wordDiff } from "../diff";
import { Button, cx } from "../ui";
import type { DesignerTurn } from "../Designer";

/** A proposed text with what changed against what was there: new words marked, words taken out struck. */
function Changed({ was, now }: { was: string; now: string }) {
  const pieces = was.trim() ? wordDiff(was, now) : null;
  // a text rewritten from end to end, or too long to compare, is read better plain
  const marked = pieces && changedShare(pieces) < 0.85 && pieces.some((p) => p.kind !== "same");
  const [plain, setPlain] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <div className="rounded-lg bg-raised px-2.5 py-2 leading-normal break-words whitespace-pre-wrap">
        {marked && !plain
          ? pieces.map((p, k) => (p.kind === "same" ? <span key={k}>{p.text}</span> : p.kind === "added" ? <mark key={k} className="rounded-sm bg-accent-wash px-0.5 text-ink-strong">{p.text}</mark> : <del key={k} className="text-ink-3">{p.text}</del>))
          : now}
      </div>
      {marked && (
        <button type="button" className="self-start text-[11px] text-ink-2 underline hover:text-ink" onClick={() => setPlain(!plain)}>
          {plain ? "Show diff" : "Show plain text"}
        </button>
      )}
    </div>
  );
}

/** One thing the designer said: an answer, a question, or a proposal with what can be done with it. */
export function Reply({ turn: t, last, busy, label, onUse, onUndo, onAnother, onAgain, onOption }: {
  turn: DesignerTurn;
  last: boolean;
  busy: boolean;
  label(id: string): string;
  onUse(): void;
  onUndo(): void;
  onAnother(): void;
  onAgain(): void;
  onOption(words: string): void;
}) {
  const r = t.reply;
  const [raw, setRaw] = useState(false);
  const changes = Object.entries(r?.changes ?? {});
  const short = Object.entries(r?.short ?? {});
  return (
    <div className={cx("flex flex-col gap-2 rounded-xl border p-3", r?.empty ? "border-warn/60" : "border-line")}>
      {r?.kind === "question" ? <span className="font-semibold">{r.question}</span> : null}
      {t.content && <span className={cx("whitespace-pre-wrap", r?.kind === "question" && "text-ink-2")}>{t.content}</span>}
      {r?.empty && (
        <div className="flex gap-2 rounded-lg bg-warn-wash px-2.5 py-2 text-xs text-warn-ink">
          <TriangleAlert size={14} className="mt-px shrink-0" />
          <span>
            <span className="font-semibold">It sent no text, twice.</span> Nothing was changed, whatever it says above. The LLM may be refusing what you asked: try another system prompt or another LLM (at the top of this panel), or say it another way.
          </span>
        </div>
      )}
      {changes.map(([id, value]) => (
        <div key={id} className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-ink-2">{label(id)}</span>
          <Changed was={t.was?.[id] ?? ""} now={value} />
        </div>
      ))}
      {short.length > 0 && (
        <div className="flex gap-2 rounded-lg bg-warn-wash px-2.5 py-2 text-xs text-warn-ink">
          <TriangleAlert size={14} className="mt-px shrink-0" />
          <span>
            <span className="font-semibold">Much shorter than what you have</span> ({short.map(([id, n]) => `${label(id)}: ${n.now} characters in place of ${n.was}`).join("; ")}). It may be only the line that changed: applying it replaces the whole prompt.
          </span>
        </div>
      )}
      {r?.repeats && (
        <div className="flex gap-2 rounded-lg bg-warn-wash px-2.5 py-2 text-xs text-warn-ink">
          <TriangleAlert size={14} className="mt-px shrink-0" />
          <span>
            <span className="font-semibold">This is the previous clip, written again.</span> A clip that extends it should say what happens next. Tell it what comes next in a few words ("she sits down and laughs"), or ask again.
          </span>
        </div>
      )}
      {r?.checks && r.checks.length > 0 && (
        <ul className="flex flex-col gap-0.5 rounded-lg bg-warn-wash px-2.5 py-2 text-xs text-warn-ink" aria-label="Against the model's rules">
          {r.checks.map((c, i) => <li key={i} className="flex gap-1.5"><TriangleAlert size={12} className="mt-px shrink-0" /><span>{c.text}</span></li>)}
        </ul>
      )}
      {r?.tags && (
        <span className="text-xs text-ink-2">
          {r.tags.fixed.length > 0 && <>Fixed against the danbooru tag list: {r.tags.fixed.map((f) => `${f.from} → ${f.to}`).join(", ")}. </>}
          {r.tags.unknown.length > 0 && <span className="text-warn-ink">Not danbooru tags: {r.tags.unknown.join(", ")}.</span>}
        </span>
      )}
      {(changes.length > 0 || r?.empty) && (
        <span className="flex flex-wrap items-center gap-1.5">
          {changes.length > 0 && (t.used ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-good"><Check size={13} /> Applied</span>
              {t.was && <Button size="sm" tone="quiet" title="Put back what the form held before" onClick={onUndo}><Undo2 size={13} /> Undo</Button>}
            </>
          ) : (
            <Button size="sm" tone="primary" onClick={onUse}>{short.length || r?.repeats ? "Apply anyway" : "Apply"}</Button>
          ))}
          {changes.length > 0 && last && <Button size="sm" disabled={busy} title="Ask for another version, different from this one" onClick={onAnother}><RefreshCw size={13} /> Regenerate</Button>}
          {(r?.empty || r?.repeats || short.length > 0) && last && <Button size="sm" disabled={busy} title="Ask the same thing again, as if this reply had not come" onClick={onAgain}><RotateCcw size={13} /> Retry</Button>}
          {r?.raw && <button type="button" className="text-[11px] text-ink-2 underline hover:text-ink" onClick={() => setRaw(!raw)}>{raw ? "Hide raw response" : "Raw response"}</button>}
        </span>
      )}
      {raw && r?.raw && <pre className="max-h-48 overflow-auto rounded-lg bg-raised px-2.5 py-2 font-mono text-[11px] leading-normal break-words whitespace-pre-wrap text-ink-2">{r.raw}</pre>}
      {last && r && r.options.length > 0 && (
        <span className="flex flex-wrap gap-1.5">
          {r.options.map((o) => <button key={o} type="button" disabled={busy} onClick={() => onOption(o)} className="rounded-full border border-line-strong px-2.5 py-1 text-left text-xs hover:bg-hover disabled:opacity-45">{o}</button>)}
        </span>
      )}
    </div>
  );
}
