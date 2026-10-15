import type { BrowseBases, BrowseCard, Download } from "../api";
import { count } from "../useGetFile";
import { askSaid, PERIOD_WORDS, SORT_WORDS, TYPE_WORDS, type BrowseAsk } from "./browseSearch";
import { completeLast } from "./search";
import type { Section } from "./items";
import { size } from "../format";
import { says } from "../GetFile";
import { prepare } from "./match";
import type { Shown } from "./items";

/**
 * Civitai and Hugging Face in the bar, as rows: a pasted link read into its files (a row per version and file, Enter
 * downloads it after asking), and in `!` the model downloads under way or just ended. Their actions are in
 * actions/models.tsx.
 */

/** Whether what is typed is a link to read as a model (`api.browseLink` says whether it is one). */
export const isLink = (line: string) => /^https?:\/\/\S+$/i.test(line.trim());

/** Rows past this many files of one link: the rest in Find models (Tab). */
const LINK_ROWS = 12;

/** A link's files as rows, the linked version first (as the server orders them). */
export function linkRows(card: BrowseCard): Shown[] {
  const rows: Shown[] = [];
  for (const v of card.versions) {
    for (const f of v.files) {
      if (rows.length >= LINK_ROWS) return rows;
      const label = card.site === "civitai" ? `${card.name} · ${v.name}${v.files.length > 1 ? ` · ${f.name}` : ""}` : f.name;
      const meta = [
        card.type || null, v.base || card.base || null, f.bytes ? size(f.bytes) : null,
        f.folder ? `→ ${f.folder}` : "its folder asked", f.have.length ? "you have it" : null, card.gated ? "gated" : null,
      ].filter(Boolean).join(" · ");
      rows.push({ key: `link:${card.site}:${card.id}:${v.id}:${f.name}`, kind: "command", label, meta, group: "Model link", verb: "download", p: prepare(label), value: { kind: "link", card, version: v.id, file: f.name } });
    }
  }
  return rows;
}

/** Whether a download still runs (Stop), or ended (Dismiss, and Download again after a failure). */
export const downloading = (d: Download) => d.status === "starting" || d.status === "downloading" || d.status === "saving";

/** The model downloads, those under way first, as rows of `!`. */
export function downloadRows(list: readonly Download[], machineName: (id: string) => string | null): Shown[] {
  return [...list].sort((a, b) => Number(downloading(b)) - Number(downloading(a))).map((d) => {
    const part = d.total ? `${Math.round((Math.min(1, d.bytes / d.total)) * 100)} % of ${size(d.total)}` : d.bytes ? size(d.bytes) : null;
    const on = d.machine ? machineName(d.machine) : null;
    const label = d.title || d.file;
    // the file beside its folder when the title does not say it: two versions of one model read apart
    const meta = [d.status === "downloading" ? part : says(d), label === d.file ? d.folder : `${d.folder} › ${d.file}`, on].filter(Boolean).join(" · ");
    return { key: `download:${d.id}`, kind: "command", label, meta, group: "Downloads", verb: downloading(d) ? "show" : d.again ? "download again" : "dismiss", p: prepare(`${label} ${d.file}`), value: { kind: "download", d } };
  });
}

const SITE_SAID = { civitai: "Civitai", huggingface: "Hugging Face" } as const;

/**
 * A search of Civitai or Hugging Face as rows: first Find models opened on it (Enter, or Ctrl+Enter on any row), then the
 * models it found (Enter opens one there; Tab picks a file, downloads it after asking, its page, more by its creator).
 */
export function browseRows(ask: BrowseAsk, cards: readonly BrowseCard[] | undefined, families: BrowseBases["families"]): Section[] {
  const group = SITE_SAID[ask.site];
  const open: Shown = { key: `find:${ask.site}`, kind: "command", label: `Find models on ${group}`, meta: askSaid(ask, families), group, verb: "open", p: prepare(group), value: { kind: "find", ask } };
  const off = ask.unknown.map((u): Shown => ({ key: `find-off:${u}`, kind: "command", label: `${u} is not read`, meta: KEY_TAKES[u.split(":")[0]!] ?? "", group, verb: "—", p: prepare(u) }));
  const found = (cards ?? []).map((c): Shown => ({
    key: `card:${c.site}:${c.id}`, kind: "command", label: c.name, group, verb: "open", p: prepare(c.name), value: { kind: "card", card: c, ask },
    meta: [c.type || null, c.base || null, c.creator ? `by ${c.creator}` : null, c.downloads ? `${count(c.downloads)} downloads` : null, c.have ? "you have it" : null, c.update ? "a newer version than yours" : null, c.gated ? "gated" : null].filter(Boolean).join(" · "),
  }));
  return [{ group, rows: [open, ...off, ...found] }];
}

/** What a browse key takes, said when its value names nothing. */
const KEY_TAKES: Record<string, string> = {
  type: "type: takes lora, checkpoint, vae, upscaler, controlnet, textencoder, unet, dora, locon",
  base: "base: takes one of your model families (klein, sdxl, wan…)",
  sort: "sort: takes downloads, rated, liked, new (Hugging Face: downloads, liked, trending, new)",
  period: "period: takes day, week, month, year, all",
  kind: "kind: takes comfyui, loras, all (Hugging Face)",
};

/** A browse key's values while it is typed, each writing itself in the line. */
export function browseValueRows(line: string, ask: BrowseAsk, families: BrowseBases["families"]): Section[] {
  const t = ask.typing;
  if (!t) return [];
  const fits = (s: string) => !t.value || s.toLowerCase().startsWith(t.value.toLowerCase());
  const row = (value: string, meta: string): Shown => ({ key: `find-${t.key}:${value}`, kind: "command", label: `${t.key}:${value}`, meta, group: "Filters", verb: "choose", p: prepare(value), complete: completeLast(line, `${t.key}:${value}`) });
  // each value once, by the first word that names it ("lora", not "loras")
  const firstOf = (map: Record<string, string>) => [...new Map(Object.entries(map).reverse().map(([w, v]) => [v, w])).entries()].reverse();
  const rows =
    t.key === "type" ? firstOf(TYPE_WORDS).map(([v, w]) => row(w, v)) :
    t.key === "base" ? families.filter((f) => f.on || t.value).map((f) => row(f.id, f.name)) :
    t.key === "sort" ? firstOf(SORT_WORDS[ask.site]).map(([v, w]) => row(w, v)) :
    t.key === "period" ? firstOf(PERIOD_WORDS).map(([v, w]) => row(w, v)) :
    ["comfyui", "loras", "all"].map((k) => row(k, k === "comfyui" ? "single-file models, as ComfyUI loads them" : k === "loras" ? "LoRAs" : "everything"));
  return [{ group: "Filters", rows: rows.filter((r) => fits(r.label.slice(t.key.length + 1))) }];
}
