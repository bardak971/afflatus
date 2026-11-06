import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { CLIP_CHUNK, FILE_CHOICE, withQuality, type InputSpec } from "@afflatus/core";
import { api, type FamilyInfo, type TagIssue } from "../api";
import { useSettled } from "../hooks";
import { queryKeys } from "../queryKeys";
import { useSettings } from "../data";
import { Popover } from "../Popover";
import { nudgeWeight, replaceTag } from "../promptText";
import { AutoText, Chip, cx, Help } from "../ui";
import { field, Label } from "./Label";
import { useLoraWords } from "./Loras";
import { useSnippetKeys } from "../bar/SnippetKeys";
import { useKeysHere } from "../keys/here";
import { plural, verb } from "../format";
import { usePromptHistory } from "./PromptHistory";

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
        // amber: a tag to look at, nothing broken (the render goes either way); red is for what failed
        className="flex items-center gap-1 self-start rounded-md text-xs text-attention-ink hover:underline"
      >
        {plural(issues.length, "tag")} {verb(issues.length, "is", "are")} not on danbooru's list{fixable.length ? ` · ${fixable.length} to fix` : ""}
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
                  {plain.map((i) => <Chip key={i.tag}>{i.tag}</Chip>)}
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

/** The families whose prompts go through CLIP's 77-token window, cut in chunks of 75 (SDXL, Illustrious, Pony). */
const CLIP_FAMILIES = new Set(["sdxl"]);

/**
 * Under an SDXL prompt: its CLIP tokens over the chunks they fill, as A1111 says it ("92/150"), counted by the server a
 * moment after the typing stops, as ComfyUI cuts them. A guess is said as one ("≈"): ComfyUI's tokenizer file is not on
 * this computer. Its tip says each chunk's tokens: a tag cut in two by a chunk's end loses some of its sense.
 */
function TokenCount({ text }: { text: string }) {
  const asked = useSettled(text);
  const count = useQuery({ queryKey: queryKeys.promptTokens(asked), queryFn: ({ signal }) => api.promptTokens(asked, { signal }), enabled: Boolean(asked.trim()), placeholderData: keepPreviousData, staleTime: Infinity });
  if (!text.trim() || !count.data) return null;
  const { chunks, exact } = count.data;
  const total = chunks.reduce((a, b) => a + b, 0);
  const each = chunks.length > 1 ? `\n${chunks.map((n, i) => `Chunk ${i + 1}: ${n}`).join(" · ")}` : "";
  const how = exact ? "Counted with ComfyUI's own tokenizer, as its CLIPTextEncode cuts them" : "An estimate from the words: ComfyUI's tokenizer file (comfy/sd1_tokenizer) is not on this computer";
  return (
    <span
      data-tip={`CLIP reads ${CLIP_CHUNK} tokens at a time: a longer prompt is cut in chunks encoded apart, and a weighted tag is moved whole into the next chunk.${each}\n${how}.`}
      data-tip-head="CLIP tokens"
      className="font-mono text-meta text-ink-3 tabular-nums"
    >
      {exact ? "" : "≈"}{total}/{chunks.length * CLIP_CHUNK}
    </span>
  );
}

/**
 * Under a prompt that names a wildcard file no folder has: one line, said as it is written (card #318), where before only
 * Render said it, refused ("no wildcard file"). Asked a moment after the typing stops, and only of a text with a `__name__`.
 */
function WildcardCheck({ text }: { text: string }) {
  const asked = useSettled(text, 400);
  const named = FILE_CHOICE.test(asked);
  const check = useQuery({ queryKey: queryKeys.promptWildcards(asked), queryFn: ({ signal }) => api.promptWildcards(asked, { signal }), enabled: named, staleTime: 5_000 });
  const missing = named ? check.data?.missing ?? [] : [];
  if (!missing.length) return null;
  return (
    <span className="text-xs text-warn-ink" data-tip="Put the file in the wildcards folder of Afflatus's data folder, or in the Impact pack's or Dynamic Prompts' wildcard folder (Settings › Prompts)">
      No wildcard file {missing.map((n) => `${n}.txt`).join(", ")}: Render refuses it
    </span>
  );
}

/**
 * A text box of a prompt. Ctrl + ↑ / ↓ changes the weight of the tag the cursor is in, or of what is
 * selected: (red dress:1.1). In a prompt of sentences only a selection is weighed.
 */
export function PromptField({ spec, id, value, values, family, onChange, bare }: { spec: Extract<InputSpec, { type: "prompt" }>; id: string; value: string; values?: Record<string, unknown>; family?: FamilyInfo; onChange(value: string): void; bare?: boolean }) {
  // the keys sheet's "Here now": a prompt box is on screen (its weights, snippets, wildcards)
  useKeysHere("form");
  const settings = useSettings();
  const checked = spec.style === "tags" && !spec.optional && Boolean(settings.data?.tagCheck);
  const ignore = useLoraWords(checked ? values : undefined);
  const weighs = spec.weights !== false;
  // `;name` puts a snippet of the Prompt kit in (Settings › Interface › Command bar)
  const snippetKeys = useSnippetKeys({ value, onChange });
  // the prompts rendered before: the main text's (the history holds those), not a negative's nor a few words on one line
  const remembers = !spec.line && !spec.optional && spec.id !== "negative";
  const history = usePromptHistory({ value, onChange, label: spec.label });
  // one counter for what the main text is sent as, the checkpoint's quality tags in front of it (the recipe's withQuality):
  // counted alone, a Pony preset's 30 tokens and a 60-token prompt said "60/75" and filled 90, a tag cut at the chunk's end.
  // The quality tags' own row counts nothing apart: they are in the prompt's count, and in each Detail row's prompt, which
  // SDXL sends after them too (sdxl/text-to-picture.ts's Detail cond; a Pony Detail prompt read 30 tokens short)
  const counted = !spec.line && spec.id !== "quality" && Boolean(family && CLIP_FAMILIES.has(family.id));
  const qualityFirst = spec.id === "prompt" || /^detail\w+Prompt$/.test(spec.id);
  const sent = qualityFirst && typeof values?.quality === "string" ? withQuality(values.quality, value) : value;
  // the keys it takes, in its ? rather than over the text on every hover
  // a few words on one line (a swap's Track) take no weights and no choices: neither is said
  const keys = spec.line ? "" : `${weighs ? `Ctrl + ↑ or ↓: the weight of ${spec.style === "tags" ? "the tag the cursor is in, or of " : ""}what is selected. ` : ""}{a|b|c}, __name__ (a wildcard file): one is picked for each result.${remembers ? " ↑ in an empty prompt: the recent prompts." : ""}`;
  /** Icons in the box's bottom corner: the recent prompts, and the main prompt's ? of keys. */
  const corner = remembers || (bare && !spec.optional && Boolean(keys));
  return (
    <div className="flex flex-col gap-1.5">
      {/* bare: the head over it already names it (the Create panel's Prompt row) */}
      {bare ? <label htmlFor={id} className="sr-only">{spec.label}</label> : <Label htmlFor={id} note={[spec.note, keys].filter(Boolean).join(" ")}>{spec.label}</Label>}
      <div data-snippet-box className="relative flex flex-col">
      <AutoText
        id={id}
        rows={spec.line ? 1 : spec.optional && !spec.example ? 2 : 4}
        value={value}
        // a text the form cannot do without shows its example as one ("e.g. …", in italics): written out bare, it read as
        // text already there and the first render was sent empty (card #165)
        placeholder={spec.placeholder && !spec.optional ? `e.g. ${spec.placeholder}` : spec.placeholder}
        onChange={(e) => onChange(e.target.value)}
        onSelect={snippetKeys.onSelect}
        onBlur={history.close}
        onKeyDown={(e) => {
          if (snippetKeys.onKeyDown(e)) return;
          if (remembers && history.onKeyDown(e)) return;
          // a few words on one line: Enter makes no second line
          if (spec.line && e.key === "Enter") return void e.preventDefault();
          if (!weighs || !(e.ctrlKey || e.metaKey) || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          const el = e.currentTarget;
          const next = nudgeWeight(el.value, el.selectionStart, el.selectionEnd, e.key === "ArrowUp" ? 0.1 : -0.1, spec.style === "tags");
          if (!next) return;
          e.preventDefault();
          onChange(next.text);
          // once the new text is in the box, the tag is selected again: the next press goes on from it
          requestAnimationFrame(() => el.setSelectionRange(next.start, next.end));
        }}
        // the history and ? sit in the box's bottom corner: the text keeps a line's room above them, so a long prompt's last
        // line never runs under them (card #318)
        className={cx(field, "pt-2.5 leading-normal placeholder:italic", corner ? "pb-8" : "pb-2.5", spec.optional && !spec.example ? "text-body" : "text-sm")}
      />
      {snippetKeys.list}
      {remembers && history.list}
      {remembers && <span className={cx("absolute bottom-1.5", bare && keys ? "right-8" : "right-1.5")}>{history.button}</span>}
      {/* the main prompt in its card, whose head has no ?: the keys it takes in a corner of its own, out of the way of
          the text (the other texts' rows have a ? of their own) */}
      {bare && !spec.optional && keys && <Help title={spec.label} text={keys} className="absolute right-2 bottom-2 opacity-60 hover:opacity-100" />}
      </div>
      {!spec.line && <WildcardCheck text={value} />}
      {(checked || counted) && (
        <div className="flex items-start gap-2">
          {checked && <TagCheck text={value} ignore={ignore} onChange={onChange} />}
          {counted && <span className="ml-auto shrink-0"><TokenCount text={sent} /></span>}
        </div>
      )}
    </div>
  );
}
