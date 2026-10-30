import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Minus, Pencil, Plus } from "lucide-react";
import { baseGroup, baseLabel, lineOf, loraFit, modelFit, sameLora, type AddedRow, type InputSpec, type LoraValue } from "@afflatus/core";
import { api, type FamilyInfo, type ModelInfo, type ModelWords } from "../api";
import { useModelInfo, useModelWords } from "../data";
import { fileLabel } from "../format";
import { ModelLink } from "../ModelLink";
import { appendTo, removeFrom, wordsIn } from "../promptText";
import { Select, type Option } from "../Select";
import { Chip, CloseButton, cx, fieldClass, Help, NumberBox } from "../ui";
import { Slider } from "../Slider";
import { useFilePlaces } from "../filePlaces";
import { fileOption, FileSelect } from "./FileSelect";
import { Label } from "./Label";
import { queryKeys } from "../queryKeys";
import { useCopied } from "../hooks";

/** A file's name as the words kept for it are filed under: lower case, without its sub-folder. */
export const nameOf = (file: string) => (file.split(/[\\/]/).pop() ?? file).toLowerCase();

/**
 * The words that call a LoRA up, and where they are from: the user's own first, then what its author
 * wrote in the file, then what its page on Civitai gives, or else the words it was trained with most.
 */
export function wordsOf(info: ModelInfo | undefined, more?: ModelWords): { words: string; from: "own" | "file" | "page" | "training" | null } {
  if (more?.own) return { words: more.own, from: "own" };
  if (info?.trigger) return { words: info.trigger, from: "file" };
  if (more?.found) return { words: more.found, from: "page" };
  const trained = info?.tags?.slice(0, 8).join(", ") ?? "";
  return { words: trained, from: trained ? "training" : null };
}
const FROM = { own: "Your words for it", file: "Its trigger words", page: "Its trigger words, from its page on Civitai", training: "The words it was trained with most" };

/** The trigger words of the LoRAs a form has in use: words that are no danbooru tags and are right all the same. */
export function useLoraWords(values: Record<string, unknown> | undefined): string[] {
  const info = useModelInfo("loras").data?.items;
  const more = useModelWords("loras").data?.items;
  return useMemo(() => {
    const loras = Object.values(values ?? {}).filter((v): v is LoraValue[] => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof (x as LoraValue).file === "string" && typeof (x as LoraValue).weight === "number")).flat();
    return loras.map((l) => wordsOf(info?.[l.file], more?.[nameOf(l.file)])).filter((w) => w.from && w.from !== "training").map((w) => w.words);
  }, [values, info, more]);
}

/** The form's main text, for a field that puts words into it or takes them out (a LoRA's trigger words). */
export interface MainText {
  text: string;
  style: "tags" | "sentences";
  set(text: string): void;
}

/**
 * Under a LoRA's name: the model it is for and the words that call it up. "+" puts the words in the
 * prompt and "−" takes them out again; a click on them copies them; the pencil replaces them by the
 * user's own.
 */
function LoraWords({ file, info, more, main }: { file: string; info: ModelInfo | undefined; more: ModelWords | undefined; main?: MainText }) {
  const client = useQueryClient();
  const { copied, copy } = useCopied();
  const [typing, setTyping] = useState<string | null>(null);
  const { words, from } = wordsOf(info, more);
  const save = useMutation({
    mutationFn: (own: string) => api.setModelWords("loras", file, own.trim() || null),
    onSuccess: (r) => client.setQueryData<{ items: Record<string, ModelWords> }>(queryKeys.modelWords("loras"), (old) => ({ items: { ...(old?.items ?? {}), ...r.items } })),
  });
  const small = "flex h-5 shrink-0 items-center gap-1 rounded px-1 text-meta text-ink-2 enabled:hover:bg-hover enabled:hover:text-ink disabled:opacity-35";
  // which of them the prompt holds already: "+" has nothing to add when all are there, "−" nothing to take when none is
  const there = main && words ? wordsIn(main.text, words, main.style) : { any: false, all: false };
  if (typing !== null) {
    return (
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(typing);
          setTyping(null);
        }}
      >
        <input
          autoFocus
          aria-label={`Your trigger words for ${fileLabel(file)}`}
          placeholder="Your words for it (empty: back to its own)"
          value={typing}
          maxLength={600}
          onChange={(e) => setTyping(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setTyping(null)}
          className={`${fieldClass} h-7 min-w-0 grow text-xs`}
        />
        <button type="submit" aria-label="Keep these words" className={small}><Check size={12} /></button>
      </form>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-1 text-xs text-ink-2">
      {info?.base && <Chip size="xs">{info.base}</Chip>}
      <button
        type="button"
        disabled={!words}
        data-tip={words && from ? `${FROM[from]}: ${words}\nClick to copy them.` : undefined}
        onClick={() => copy(words)}
        className="flex min-w-0 grow items-center gap-1.5 text-left enabled:hover:text-ink"
      >
        <span className={cx("min-w-0 truncate", !words && "text-ink-3", there.all && "text-ink")}>{copied ? "Copied" : words || "No trigger words known"}</span>
        {words && !copied && <Copy size={11} className="shrink-0" />}
      </button>
      {main && words && from !== "training" && (
        <span className="flex shrink-0 items-center rounded border border-line">
          <button type="button" disabled={there.all} aria-label={`Put the trigger words of ${fileLabel(file)} in the prompt`} data-tip={there.all ? "They are in the prompt" : "Put these words in the prompt"} onClick={() => main.set(appendTo(main.text, words, main.style))} className={small}><Plus size={12} /></button>
          <button type="button" disabled={!there.any} aria-label={`Take the trigger words of ${fileLabel(file)} out of the prompt`} data-tip={there.any ? "Take these words out of the prompt" : "They are not in the prompt"} onClick={() => main.set(removeFrom(main.text, words, main.style))} className={small}><Minus size={12} /></button>
        </span>
      )}
      <button type="button" aria-label={`Your own trigger words for ${fileLabel(file)}`} data-tip="Write your own words for this LoRA: they replace the ones shown" onClick={() => setTyping(more?.own ?? "")} className={small}><Pencil size={11} /></button>
    </div>
  );
}

/** Files whose words were asked of Civitai while this page is open: each is asked once. */
const askedWords = new Set<string>();

/**
 * The words that call LoRAs up, for the ones in use: what each file says, what is kept beside it, and,
 * for a file that gives none, what its page on Civitai gives. That page is asked by the file's
 * fingerprint, once (the server asks nothing unless looking things up is on in Settings). An ask that
 * failed is said (`failed`).
 */
export function useLoraWordsOf(files: string[]) {
  const known = useModelInfo("loras");
  const info = known.data?.items ?? {};
  const extra = useModelWords("loras");
  const more = extra.data?.items ?? {};
  const client = useQueryClient();
  const silent = files.filter((f) => info[f] && !info[f]!.trigger && !more[nameOf(f)] && !askedWords.has(f));
  const silentKey = silent.join("|");
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!silentKey || !extra.isSuccess) return;
    const asked = silentKey.split("|");
    for (const f of asked) askedWords.add(f);
    api.findModelWords("loras", asked).then(
      (r) => {
        setFailed(null);
        client.setQueryData<{ items: Record<string, ModelWords> }>(queryKeys.modelWords("loras"), (old) => ({ items: { ...(old?.items ?? {}), ...r.items } }));
        // a page came with the words
        void client.invalidateQueries({ queryKey: queryKeys.modelPages("loras") });
      },
      // said, and not asked again while the page is open (a reload asks again)
      (err: Error) => setFailed(err.message),
    );
  }, [silentKey, extra.isSuccess, client]);
  return { known, extra, info, more, failed, of: (file: string) => wordsOf(info[file], more[nameOf(file)]) };
}

/**
 * The lists of choices last worked out, by what each was worked out of, for the next form that asks the same: each clip
 * selected on a timeline draws its form anew, and every LoRA on the machine was ranked again for it (some 11 ms a
 * clip with a thousand files). A few are kept: an H3 form has two lists (High and Low), each its own.
 */
const choicesSeen = new Map<string, { reads: unknown[]; choices: Option[] }>();
const CHOICES_KEPT = 8;

/** The LoRAs the recipe adds itself (Turbo's, a distilled LoRA), as the form's values put them on, and how to change them. */
export interface AddedLoras {
  rows: AddedRow[];
  specs: InputSpec[];
  /** What this ComfyUI offers for each input (a row's file input among them). */
  options: Record<string, string[]>;
  values: Record<string, unknown>;
  set(input: string, value: unknown): void;
}

/**
 * A LoRA the recipe adds itself, as a row of the list (card #160): what adds it, its file (those of its slot's kind first, any
 * LoRA allowed) and its weight. A row of the same file added by hand is shown as this one, at its weight: the first change
 * moves that weight into the row and takes the hand row out of the list. Its × turns the toggle that adds it off (the file
 * and weight stay for when it is on again); a LoRA the model needs has none, and at weight 0 it is left out.
 */
function AddedRowField({ row, added, list, onList, family }: { row: AddedRow; added: AddedLoras; list: LoraValue[]; onList(value: LoraValue[]): void; family: FamilyInfo | undefined }) {
  const { added: a } = row;
  const weightSpec = added.specs.find((s) => s.id === a.weight);
  const fileSpec = added.specs.find((s) => s.id === a.file);
  const toggle = a.toggle ? added.specs.find((s) => s.id === a.toggle) : undefined;
  const limits = weightSpec?.type === "number" ? { min: Math.min(weightSpec.min, 0), max: weightSpec.max, step: weightSpec.step } : { min: -4, max: 4, step: 0.05 };
  // the hand row of the same file, folded into this one: its weight kept in the row, the row out of the list
  const fold = () => {
    if (row.hand < 0) return;
    added.set(a.weight, row.weight);
    onList(list.filter((_, j) => j !== row.hand));
  };
  const weight = (w: number) => {
    if (row.hand >= 0) onList(list.filter((_, j) => j !== row.hand));
    added.set(a.weight, w);
  };
  const name = fileLabel(row.file);
  return (
    <div data-added={a.label} className="flex flex-col gap-1 rounded-lg border border-line bg-raised py-1.5 pr-1 pl-3">
      <div className="flex items-center gap-2">
        <span className="flex shrink-0 items-center gap-1">
          <Chip size="xs" tone={a.toggle ? "accent" : "neutral"}>{a.label}</Chip>
          <Help text={a.note} />
        </span>
        <div className="min-w-0 grow">
          <FileSelect
            id={`added-${a.file}`} label={fileSpec?.label ?? a.label} value={row.file} files={added.options[a.file] ?? [row.file]} folder="loras"
            match={fileSpec?.type === "model" ? fileSpec.match : undefined} family={family?.id}
            onChange={(f) => {
              fold();
              added.set(a.file, f);
            }}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="min-w-0 grow truncate text-xs text-ink-2">{weightSpec?.label ?? "Weight"}{row.weight === 0 ? " · not loaded" : ""}</span>
        <Slider label={`Strength of ${name}`} min={limits.min} max={limits.max} step={limits.step} zero={0} box={false} value={Math.max(limits.min, Math.min(limits.max, row.weight))} onChange={weight} className="w-24 shrink-0" />
        <NumberBox label={`Strength of ${name}, typed`} value={row.weight} min={limits.min} max={limits.max} step={limits.step} onCommit={weight} className="shrink-0 text-xs" />
        {a.toggle ? (
          <CloseButton
            size={28}
            label={`Remove ${name}: turns ${toggle?.label ?? a.label} off`}
            onClose={() => {
              fold();
              added.set(a.toggle!, false);
            }}
          />
        ) : (
          // a LoRA the model needs: nothing to remove, its place kept so that the rows line up
          <span className="w-7 shrink-0" />
        )}
      </div>
    </div>
  );
}

export function Loras({ spec, value, options, family, model, onChange, main, added }: {
  spec: Extract<InputSpec, { type: "loras" }>;
  value: LoraValue[];
  options: string[];
  family: FamilyInfo | undefined;
  model: string | undefined;
  onChange(value: LoraValue[]): void;
  main?: MainText;
  /** The LoRAs the recipe adds itself with these values, drawn first. */
  added?: AddedLoras;
}) {
  // what each file says about itself (read once by the server, arriving in the background the first time), and the words kept beside it
  const { known, extra, info, more, failed } = useLoraWordsOf(value.map((v) => v.file));
  const rows = added?.rows ?? [];
  // a hand row of a file the recipe adds itself is shown as that row; and that file is not offered again: it is in the list
  const folded = new Set(rows.map((r) => r.hand).filter((i) => i >= 0));
  const free = options.filter((o) => !value.some((v) => v.file === o) && !rows.some((r) => sameLora(r.file, o)));
  const handCount = value.length - folded.size;
  // the count says every LoRA the render loads, the rows the recipe adds among them (a Turbo row takes a place of the list)
  const loaded = handCount + rows.length;
  // where each LoRA is with a pod in the settings: a pod's own says so, and a stopped pod's (or its set's) is offered greyed
  const places = useFilePlaces("loras");
  const set = (i: number, weight: number) => onChange(value.map((v, j) => (j === i ? { ...v, weight } : v)));
  const choices = useMemo(() => {
    const key = [spec.label, family?.id ?? "", model ?? "", free.join("|")].join("\n");
    const reads = [known.data, extra.data, ...places.reads];
    const seen = choicesSeen.get(key);
    if (seen && seen.reads.every((r, i) => r === reads[i])) return seen.choices;
    const made = free.map((file, index) => ({ file, index, about: info[file], fit: family ? loraFit(family, file, info[file]) : 0, near: model ? modelFit(model, file, info[file]) : 0 }));
    // sections only when the files tell enough to make them: otherwise the list stays as ComfyUI gives it
    const sorted = made.some((m) => m.fit > 0 || m.near > 0);
    const wanted = family ? baseGroup(baseLabel(family.name)) : "";
    // a list for one half of a model pair ("High", "Low") puts the files of that half first
    // (as a word of its own in the file's name or folder: "Low_noise", "LowNoise", "Wan/Low", not "blow")
    const half = /\bhigh\b/i.test(spec.label) ? /(^|[^A-Za-z])(high|High|HIGH)(?![a-z])/ : /\blow\b/i.test(spec.label) ? /(^|[^A-Za-z])(low|Low|LOW)(?![a-z])/ : null;
    // made for the very model in use (or its line) first; then the rest of its family; a LoRA of another line of the family after those
    const line = model ? lineOf(model) : null;
    const rank = (m: { fit: number; near: number }) => (m.near > 0 && m.fit >= 0 ? 0 : m.fit > 0 ? (m.near < 0 ? 2 : 1) : m.fit === 0 ? 3 : 4);
    const titles = [
      line ? `Made for ${line}` : "Made for the model in use", `Made for ${wanted || "this model"}`,
      `Made for another kind of ${wanted || "model"}`, "Do not say which model they are for", "Made for other models",
    ];
    if (sorted) made.sort((a, b) => rank(a) - rank(b) || (half ? Number(half.test(b.file)) - Number(half.test(a.file)) : 0) || b.near - a.near || b.fit - a.fit || a.index - b.index);
    const choices = made.map((m): Option => ({
      ...fileOption(m.file, m.about),
      ...(places.said(m.file) ? { note: [fileOption(m.file, m.about).note, places.said(m.file)].filter(Boolean).join(" · ") } : {}),
      detail: wordsOf(m.about, more[nameOf(m.file)]).words || undefined,
      ...(more[nameOf(m.file)] ? { search: [fileOption(m.file, m.about).search, more[nameOf(m.file)]!.own, more[nameOf(m.file)]!.found].filter(Boolean).join(" ") } : {}),
      ...(sorted ? { group: titles[rank(m)] } : {}),
    }));
    choices.push(...places.offered([...options, ...value.map((v) => v.file)]));
    choicesSeen.delete(key);
    choicesSeen.set(key, { reads, choices });
    if (choicesSeen.size > CHOICES_KEPT) choicesSeen.delete(choicesSeen.keys().next().value!);
    return choices;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the reads the options come from; the helpers that read them are new at every render
  }, [free.join("|"), known.data, extra.data, family?.id, spec.label, model, places]);
  return (
    <div className="flex flex-col gap-1.5">
      <Label aside={`${loaded} of ${Math.max(spec.max, loaded)}`} note={spec.note}>{spec.label}</Label>
      {failed && <span className="text-xs text-ink-3">Trigger words could not be looked up: {failed}</span>}
      {added && rows.map((r) => <AddedRowField key={r.added.file} row={r} added={added} list={value} onList={onChange} family={family} />)}
      {value.map((l, i) => folded.has(i) ? null : (
        <div key={l.file} className="flex flex-col gap-1 rounded-lg border border-line bg-raised py-1.5 pr-1 pl-3">
          <div className="flex items-center gap-2">
            <ModelLink folder="loras" file={l.file} className="min-w-0 grow font-semibold" />
            {/* the slider covers −1 to 2; the typed box beside it goes further */}
            <Slider label={`Strength of ${fileLabel(l.file)}`} min={-1} max={2} step={0.05} zero={0} box={false} value={Math.max(-1, Math.min(2, l.weight))} onChange={(v) => set(i, v)} className="w-24 shrink-0" />
            <NumberBox label={`Strength of ${fileLabel(l.file)}, typed`} value={l.weight} min={-4} max={4} step={0.05} onCommit={(v) => set(i, v)} className="shrink-0 text-xs" />
            <CloseButton size={28} label={`Remove ${fileLabel(l.file)}`} onClose={() => onChange(value.filter((_, j) => j !== i))} />
          </div>
          <LoraWords file={l.file} info={info[l.file]} more={more[nameOf(l.file)]} main={main} />
        </div>
      ))}
      {loaded < spec.max && (
        <Select
          dashed
          size="sm"
          className="h-9"
          icon={<Plus size={14} className="shrink-0" />}
          label={`${spec.label}, add one`}
          placeholder={options.length ? "Add a LoRA" : "No LoRAs found on your ComfyUI"}
          searchHint={`Search ${free.length} by name, trigger words or model${known.data?.pending ? ` (still reading ${known.data.pending} files)` : ""}`}
          value=""
          options={choices}
          onChange={(file) => onChange([...value, { file, weight: 0.8 }])}
        />
      )}
    </div>
  );
}
