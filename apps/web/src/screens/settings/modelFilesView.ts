import type { ModelFile, ModelLibrary } from "../../api";

/**
 * What Settings › Model files works out of its list on the page: how long each file has not been used by Afflatus, the
 * bands of the space bar, the filters and the sort. Afflatus sees its own jobs only: what a file "was not used" for is
 * always said as "not used by Afflatus".
 */

const DAY = 86_400_000;

/**
 * The bands of the space bar: by days since Afflatus last used a file, and the files no Afflatus job has loaded since
 * it began keeping each job's files. A file never used is not "8–30 days": it has a band of its own.
 */
export const BANDS = [
  { id: "week", label: "Used in the last 7 days", short: "Last 7 days", lo: 0, hi: 7, tone: "bg-good" },
  { id: "month", label: "Last used 8 to 30 days ago", short: "8–30 days", lo: 8, hi: 30, tone: "bg-good/45" },
  { id: "quarter", label: "Last used 31 to 90 days ago", short: "31–90 days", lo: 31, hi: 90, tone: "bg-ink-3" },
  { id: "idle", label: "Last used by Afflatus over 90 days ago", short: "Last used 90+ days ago", lo: 91, hi: Infinity, tone: "bg-attention/55" },
  { id: "never", label: "Never used by Afflatus", short: "Never used by Afflatus", lo: Infinity, hi: Infinity, tone: "bg-attention" },
] as const;
export type Band = (typeof BANDS)[number]["id"];

/** Afflatus has kept its jobs' files for less than 90 days: nothing can be "not used for 90 days" yet. */
export const young = (since: string | null, now = Date.now()) => !since || now - Date.parse(since) <= 90 * DAY;

/** No Afflatus job has loaded the file since Afflatus began keeping each job's files. */
export const neverUsed = (f: ModelFile) => !f.last && !f.uses;

/**
 * Days since Afflatus last used a file: since its last use, else since it is here or since Afflatus began keeping uses,
 * whichever is later (a file older than the records has been "not used since then", not for ever).
 */
export function idleDays(f: ModelFile, since: string | null, now = Date.now()): number {
  // a use dated a moment ahead (another machine's clock) is a use today
  if (f.last) return Math.max(0, Math.floor((now - Date.parse(f.last)) / DAY));
  const from = Math.max(f.mtime ?? 0, since ? Date.parse(since) : 0);
  return from ? Math.max(0, Math.floor((now - from) / DAY)) : Infinity;
}

export function bandOf(f: ModelFile, since: string | null, now = Date.now()): Band {
  if (neverUsed(f)) return "never";
  const days = idleDays(f, since, now);
  return BANDS.find((b) => days >= b.lo && days <= b.hi)?.id ?? "idle";
}

/** The kinds in the order the chips show them. */
export const KINDS = ["Diffusion model", "Checkpoint", "LoRA", "Text encoder", "VAE", "Upscaler", "CLIP vision", "ControlNet", "Audio encoder", "Other"];
export const KIND_PLURAL: Record<string, string> = { "Diffusion model": "Diffusion models", Checkpoint: "Checkpoints", LoRA: "LoRAs", "Text encoder": "Text encoders", Upscaler: "Upscalers", "Audio encoder": "Audio encoders" };

export type SortKey = "name" | "kind" | "base" | "size" | "added" | "uses" | "last" | "takes";

export interface Filters {
  family: string | null;
  q: string;
  kind: string;
  /** "any", "30", "90" (more than that many days), or one band of the space bar ("never" among them). */
  idle: "any" | "30" | "90" | Band;
  copies: boolean;
  /** Only the files no site matched. */
  noMatch: boolean;
  sort: { key: SortKey; down: boolean };
}

export const NO_FILTER: Omit<Filters, "sort"> = { family: null, q: "", kind: "all", idle: "any", copies: false, noMatch: false };

/** What "also seen as" means, for its "?". */
export const ALSO_HELP = "One file on disk that ComfyUI reaches through two folders: extra_model_paths.yaml lists the same folder twice (or a folder and its sub-folder), or models/unet, which ComfyUI reads as diffusion_models. It is listed once, its size counted once, and it is never taken for a copy of itself: Delete moves it once, from every place it is seen in.";

/** A file's name as the table says it: where it was found, else its file name without its folder or extension. */
/**
 * A copy's place as the list says it, from its row id: `folder/file`, with where it is for a file under a name another
 * directory's file holds first (`folder|file|path`, modelLibrary.ts).
 */
export const placeOfId = (id: string) => {
  const [folder, file, ...path] = id.split("|");
  return path.length ? `${folder}/${file} (${path.join("|")})` : `${folder}/${file}`;
};

export const nameOf = (f: ModelFile) => f.name ?? (f.file.split("/").pop() ?? f.file).replace(/\.[a-z0-9]+$/i, "");

/** The files shown, filtered and sorted. Files Delete moved stay in the list (greyed), whatever the filters. */
export function shown(lib: ModelLibrary, o: Filters, now = Date.now()): ModelFile[] {
  const q = o.q.trim().toLowerCase();
  const out = lib.files.filter((f) => {
    if (o.family && !f.families.includes(o.family)) return false;
    if (o.kind !== "all" && f.kind !== o.kind) return false;
    if (o.copies && (f.removed || !f.copies.length)) return false;
    if (o.noMatch && f.match !== "none") return false;
    if (q && !`${f.folder}/${f.file} ${f.also.map((a) => `${a.folder}/${a.file}`).join(" ")} ${f.name ?? ""} ${f.version ?? ""} ${f.base ?? ""}`.toLowerCase().includes(q)) return false;
    if (o.idle === "any") return true;
    if (o.idle === "30" || o.idle === "90") return idleDays(f, lib.since, now) > Number(o.idle);
    return bandOf(f, lib.since, now) === o.idle;
  });
  const value: Record<SortKey, (f: ModelFile) => number | string> = {
    name: (f) => nameOf(f).toLowerCase(), kind: (f) => KINDS.indexOf(f.kind), base: (f) => (f.base ?? "").toLowerCase(), size: (f) => f.size ?? 0, added: (f) => f.mtime ?? 0,
    uses: (f) => f.uses, last: (f) => (neverUsed(f) ? -1e8 : -Math.min(idleDays(f, lib.since, now), 1e7)), takes: (f) => f.takes,
  };
  const by = value[o.sort.key];
  return out.sort((a, b) => {
    const x = by(a);
    const y = by(b);
    const c = x < y ? -1 : x > y ? 1 : 0;
    return (o.sort.down ? -c : c) || (b.size ?? 0) - (a.size ?? 0);
  });
}

/**
 * The files the first figure counts: while Afflatus has kept its jobs' files for less than 90 days, the ones never used
 * by Afflatus since then ("never": "not used for 90 days" cannot be known yet); after that, the ones not used by
 * Afflatus for 90 days, never-used files here that long among them. `filter` is what its "Show them" shows.
 */
export function idleFiles(files: ModelFile[], since: string | null, now = Date.now()): { never: boolean; files: ModelFile[]; filter: Filters["idle"] } {
  if (young(since, now)) return { never: true, files: files.filter(neverUsed), filter: "never" };
  return { never: false, files: files.filter((f) => idleDays(f, since, now) > 90), filter: "90" };
}

/** The figures on top: everything, not used (see idleFiles), the extra copies, no match; each over what the family filter shows. */
export function figures(lib: ModelLibrary, family: string | null, now = Date.now()) {
  const files = lib.files.filter((f) => !f.removed && (!family || f.families.includes(family)));
  const sum = (fs: ModelFile[]) => fs.reduce((n, f) => n + (f.size ?? 0), 0);
  const idle = idleFiles(files, lib.since, now);
  // of each set of copies, the one used most (else the first) is kept: the others are the extra ones
  const extra: ModelFile[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (!f.copies.length || !f.sha256 || seen.has(f.sha256)) continue;
    seen.add(f.sha256);
    const same = files.filter((x) => x.sha256 === f.sha256).sort((a, b) => b.uses - a.uses);
    extra.push(...same.slice(1));
  }
  const bands = BANDS.map((b) => {
    const fs = files.filter((f) => bandOf(f, lib.since, now) === b.id);
    return { ...b, files: fs.length, bytes: sum(fs) };
  });
  return {
    total: { files: files.length, bytes: sum(files) },
    idle: { ...idle, bytes: sum(idle.files) },
    extra: { files: extra, bytes: sum(extra) },
    noMatch: files.filter((f) => f.match === "none").length,
    bands,
  };
}

/** How the last use reads: "3 d ago", or "never" (since when, and why, for its tip). */
export function lastSaid(f: ModelFile, since: string | null, day: (iso: string) => string, ago: (iso: string) => string): { text: string; idle: boolean; tip?: string } {
  if (f.last) return { text: ago(f.last), idle: false };
  const added = f.mtime ? new Date(f.mtime).toISOString() : null;
  const unseen = "Renders made straight in ComfyUI are not seen.";
  if (added && since && added > since) return { text: "never", idle: true, tip: `Never used by Afflatus: here since ${day(added)}, no Afflatus job has loaded it since. ${unseen}` };
  if (since) return { text: "never", idle: true, tip: `Never used by Afflatus since ${day(since)}, the first job whose files Afflatus kept. ${unseen}` };
  return { text: "never", idle: true, tip: `Afflatus has kept no job's files yet. ${unseen}` };
}
