import type { BrowseBases } from "../api";
import type { FindAsk, HfSort } from "../findModels/store";

/**
 * Civitai and Hugging Face searched from the bar (docs/command-bar.md, "Civitai and Hugging Face"): `civitai:` or `hf:`
 * anywhere, with the browser's own filters as keys: `type:lora`, `base:klein` (a family), `sort:new`, `period:week`,
 * `by:someone`, `kind:loras` (Hugging Face), `new` and `all` bare. Read by fixed rules, as the render search is; what it
 * asks is what Find models would show with the same filters (`toFind`).
 */

export type Site = "civitai" | "huggingface";

export interface BrowseAsk {
  site: Site;
  words: string;
  /** Civitai's types (LORA, Checkpoint…); empty: the browser's own choice is kept. */
  types: string[];
  /** The families named by base:, by id; their Civitai base models and Hugging Face ones. */
  families: string[];
  bases: string[];
  hfBase: string;
  hfKind: "comfyui" | "loras" | "all" | null;
  sort: string | null;
  period: string | null;
  by: string;
  all: boolean;
  /** Keys whose value names nothing the site takes ("type:zzz"), said on a row. */
  unknown: string[];
  /** The key whose value is being typed (no space after it yet), for its values' rows. */
  typing: { key: "type" | "base" | "sort" | "period" | "kind"; value: string } | null;
}

const SITE_KEYS: Record<string, Site> = { civitai: "civitai", hf: "huggingface", huggingface: "huggingface" };

/** Civitai's types by what is typed (`type:lora`, `type:checkpoint`, `type:upscaler`). */
export const TYPE_WORDS: Record<string, string> = {
  lora: "LORA", loras: "LORA", locon: "LoCon", dora: "DoRA", checkpoint: "Checkpoint", checkpoints: "Checkpoint", model: "Checkpoint", vae: "VAE",
  textencoder: "TextEncoder", encoder: "TextEncoder", upscaler: "Upscaler", upscale: "Upscaler", controlnet: "Controlnet", unet: "UNet", clipvision: "CLIPVision",
};
/** Civitai's orders, and Hugging Face's, by what is typed. */
export const SORT_WORDS: Record<Site, Record<string, string>> = {
  civitai: { downloads: "Most Downloaded", downloaded: "Most Downloaded", popular: "Most Downloaded", rated: "Highest Rated", rating: "Highest Rated", liked: "Most Liked", likes: "Most Liked", new: "Newest", newest: "Newest" },
  huggingface: { downloads: "downloads", downloaded: "downloads", popular: "downloads", liked: "likes", likes: "likes", trending: "trendingScore", new: "lastModified", newest: "lastModified" },
};
export const PERIOD_WORDS: Record<string, string> = { day: "Day", today: "Day", week: "Week", month: "Month", year: "Year", all: "AllTime", ever: "AllTime" };
const KIND_WORDS: Record<string, "comfyui" | "loras" | "all"> = { comfyui: "comfyui", comfy: "comfyui", loras: "loras", lora: "loras", all: "all", everything: "all" };

const pieces = (line: string) => line.trim().split(/\s+/).filter(Boolean);

/** The line read as a search of Civitai or Hugging Face, or null when it names neither. */
export function parseBrowse(line: string, families: BrowseBases["families"] = []): BrowseAsk | null {
  const all = pieces(line);
  let site: Site | null = null;
  const words: string[] = [];
  const ask: Omit<BrowseAsk, "site" | "words" | "typing"> = { types: [], families: [], bases: [], hfBase: "", hfKind: null, sort: null, period: null, by: "", all: false, unknown: [] };
  for (const p of all) {
    const m = /^([a-z]+):(.*)$/i.exec(p);
    const key = m?.[1]!.toLowerCase();
    const value = m?.[2] ?? "";
    if (key && SITE_KEYS[key]) {
      site = SITE_KEYS[key]!;
      if (value) words.push(value);
    } else if (key === "type") {
      const t = TYPE_WORDS[value.toLowerCase()];
      if (t) ask.types.push(t);
      else if (value) ask.unknown.push(p);
    } else if (key === "base") {
      const f = families.find((x) => x.id.toLowerCase() === value.toLowerCase()) ?? families.find((x) => value && x.name.toLowerCase().includes(value.toLowerCase()));
      if (f) ask.families.push(f.id);
      else if (value) ask.unknown.push(p);
    } else if (key === "sort") ask.sort = value.toLowerCase();
    else if (key === "period") {
      const v = PERIOD_WORDS[value.toLowerCase()];
      if (v) ask.period = v;
      else if (value) ask.unknown.push(p);
    } else if (key === "kind") {
      const v = KIND_WORDS[value.toLowerCase()];
      if (v) ask.hfKind = v;
      else if (value) ask.unknown.push(p);
    } else if (key === "by") ask.by = value.replace(/^@/, "");
    else if (p.toLowerCase() === "new") ask.sort = "new";
    else if (p.toLowerCase() === "all") ask.all = true;
    else words.push(p);
  }
  if (!site) return null;
  // sort: read for the site named, wherever it was typed
  const sortWord = ask.sort;
  ask.sort = sortWord ? (SORT_WORDS[site][sortWord] ?? null) : null;
  if (sortWord && !ask.sort) ask.unknown.push(`sort:${sortWord}`);
  const chosen = families.filter((f) => ask.families.includes(f.id));
  ask.bases = chosen.flatMap((f) => f.bases);
  ask.hfBase = chosen.flatMap((f) => f.hf)[0] ?? "";
  const lastPiece = /\s$/.test(line) ? null : all.at(-1);
  const t = lastPiece ? /^(type|base|sort|period|kind):(.*)$/i.exec(lastPiece) : null;
  return { site, words: words.join(" "), ...ask, typing: t ? { key: t[1]!.toLowerCase() as "type", value: t[2]! } : null };
}

/**
 * Find models opened on the same search, every filter said, so that it shows what the bar showed: what the bar leaves
 * out is the browser's start (any type, the user's families, the most downloaded of all time, models for ComfyUI).
 */
export function toFind(a: BrowseAsk): FindAsk {
  if (a.site === "civitai") {
    return { tab: "civitai", words: a.words, by: a.by, types: a.types, chosenFamilies: a.families.length ? a.families : null, sort: a.sort ?? "Most Downloaded", period: a.period ?? "AllTime", ...(a.all ? { all: true } : {}) };
  }
  return { tab: "huggingface", words: a.words, by: a.by, hfBase: a.hfBase, hfKind: a.hfKind ?? "comfyui", hfSort: (a.sort as HfSort | null) ?? "downloads" };
}

/** What the bar asks the site for the same search (toFind's filters); `familiesOn`: the bases of the user's families, the default. */
export function siteQuery(a: BrowseAsk, familiesOn: BrowseBases["families"]) {
  const f = toFind(a);
  return a.site === "civitai"
    ? { site: "civitai" as const, q: a.words, types: f.types ?? [], bases: a.families.length ? a.bases : familiesOn.filter((x) => x.on).flatMap((x) => x.bases), sort: f.sort!, period: f.period!, all: a.all, by: a.by }
    : { site: "huggingface" as const, q: a.words, base: f.hfBase ?? "", kind: f.hfKind!, sort: f.hfSort!, by: a.by };
}

/** The search in a few words, for the row that opens Find models on it ("LoRAs · Klein · newest · by someone"). */
export function askSaid(a: BrowseAsk, families: BrowseBases["families"] = []): string {
  const fam = a.families.map((id) => families.find((f) => f.id === id)?.name ?? id);
  return [
    a.words ? `“${a.words}”` : null, a.types.join(", ") || null, fam.join(", ") || null, a.hfKind, a.sort, a.period, a.by ? `by ${a.by}` : null, a.all ? "all of Civitai" : null,
  ].filter(Boolean).join(" · ") || "everything";
}
