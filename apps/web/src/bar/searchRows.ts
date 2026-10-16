import type { Asset, AssetFilter, CommandEntry, FamilyInfo, PromptHistoryItem, UpdateRow } from "../api";
import { plural, when } from "../format";
import { prepare } from "./match";
import type { Item, Section, Shown } from "./items";
import { completeLast, isFlag, KEY_SAID, keysFor, sinceOf, valueText, without, type Parsed, type SearchKey, type Token } from "./search";

/**
 * The bar's render search turned into rows (docs/command-bar.md, "Searching renders"): the keys a word begins, a key's
 * values while it is typed (LoRAs, models, drafts, places, since, sort, prompts), what the keys and words find, and, when
 * nothing does, which key to take off. What the keys ask of the library is `filterOf`, the library's own list query.
 */

/** A LoRA or a model file the library's renders were made with, and how many. */
export type Used = { file: string; count: number };

export interface SearchData {
  line: string;
  parsed: Parsed;
  /** The library's model files and LoRAs, the most used first (`/api/assets/models`). */
  used: { models: Used[]; loras: Used[] } | undefined;
  families: readonly FamilyInfo[];
  /** The index's drafts, projects, folders and the Inbox, as rows (for draft: and in:). */
  drafts: readonly Item[];
  places: readonly Item[];
  /** Prompt history for prompt: (its words, or the last ones). */
  prompts: readonly PromptHistoryItem[];
  /** What the keys and words found, and how many in all; undefined while it is asked. */
  found: Asset[] | undefined;
  count: number | undefined;
  /** With nothing found: how many each token's absence would find. */
  loosen: Array<{ token: Token | "words"; count: number }> | undefined;
  /** A found item's place, said ("Showcase › shots"). */
  placeOf(a: Asset): string;
  /** A LoRA's or model file's newer version on Civitai, when the daily check or `> model updates` found one. */
  newer?(file: string): UpdateRow | undefined;
}

/** A file's name as it is typed: no folder, no extension ("loras/warm_light_v2.safetensors" → warm_light_v2). */
export const stem = (file: string) => file.replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]+$/i, "");

/** The best of `list` for what was typed: the same name, else one that begins with it, else one that holds it. */
function best<T>(list: readonly T[], typed: string, name: (t: T) => string): T | undefined {
  const t = typed.toLowerCase();
  return list.find((x) => name(x).toLowerCase() === t) ?? list.find((x) => name(x).toLowerCase().startsWith(t)) ?? list.find((x) => name(x).toLowerCase().includes(t));
}

/**
 * What the keys ask of the library's list (`api.assets`), every project's unless in: says where; `missing`: the tokens whose
 * value names nothing (lora:zzz), for which nothing can be found. Keys that ask for nothing the list knows (a `-` before
 * anything but kept) are `unsupported`, said on their chip.
 */
export function filterOf(d: Pick<SearchData, "parsed" | "used" | "families" | "drafts" | "places">): { filter: AssetFilter; missing: Token[]; unsupported: Token[] } {
  const filter: AssetFilter = { all: true };
  const missing: Token[] = [];
  const unsupported: Token[] = [];
  const words: string[] = d.parsed.words ? [d.parsed.words] : [];
  for (const t of d.parsed.tokens) {
    if (t.not && t.key !== "kept") {
      unsupported.push(t);
      continue;
    }
    switch (t.key) {
      case "image":
      case "video":
        filter.kind = t.key;
        break;
      case "sound":
        filter.kind = "audio";
        break;
      case "kept":
        if (t.not) filter.unkept = true;
        else filter.kept = true;
        break;
      case "bin":
        filter.bin = true;
        break;
      case "prompt":
        // the library's words look in the name and the prompt alike
        if (t.value) words.push(t.value);
        break;
      case "sort":
        filter.sort = ({ newest: "new", new: "new", oldest: "old", old: "old", name: "name", size: "size" } as const)[t.value.toLowerCase() as "newest"];
        if (!filter.sort) missing.push(t);
        break;
      case "since": {
        const at = t.value ? sinceOf(t.value) : null;
        if (at) filter.since = at.toISOString();
        else if (t.value) missing.push(t);
        break;
      }
      case "lora": {
        if (!t.value) break;
        const hit = best(d.used?.loras ?? [], t.value, (l) => stem(l.file));
        if (hit) filter.lora = hit.file;
        else missing.push(t);
        break;
      }
      case "model": {
        if (!t.value) break;
        // a family by its id or its name first (h3, Klein), else a model file
        const fam = d.families.find((f) => f.id.toLowerCase() === t.value.toLowerCase()) ?? best(d.families, t.value, (f) => f.name);
        const file = fam ? undefined : best(d.used?.models ?? [], t.value, (m) => stem(m.file));
        if (fam) filter.family = fam.id;
        else if (file) filter.model = file.file;
        else missing.push(t);
        break;
      }
      case "draft": {
        if (!t.value) break;
        const hit = best(d.drafts, t.value, (r) => r.label);
        if (hit?.entry) filter.draft = hit.entry.id;
        else missing.push(t);
        break;
      }
      case "in": {
        if (!t.value) break;
        const hit = best(d.places, t.value, (r) => r.label);
        if (hit?.inbox) filter.project = "none";
        else if (hit?.entry?.kind === "project") filter.project = hit.entry.id;
        else if (hit?.entry?.kind === "folder") filter.folder = hit.entry.id;
        else missing.push(t);
        break;
      }
    }
  }
  if (words.length) filter.q = words.join(" ");
  return { filter, missing, unsupported };
}

const row = (over: Partial<Item> & Pick<Item, "key" | "label" | "meta">): Shown => ({ kind: "command", group: "Commands", verb: "complete", p: prepare(over.label), ...over });

/** The keys a name begun fits, as rows: Enter or Tab writes the key. */
export function keyRows(line: string, prefix: string): Shown[] {
  return keysFor(prefix).map((k) => row({
    key: `search-key:${k}`, label: k === "kept" ? "kept" : `${k}:`, meta: KEY_SAID[k], group: "Filters", verb: "write",
    complete: completeLast(line, k === "kept" ? "kept" : `${k}:`),
  }));
}

/** A key's values while it is typed, as rows that write the value. */
export function valueRows(d: SearchData, key: SearchKey, typed: string): Section[] {
  const t = typed.toLowerCase();
  const put = (v: string) => completeLast(d.line, `${key}:${valueText(v)}`);
  const fits = (s: string) => !t || s.toLowerCase().includes(t);
  switch (key) {
    case "lora": {
      const rows = (d.used?.loras ?? []).filter((l) => fits(stem(l.file))).slice(0, 30).map((l) => {
        const n = d.newer?.(l.file);
        return row({ key: `search-lora:${l.file}`, label: stem(l.file), meta: [plural(l.count, "render"), n?.newer && `newer on Civitai: ${n.newer.name}`].filter(Boolean).join(" · "), group: "Filters", complete: put(stem(l.file)), verb: "choose", value: { kind: "lora", file: l.file, ...(n ? { newer: n } : {}) } });
      });
      return [{ group: "LoRAs · the most used first", rows }];
    }
    case "model": {
      const fams = d.families.filter((f) => fits(f.id) || fits(f.name))
        .map((f) => row({ key: `search-family:${f.id}`, label: f.name, meta: `Model family · model:${f.id}`, group: "Filters", complete: put(f.id), verb: "choose", value: { kind: "family", id: f.id } }));
      const files = (d.used?.models ?? []).filter((m) => fits(stem(m.file))).slice(0, 12).map((m) => {
        const n = d.newer?.(m.file);
        return row({ key: `search-model:${m.file}`, label: stem(m.file), meta: [`Model file · ${plural(m.count, "render")}`, n?.newer && `newer on Civitai: ${n.newer.name}`].filter(Boolean).join(" · "), group: "Filters", complete: put(stem(m.file)), verb: "choose", value: { kind: "model", file: m.file, ...(n ? { newer: n } : {}) } });
      });
      return [{ group: "Models", rows: fams }, { group: "Model files · the most used first", rows: files }];
    }
    case "draft": {
      const rows = [...d.drafts].filter((r) => fits(r.label)).sort((a, b) => ((b.entry?.updatedAt ?? "") > (a.entry?.updatedAt ?? "") ? 1 : -1)).slice(0, 30)
        .map((r) => ({ ...r, key: `search-draft:${r.key}`, group: "Filters" as const, complete: put(r.label), verb: "choose" }));
      return [{ group: "Drafts · the newest first", rows }];
    }
    case "in": {
      const rows = d.places.filter((r) => fits(r.label)).slice(0, 30).map((r) => ({ ...r, key: `search-in:${r.key}`, group: "Filters" as const, complete: put(r.label), verb: "choose" }));
      return [{ group: "Projects & folders", rows }];
    }
    case "since": {
      const rows = [["today", "Made today"], ["yesterday", "Since yesterday"], ["3d", "The last 3 days"], ["1w", "The last week"], ["1m", "The last month"]].filter(([v]) => fits(v!))
        .map(([v, m]) => row({ key: `search-since:${v}`, label: `since:${v}`, meta: m!, group: "Filters", complete: put(v!), verb: "choose" }));
      return [{ group: "Since", rows }];
    }
    case "sort": {
      const rows = [["newest", "The newest first (as without it)"], ["oldest", "The oldest first"], ["name", "By name, A to Z"], ["size", "The largest first"]].filter(([v]) => fits(v!))
        .map(([v, m]) => row({ key: `search-sort:${v}`, label: `sort:${v}`, meta: m!, group: "Filters", complete: put(v!), verb: "choose" }));
      return [{ group: "Order", rows }];
    }
    case "prompt":
      return [{ group: typed ? "Prompts" : "Your last prompts", rows: promptRows(d.prompts) }];
    default:
      return [];
  }
}

/** Rendered prompts as the bar's prompt rows (Enter: use in the open draft; Tab: its renders, copy). */
export const promptRows = (list: readonly PromptHistoryItem[]): Shown[] =>
  list.map((h, i) => ({
    key: `history:${i}:${h.createdAt}`, kind: "history", label: h.prompt.replace(/\s+/g, " ").slice(0, 140), group: "Prompt history",
    meta: when(h.createdAt), verb: h.clip ? "open" : h.assetId ? "view" : h.draftId ? "open" : "use", p: prepare(h.prompt.slice(0, 140)), history: h,
  }));

/** A found item as the bar's render row (its Tab actions are the item's own). */
export function assetEntry(a: Asset, project: string | null): Extract<CommandEntry, { kind: "asset" }> {
  return {
    kind: "asset", id: a.id, label: a.name.trim() || ({ image: "Image", video: "Video", audio: "Sound" } as const)[a.kind], project, folder: a.folderId,
    updatedAt: a.createdAt, assetKind: a.kind, width: a.width, height: a.height, durationMs: a.durationMs, bytes: a.bytes, hasThumb: a.kind !== "audio", ...(a.inBin ? { inBin: true as const } : {}),
  };
}

const KIND_WORD = { image: "Image", video: "Video", audio: "Sound" } as const;

/** What the keys and words found, and with nothing found, which key to take off. */
export function resultSections(d: SearchData, missing: Token[], unsupported: Token[]): Section[] {
  const out: Section[] = [];
  if (unsupported.length) out.push({ group: "Not read", rows: unsupported.map((t) => row({ key: `search-not:${t.start}`, label: `-${t.key}:${t.value}`, meta: "A - leaves out kept only for now: this key is not used", group: "Filters", complete: without(d.line, t), verb: "take it off" })) });
  if (missing.length) {
    out.push({ group: "Names nothing", rows: missing.map((t) => row({ key: `search-missing:${t.start}`, label: t.key === "since" ? `since: takes today, yesterday, 3d, 2w, 1m or a date, not “${t.value}”` : t.key === "sort" ? `sort: takes newest, oldest, name or size, not “${t.value}”` : `No ${t.key === "in" ? "project or folder" : t.key === "model" ? "model" : t.key} called “${t.value}”`, meta: `Enter takes ${t.key}: off`, group: "Filters", complete: without(d.line, t), verb: "take it off" })) });
    return out;
  }
  if (!d.found) return out;
  const rows: Shown[] = d.found.map((a) => {
    const meta = [a.inBin && "In the bin", KIND_WORD[a.kind], a.durationMs && a.kind !== "image" ? `${(a.durationMs / 1000).toFixed(1)} s` : null, a.width && a.height ? `${a.width}×${a.height}` : null, a.family ?? null, a.kept ? "kept" : null, when(a.createdAt), d.placeOf(a)].filter(Boolean).join(" · ");
    const e = assetEntry(a, null);
    return { key: `render:${a.id}`, kind: "render", label: e.label, meta, group: "Renders", verb: a.kind === "audio" ? "open" : "view", p: prepare(e.label), entry: e, archived: a.inBin };
  });
  if (rows.length) out.push({ group: `Renders · ${d.count ?? rows.length}`, rows });
  else {
    out.push({ group: "No render has all of these", rows: [] });
    const loosen = (d.loosen ?? []).filter((l) => l.count > 0).sort((a, b) => b.count - a.count).map((l) => row({
      key: `search-loosen:${l.token === "words" ? "words" : l.token.start}`, group: "Filters", verb: "take it off",
      label: l.token === "words" ? `Without the words “${d.parsed.words}”` : `Without ${l.token.not ? "-" : ""}${l.token.key}${isFlag(l.token.key) ? (l.token.key === "kept" ? "" : ":") : `:${l.token.value}`}`,
      meta: plural(l.count, "render"),
      complete: l.token === "words" ? d.parsed.tokens.map((t) => d.line.slice(t.start, t.end)).join(" ") : without(d.line, l.token),
    }));
    if (loosen.length) out.push({ group: "Without one of them", rows: loosen });
  }
  return out;
}

/** The filter without one token, or without the words: what board 4's counts ask. */
export function loosened(d: Pick<SearchData, "parsed" | "used" | "families" | "drafts" | "places">): Array<{ token: Token | "words"; filter: AssetFilter }> {
  const parts: Array<Token | "words"> = [...d.parsed.tokens, ...(d.parsed.words ? ["words" as const] : [])];
  if (!parts.length) return [];
  return parts.map((token) => {
    const parsed: Parsed = token === "words" ? { ...d.parsed, words: "" } : { ...d.parsed, tokens: d.parsed.tokens.filter((t) => t !== token) };
    return { token, filter: filterOf({ ...d, parsed }).filter };
  });
}
