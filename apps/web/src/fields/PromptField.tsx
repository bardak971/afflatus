import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { InputSpec } from "@afflatus/core";
import { api, type TagIssue } from "../api";
import { useSettings } from "../data";
import { Popover } from "../Popover";
import { nudgeWeight, replaceTag } from "../promptText";
import { AutoText, cx, Help } from "../ui";
import { field, Label } from "./Label";
import { useLoraWords } from "./Loras";
import { useSnippetKeys } from "../bar/SnippetKeys";
import { useKeysHere } from "../keys/here";
import { plural } from "../format";

/**
 * Under a prompt written in tags: one short line when some of its tags are not danbooru tags (what anime
 * models learned). It opens a list: another name of a tag and a typo are put right with a click, the
 * rest are only named. Looked at a moment after the typing stops; nothing when every tag is known.
 */
function TagCheck({ text, ignore, onChange }: { text: string; ignore: string[]; onChange(text: string): void }) {
  const [issues, setIssues] = useState<TagIssue[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const ignoreKey = ignore.join("|");
  useEffect(() => {
    if (!text.trim()) {
      setFailed(null);
      return setIssues([]);
    }
    let alive = true;
    const wait = setTimeout(() => {
      api.checkTags(text, ignoreKey ? ignoreKey.split("|") : []).then(
        (r) => { if (alive) { setIssues(r.issues); setFailed(null); } },
        (err: Error) => alive && setFailed(err.message),
      );
    }, 700);
    return () => {
      alive = false;
      clearTimeout(wait);
    };
  }, [text, ignoreKey]);
  if (failed) return <span className="text-xs text-ink-3">The tags could not be checked: {failed}</span>;
  if (!issues.length) return null;
  const fixable = issues.filter((i) => i.suggestion);
  const plain = issues.filter((i) => !i.suggestion);
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-tip="Anime models learned danbooru's tags: another word does little, a typo nothing"
        className="flex items-center gap-1 self-start rounded-md text-xs text-warn-ink hover:underline"
      >
        {plural(issues.length, "tag")} {issues.length > 1 ? "are" : "is"} not on danbooru's list{fixable.length ? ` · ${fixable.length} to fix` : ""}
        <ChevronDown size={12} />
      </button>
      {open && (
        <Popover anchor={button} onClose={() => setOpen(false)} label="Tags that are not danbooru tags" width={340} height={320}>
          <div className="flex flex-col gap-2 overflow-y-auto p-3">
            {fixable.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-ink-2">Written another way on danbooru</span>
                  {fixable.length > 1 && (
                    <button type="button" className="text-xs text-accent hover:underline" onClick={() => onChange(fixable.reduce((t, i) => replaceTag(t, i.tag, i.suggestion!), text))}>Fix all {fixable.length}</button>
                  )}
                </div>
                {fixable.map((i) => (
                  <button
                    key={i.tag}
                    type="button"
                    data-tip={i.status === "alias" ? `"${i.tag}" is another name of the tag "${i.suggestion}"` : `Did you mean "${i.suggestion}"?`}
                    onClick={() => onChange(replaceTag(text, i.tag, i.suggestion!))}
                    className="flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-hover"
                  >
                    <span className="min-w-0 truncate text-ink-2 line-through">{i.tag}</span>
                    <span className="shrink-0 text-ink-3">→</span>
                    <span className="min-w-0 grow truncate font-semibold">{i.suggestion}</span>
                    <span className="shrink-0 text-xs text-accent">{i.status === "alias" ? "Use it" : "Fix"}</span>
                  </button>
                ))}
              </div>
            )}
            {plain.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-ink-2">Not danbooru tags: the model may mostly ignore them</span>
                <div className="flex flex-wrap gap-1">
                  {plain.map((i) => <span key={i.tag} className="rounded bg-raised px-1.5 py-0.5 text-xs text-ink-2">{i.tag}</span>)}
                </div>
              </div>
            )}
            <span className="text-xs text-ink-3">A LoRA's trigger words and plain sentences are left alone. The check can be turned off in Settings.</span>
          </div>
        </Popover>
      )}
    </>
  );
}

/**
 * A text box of a prompt. Ctrl + ↑ / ↓ changes the weight of the tag the cursor is in, or of what is
 * selected: (red dress:1.1). In a prompt of sentences only a selection is weighed.
 */
export function PromptField({ spec, id, value, values, onChange, bare }: { spec: Extract<InputSpec, { type: "prompt" }>; id: string; value: string; values?: Record<string, unknown>; onChange(value: string): void; bare?: boolean }) {
  // the keys sheet's "Here now": a prompt box is on screen (its weights, snippets, wildcards)
  useKeysHere("form");
  const settings = useSettings();
  const checked = spec.style === "tags" && !spec.optional && Boolean(settings.data?.tagCheck);
  const ignore = useLoraWords(checked ? values : undefined);
  const weighs = spec.weights !== false;
  // `;name` puts a snippet of the Prompt kit in (Settings › Command bar)
  const snippetKeys = useSnippetKeys({ value, onChange });
  // the keys it takes, in its ? rather than over the text on every hover
  const keys = `${weighs ? `Ctrl + ↑ or ↓: the weight of ${spec.style === "tags" ? "the tag the cursor is in, or of " : ""}what is selected. ` : ""}{a|b|c}: one is picked for each result.`;
  return (
    <div className="flex flex-col gap-1.5">
      {/* bare: the head over it already names it (the Create panel's Prompt row) */}
      {bare ? <label htmlFor={id} className="sr-only">{spec.label}</label> : <Label htmlFor={id} note={[spec.note, keys].filter(Boolean).join(" ")}>{spec.label}</Label>}
      <div data-snippet-box className="relative flex flex-col">
      <AutoText
        id={id}
        rows={spec.optional && !spec.example ? 2 : 4}
        value={value}
        placeholder={spec.placeholder}
        onChange={(e) => onChange(e.target.value)}
        onSelect={snippetKeys.onSelect}
        onKeyDown={(e) => {
          if (snippetKeys.onKeyDown(e)) return;
          if (!weighs || !(e.ctrlKey || e.metaKey) || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          const el = e.currentTarget;
          const next = nudgeWeight(el.value, el.selectionStart, el.selectionEnd, e.key === "ArrowUp" ? 0.1 : -0.1, spec.style === "tags");
          if (!next) return;
          e.preventDefault();
          onChange(next.text);
          // once the new text is in the box, the tag is selected again: the next press goes on from it
          requestAnimationFrame(() => el.setSelectionRange(next.start, next.end));
        }}
        className={cx(field, "py-2.5 leading-normal", spec.optional && !spec.example ? "text-[13px]" : "text-sm")}
      />
      {snippetKeys.list}
      {/* the main prompt in its card, whose head has no ?: the keys it takes in a corner of its own, out of the way of
          the text (the other texts' rows have a ? of their own) */}
      {bare && !spec.optional && <Help title={spec.label} text={keys} className="absolute right-2 bottom-2 opacity-60 hover:opacity-100" />}
      </div>
      {checked && <TagCheck text={value} ignore={ignore} onChange={onChange} />}
    </div>
  );
}
