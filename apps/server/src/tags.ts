import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CHOICE } from "@afflatus/core";

/**
 * The danbooru tag list (assets/danbooru.csv.gz, about 140 000 tags with how often each is used and
 * its other names). Anime models (Illustrious, NoobAI, Pony) learned these tags: one that is not on
 * the list does little, and a typo does nothing. Read on first use.
 */

type Entry = { tag: string; count: number; category: number };
/** A spelling to compare typos against: a common tag, or one of its other names (which lead to the tag). */
type Spelling = { text: string; entry: Entry };

let db: { tags: Map<string, Entry>; aliases: Map<string, string>; byInitial: Map<string, Spelling[]> } | null = null;

function load() {
  if (db) return db;
  const text = gunzipSync(readFileSync(new URL("../assets/danbooru.csv.gz", import.meta.url))).toString("utf8");
  const tags = new Map<string, Entry>();
  const aliases = new Map<string, string>();
  const byInitial = new Map<string, Spelling[]>();
  const index = (spelling: string, entry: Entry) => {
    const list = byInitial.get(spelling[0]!) ?? [];
    if (!list.length) byInitial.set(spelling[0]!, list);
    list.push({ text: spelling, entry });
  };
  for (const line of text.split("\n")) {
    if (!line) continue;
    // tag,category,count,"alias,alias": a tag never holds a comma
    const c1 = line.indexOf(",");
    const c2 = line.indexOf(",", c1 + 1);
    const c3 = line.indexOf(",", c2 + 1);
    if (c1 < 0 || c2 < 0) continue;
    const tag = line.slice(0, c1);
    const e: Entry = { tag, category: Number(line.slice(c1 + 1, c2)), count: Number(line.slice(c2 + 1, c3 < 0 ? undefined : c3)) };
    tags.set(tag, e);
    // typos are only compared with tags that are common enough, and with their other names ("smiling" is smile)
    const common = e.count >= 100 && e.category === 0;
    if (common) index(tag, e);
    if (c3 >= 0) {
      for (const a of line.slice(c3 + 1).replace(/^"|"\r?$/g, "").split(",")) {
        const k = a.trim();
        if (!k || k.startsWith("/") || aliases.has(k)) continue;
        aliases.set(k, tag);
        if (common) index(k, e);
      }
    }
  }
  db = { tags, aliases, byInitial };
  return db;
}

/** Words about quality, age and rating that are not danbooru tags but that anime models were trained with. */
const META = new Set([
  "masterpiece", "best_quality", "amazing_quality", "high_quality", "normal_quality", "low_quality", "worst_quality",
  "bad_quality", "very_aesthetic", "aesthetic", "displeasing", "very_displeasing", "absurdres", "highres", "lowres",
  "newest", "recent", "mid", "early", "old", "very_awa", "year_2024", "year_2025", "safe", "sensitive", "nsfw",
  "explicit", "general", "questionable", "rating_safe", "rating_questionable", "rating_explicit", "source_anime",
  "source_cartoon", "source_furry", "source_pony",
]);

const OPEN = "([{";
const CLOSE = ")]}";
const balanced = (s: string) => {
  let depth = 0;
  for (const c of s) {
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
};

/** The tag inside its weight: "((red eyes))", "(red eyes:1.2)", "[red eyes]" are "red eyes". A tag's own brackets stay: "artoria pendragon (fate)". */
export function tagInner(raw: string): string {
  let s = raw.trim();
  for (;;) {
    const i = OPEN.indexOf(s[0] ?? " ");
    if (i < 0 || s[s.length - 1] !== CLOSE[i] || !balanced(s.slice(1, -1))) break;
    s = s.slice(1, -1).trim();
  }
  return s.replace(/:\s*-?\d+(?:\.\d+)?$/, "").trim();
}

/** A tag as the list spells it: no weight, lower case, underscores. */
export const tagKey = (tag: string): string => tagInner(tag.replace(/\\([()])/g, "$1")).replace(/\s+/g, " ").toLowerCase().replace(/ /g, "_");

/** How many letters apart two spellings are (a swap of two letters counts once), stopping early above `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      rowMin = Math.min(rowMin, d[i]![j]!);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

type Verdict =
  | { status: "ok" }
  | { status: "skip" }
  | { status: "alias"; suggestion: string }
  | { status: "unknown"; suggestion?: string; distance?: number };

/** Whether a tag of a prompt is a danbooru tag. Another name of one leads to the tag; an unknown one to the closest common tag, when there is one. */
export function checkTag(raw: string, ignore: Set<string> = new Set()): Verdict {
  const t = raw.trim();
  // a LoRA written in the text, choices in braces, an embedding, a tag with a prefix ("artist:…") and BREAK are not tags
  if (!t || /^<|[{}|]|^embedding:|^[a-z_]+:\S|^break$/i.test(t)) return { status: "skip" };
  const key = tagKey(t);
  // a long phrase is plain language on purpose; quality words and a LoRA's trigger words are fine as they are
  if (!key || key.split("_").length > 5 || META.has(key) || /^score_\d/.test(key) || ignore.has(key)) return { status: "skip" };
  const { tags, aliases, byInitial } = load();
  if (tags.has(key)) return { status: "ok" };
  const alias = aliases.get(key);
  if (alias) return { status: "alias", suggestion: alias.replace(/_/g, " ") };
  const max = key.length <= 5 ? 1 : 2;
  let best: Entry | undefined;
  let bestD = max + 1;
  for (const sp of byInitial.get(key[0]!) ?? []) {
    const d = distance(key, sp.text, max);
    if (d < bestD || (d === bestD && best && sp.entry.count > best.count)) {
      best = sp.entry;
      bestD = d;
    }
  }
  return best && bestD <= max ? { status: "unknown", suggestion: best.tag.replace(/_/g, " "), distance: bestD } : { status: "unknown" };
}

export interface TagIssue {
  tag: string;
  /** "alias": another name of a real tag. "unknown": not on the list. */
  status: "alias" | "unknown";
  /** The tag to write instead, when there is one. */
  suggestion?: string;
}

/** Every text a prompt with choices in braces can become, up to a few: "{red|black} dress" is "red dress" and "black dress". */
function everyChoice(text: string, most = 24): string[] {
  let all = [text];
  for (let round = 0; round < 8 && all.some((t) => CHOICE.test(t)); round++) {
    all = all.flatMap((t) => {
      const m = CHOICE.exec(t);
      return m ? m[1]!.split("|").map((o) => t.slice(0, m.index) + o + t.slice(m.index + m[0].length)) : [t];
    }).slice(0, most);
  }
  return all;
}

/** Every tag of a prompt that is not a plain danbooru tag, with what to write instead when that is known. */
export function checkPrompt(prompt: string, ignore: string[] = []): TagIssue[] {
  const skip = new Set(ignore.flatMap((w) => w.split(",")).map(tagKey).filter(Boolean));
  const out: TagIssue[] = [];
  const seen = new Set<string>();
  const text = prompt.replace(/<[^>]*>/g, ",");
  // what stands in the text as written: only such a tag can be swapped for another with a click
  const written = new Set(text.split(/[,\n{}|]/).map((p) => p.trim()));
  // choices in braces are looked at as what they can become: "{red|black} dress" is two tags, not "red" and "dress"
  for (const one of everyChoice(text)) {
    for (const part of one.split(/[,\n]/)) {
      const tag = part.trim();
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      const v = checkTag(tag, skip);
      if (v.status === "alias" || v.status === "unknown") out.push({ tag, status: v.status, ...(v.suggestion && written.has(tag) ? { suggestion: v.suggestion } : {}) });
    }
  }
  return out;
}

/**
 * What a language model wrote, tidied: another name of a tag becomes the tag, and an unknown tag one
 * letter away from a common one (a typo) becomes it. Says what was changed and what is still unknown.
 */
export function cleanTags(list: string, ignore: string[] = []): { tags: string; fixed: Array<{ from: string; to: string }>; unknown: string[] } {
  const skip = new Set(ignore.flatMap((w) => w.split(",")).map(tagKey).filter(Boolean));
  const fixed: Array<{ from: string; to: string }> = [];
  const unknown: string[] = [];
  const tags = list
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const v = checkTag(t, skip);
      // only what is near certain; the weight stays: "(smilling:1.2)" becomes "(smile:1.2)"
      if (v.status === "alias" || (v.status === "unknown" && v.suggestion && v.distance === 1)) {
        const to = t.replace(tagInner(t), v.suggestion!);
        fixed.push({ from: t, to });
        return to;
      }
      if (v.status === "unknown") unknown.push(t);
      return t;
    });
  return { tags: tags.join(", "), fixed, unknown };
}

export function registerTags(app: FastifyInstance): void {
  /** Which tags of a prompt are not danbooru tags. Nothing leaves the machine: the list is a file of Afflatus's. */
  app.post("/api/tags/check", async (req) => {
    const b = z.strictObject({ text: z.string().max(20_000), ignore: z.array(z.string().max(400)).max(200).default([]) }).parse(req.body);
    return { issues: checkPrompt(b.text, b.ignore) };
  });
}
