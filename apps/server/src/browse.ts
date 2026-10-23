import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isModelFile } from "@afflatus/core";
import { civitaiGet, civitaiSites } from "./civitai";
import { envSaid } from "./config";
import { httpError } from "./errors";
import { folderFor, folderOfPath } from "./fromLink";
import { fileName } from "./media";
import { setsWithFiles } from "./modelSets";
import { fetchPublic } from "./outbound";
import type { Services } from "./services";
import { readSettings } from "./settings";

/**
 * Find models: Civitai's and Hugging Face's models as cards for the browser (FindModels.tsx), each file with where it goes
 * (its ComfyUI folder), where a pod or this computer gets it (a Civitai version, a Hugging Face address), and what the
 * user has of it already (this computer's file of the same SHA-256 or name, a Model set that holds it, a newer version
 * than theirs). Read-only: what is picked is added to a set, a deploy, or downloaded by the routes that already do it.
 * Civitai's list pages are asked without the user's key (civitaiPage says why), what is opened with it: Afflatus adds no
 * filter of its own.
 */

/** Where a file comes from, as a set file or a pod's want says it. */
export type BrowseSource = { kind: "civitai"; version: number; pick: string } | { kind: "url"; url: string };

/** What the user has of a file already. */
export type Have = { kind: "pc"; folder: string; file: string } | { kind: "set"; name: string };

export interface BrowseFile {
  name: string;
  bytes: number;
  /** What tells it apart from the others of its version ("fp8 · pruned"). */
  note: string;
  sha256: string | null;
  folder: string | null;
  why?: string;
  source: BrowseSource;
  have: Have[];
}

export interface BrowseVersion {
  id: string;
  name: string;
  base: string;
  publishedAt: string | null;
  trainedWords: string[];
  files: BrowseFile[];
}

export interface BrowseCard {
  site: "civitai" | "huggingface";
  /** The model's number on Civitai, or the repository ("Comfy-Org/flux2"). */
  id: string;
  name: string;
  /** Civitai's word (LORA, Checkpoint, Upscaler…), or Hugging Face's library or pipeline. */
  type: string;
  base: string;
  creator: string;
  downloads: number;
  likes: number;
  updatedAt: string | null;
  /** A small picture of it (Civitai only: Hugging Face has none). */
  thumb: string | null;
  page: string;
  licence: { commercial: boolean | null; credit: boolean; derivatives: boolean | null };
  /** The user's family it is for, by its base model ("Wan 2.2"). */
  fits: string | null;
  /** A file of it is on this computer (by its SHA-256, else its name). */
  have: boolean;
  /** The user has an older version of it. */
  update: { have: string; latest: string } | null;
  /** Needs an account that accepted its terms (Hugging Face). */
  gated: boolean;
  /** Civitai: every version with its files. Hugging Face: empty until the repository is opened (its model files). */
  versions: BrowseVersion[];
  /** Hugging Face: how many model files the repository holds. */
  modelFiles?: number;
}

/**
 * Civitai's names for the base models each family runs (its BaseModel list, /api/v1/enums): the browser's filter starts
 * on the user's families. Names Civitai does not list today simply match nothing.
 */
export const FAMILY_BASES: Record<string, string[]> = {
  h3: ["MiniMax H3"],
  wan: ["Wan Video 2.2 I2V-A14B", "Wan Video 2.2 T2V-A14B", "Wan Video 2.2 TI2V-5B"],
  scail: ["Wan Video 14B i2v 720p", "Wan Video 14B i2v 480p"],
  ltx: ["LTXV 2.3", "LTXV2"],
  ltx25: ["LTXV 2.5"],
  klein: ["Flux.2 Klein 9B", "Flux.2 Klein 4B", "Flux.2 Klein 9B-base", "Flux.2 Klein 4B-base"],
  krea2: ["Krea 2", "Krea 2 Turbo"],
  flux: ["Flux.1 D", "Flux.1 Krea", "Flux.1 Kontext", "Flux.2 D"],
  qwen: ["Qwen"],
  qwen21: ["Qwen 2.1"],
  zimage: ["ZImageTurbo", "ZImageBase"],
  sdxl: ["SDXL 1.0", "Illustrious", "NoobAI", "Pony"],
};

/** Hugging Face's base model of a family, for "LoRAs made for it" (its base_model:adapter: tag). */
const FAMILY_HF_BASES: Record<string, string[]> = {
  wan: ["Wan-AI/Wan2.2-I2V-A14B", "Wan-AI/Wan2.2-T2V-A14B"],
  qwen: ["Qwen/Qwen-Image"],
  flux: ["black-forest-labs/FLUX.1-dev"],
  sdxl: ["stabilityai/stable-diffusion-xl-base-1.0"],
};

/** Civitai's sorts and periods, as its API takes them. */
const SORTS = ["Most Downloaded", "Highest Rated", "Most Liked", "Newest"] as const;
const PERIODS = ["AllTime", "Year", "Month", "Week", "Day"] as const;
/** Civitai's model types the browser offers. */
const TYPES = ["LORA", "LoCon", "DoRA", "Checkpoint", "VAE", "TextEncoder", "Upscaler", "Controlnet", "UNet", "CLIPVision"] as const;
const PAGE = 24;

type CivImage = { url?: string; type?: string };
type CivFile = { name?: string; sizeKB?: number; type?: string; primary?: boolean; metadata?: { fp?: string | null; size?: string | null; format?: string | null } | null; hashes?: { SHA256?: string } };
type CivVersion = { id: number; name?: string; baseModel?: string; publishedAt?: string; trainedWords?: string[]; files?: CivFile[]; images?: CivImage[] };
type CivModel = {
  id: number; name: string; type?: string; creator?: { username?: string }; stats?: { downloadCount?: number; thumbsUpCount?: number };
  allowCommercialUse?: string[] | string; allowNoCredit?: boolean; allowDerivatives?: boolean; modelVersions?: CivVersion[];
  nsfw?: boolean; tags?: string[];
};

/**
 * Words that mark a model for adults. Civitai's own filter goes by a model's pictures, so one whose pictures pass can still
 * be named for it; with the user's switch off, such a card is not shown either. The explicit words count in its name or its
 * tags; the milder ones in its name only, as tags say what a model can do (the most used checkpoints are tagged "nsfw",
 * and "sexy" is put on a hairstyles pack).
 */
const EXPLICIT = /(^|[^a-z])(porn\w*|hentai|xxx|lewd|sex|erotic\w*|boobs?|nipples?|genitals?|penis|vagina|pussy|futa\w*|ahegao|bdsm|fetish\w*)(?![a-z])/i;
const MILD = /(^|[^a-z])(nsfw|nude|nudity|naked|sexy|uncensored|breasts?|18\+)(?![a-z])/i;

/**
 * Whether a Civitai model is for adults: flagged so, or named or tagged so. Its nsfwLevel is not read: it gathers the
 * ratings of every picture posted with the model, and most plain models (a detail tweaker) carry some.
 */
export function forAdults(m: Pick<CivModel, "name" | "nsfw" | "tags">): boolean {
  return m.nsfw === true || MILD.test(m.name) || [m.name, ...(m.tags ?? [])].some((w) => EXPLICIT.test(w ?? ""));
}

/** A Civitai picture at 450 wide (a video's first frame as a still), from its full-size address. */
export function thumbOf(img: CivImage | undefined): string | null {
  if (!img?.url) return null;
  const size = img.type === "video" ? "anim=false,transcode=true,width=450" : "width=450";
  return /\/(original=true|width=\d+)[^/]*\//.test(img.url) ? img.url.replace(/\/(original=true|width=\d+)[^/]*\//, `/${size}/`) : img.url;
}

/** What a request needs to say what the user has: their files by hash and by name, their sets' files, their versions. */
interface Known {
  bySha: Map<string, { folder: string; file: string }>;
  byName: Map<string, { folder: string; file: string }>;
  inSets: Map<string, string[]>;
  versions: Map<number, { versionId: number; versionName: string; latest: string | null }>;
  bases: Map<string, string>;
}

async function known(s: Services): Promise<Known> {
  const [hashes, sets, updates, settings] = await Promise.all([
    s.db.selectFrom("model_hashes").select(["folder", "file", "sha256"]).execute(),
    setsWithFiles(s).catch(() => []),
    s.db.selectFrom("model_updates").select(["model_id", "version_id", "version_name", "latest_name"]).execute(),
    readSettings(s.db),
  ]);
  const bySha = new Map(hashes.map((h) => [h.sha256, { folder: h.folder, file: h.file }]));
  const byName = new Map(hashes.map((h) => [fileName(h.file).toLowerCase(), { folder: h.folder, file: h.file }]));
  const inSets = new Map<string, string[]>();
  for (const set of sets) for (const f of set.files) inSets.set(fileName(f.file).toLowerCase(), [...(inSets.get(fileName(f.file).toLowerCase()) ?? []), set.name]);
  const versions = new Map(updates.map((u) => [u.model_id, { versionId: u.version_id, versionName: u.version_name, latest: u.latest_name }]));
  // the families on, by the base models Civitai names them with
  const bases = new Map<string, string>();
  for (const f of s.registry.families()) {
    if (settings.families[f.id] === false) continue;
    for (const b of FAMILY_BASES[f.id] ?? []) if (!bases.has(b)) bases.set(b, f.name);
  }
  return { bySha, byName, inSets, versions, bases };
}

const haveOf = (k: Known, name: string, sha: string | null): Have[] => {
  // by its hash when the site says one: every file known here is hashed, so one of that name with other bytes is another
  // file (the fp16 beside an fp8, a stranger's LoRA of the same name). By the name only when the site says no hash
  const pc = sha ? k.bySha.get(sha.toUpperCase()) : k.byName.get(name.toLowerCase());
  return [...(pc ? [{ kind: "pc" as const, ...pc }] : []), ...(k.inSets.get(name.toLowerCase()) ?? []).map((n) => ({ kind: "set" as const, name: n }))];
};

/** A Civitai model as a card: its versions and their model files, each with its folder, its source, and what the user has. */
export function civitaiCard(m: CivModel, k: Known): BrowseCard {
  const type = m.type ?? "";
  const versions = (m.modelVersions ?? []).map((v): BrowseVersion => ({
    id: String(v.id), name: v.name ?? String(v.id), base: v.baseModel ?? "", publishedAt: v.publishedAt ?? null, trainedWords: (v.trainedWords ?? []).slice(0, 20),
    files: (v.files ?? []).filter((f) => isModelFile(f.name ?? "")).map((f) => {
      const place = folderFor(type, v.baseModel ?? "", m.name);
      const sha = f.hashes?.SHA256?.toUpperCase() ?? null;
      return {
        name: f.name!, bytes: Math.round((f.sizeKB ?? 0) * 1024), sha256: sha,
        note: [f.metadata?.fp, f.metadata?.size, f.metadata?.format && f.metadata.format !== "SafeTensor" ? f.metadata.format : ""].filter(Boolean).join(" · "),
        folder: place.folder, ...(place.why ? { why: place.why } : {}),
        source: { kind: "civitai", version: v.id, pick: f.name! }, have: haveOf(k, f.name!, sha),
      };
    }),
  }));
  const first = m.modelVersions?.[0];
  const mine = k.versions.get(m.id);
  const commercial = m.allowCommercialUse;
  return {
    site: "civitai", id: String(m.id), name: m.name, type, base: first?.baseModel ?? "", creator: m.creator?.username ?? "",
    downloads: m.stats?.downloadCount ?? 0, likes: m.stats?.thumbsUpCount ?? 0, updatedAt: first?.publishedAt ?? null,
    thumb: thumbOf(m.modelVersions?.flatMap((v) => v.images ?? [])[0]),
    page: `https://civitai.com/models/${m.id}`,
    licence: {
      commercial: commercial === undefined ? null : Array.isArray(commercial) ? commercial.length > 0 && !commercial.includes("None") : commercial !== "None",
      credit: m.allowNoCredit === false, derivatives: m.allowDerivatives ?? null,
    },
    fits: versions.map((v) => k.bases.get(v.base)).find(Boolean) ?? null,
    have: versions.some((v) => v.files.some((f) => f.have.some((h) => h.kind === "pc"))),
    update: mine?.latest ? { have: mine.versionName, latest: mine.latest } : null,
    gated: false, versions,
  };
}

const hfSite = () => (envSaid.huggingfaceUrl() ?? "https://huggingface.co").replace(/\/+$/, "");
const hfHeaders = (token: string): Record<string, string> => ({ "User-Agent": "afflatus", ...(token ? { Authorization: `Bearer ${token}` } : {}) });

type HfRepo = { id: string; downloads?: number; likes?: number; lastModified?: string; gated?: boolean | string; tags?: string[]; library_name?: string; pipeline_tag?: string; siblings?: Array<{ rfilename: string }> };

/** A Hugging Face repository as a card: its files come when it is opened (repoFiles). */
function huggingFaceCard(r: HfRepo, k: Known, family: Map<string, string>): BrowseCard {
  const [owner = "", name = r.id] = r.id.split("/");
  const base = (r.tags ?? []).find((t) => t.startsWith("base_model:"))?.split(":").pop() ?? "";
  const files = (r.siblings ?? []).filter((x) => isModelFile(x.rfilename));
  return {
    // what it is, without the tag every ComfyUI repack carries; its base model by its own name ("MiniMax-H3")
    site: "huggingface", id: r.id, name, type: r.pipeline_tag ?? (r.library_name === "diffusion-single-file" ? "" : r.library_name ?? ""), base: base.split("/").pop() ?? "", creator: owner,
    downloads: r.downloads ?? 0, likes: r.likes ?? 0, updatedAt: r.lastModified ?? null, thumb: null, page: `https://huggingface.co/${r.id}`,
    licence: { commercial: null, credit: false, derivatives: null }, fits: family.get(base) ?? null,
    have: files.some((f) => k.byName.has(fileName(f.rfilename).toLowerCase())), update: null, gated: Boolean(r.gated), versions: [], modelFiles: files.length,
  };
}

/** A repository's model files with their sizes and SHA-256 (its tree), each with its folder by its path and what the user has. */
async function repoFiles(repo: string, token: string, k: Known): Promise<BrowseFile[]> {
  const res = await fetchPublic(`${hfSite()}/api/models/${repo}/tree/main?recursive=true`, { headers: hfHeaders(token), signal: AbortSignal.timeout(20_000) }, [hfSite()]).catch(() => null);
  if (!res?.ok) throw httpError(res?.status === 404 ? "Hugging Face has no such repository." : "Hugging Face did not answer.", res?.status === 404 ? 404 : 502);
  const tree = (await res.json().catch(() => [])) as Array<{ type?: string; path?: string; size?: number; lfs?: { oid?: string; size?: number } }>;
  return tree.filter((t) => t.type === "file" && t.path && isModelFile(t.path)).map((t) => {
    const name = t.path!.split("/").pop()!;
    const sha = t.lfs?.oid?.toUpperCase() ?? null;
    return {
      name, bytes: t.lfs?.size ?? t.size ?? 0, note: t.path!.includes("/") ? t.path!.split("/").slice(0, -1).join("/") : "", sha256: sha,
      folder: folderOfPath(t.path!) ?? (/lora/i.test(t.path!) ? "loras" : null),
      source: { kind: "url", url: `https://huggingface.co/${repo}/resolve/main/${t.path!.split("/").map(encodeURIComponent).join("/")}` }, have: haveOf(k, name, sha),
    };
  });
}

/** How long a list page asked of a site may take, both Civitai sites together: past it, the page says the site did not answer. */
const PAGE_DEADLINE_MS = 20_000;
/** A page taking longer than this is logged (Civitai has slow spells; the log tells them from Afflatus's own). */
const SLOW_PAGE_MS = 3_000;
/** How long a list page is kept: Civitai's own shared cache keeps its answers 5 minutes (s-maxage=300). */
const PAGE_KEEP_MS = 5 * 60_000;
/** The most pages kept, the oldest going first. */
const PAGES_KEPT = 60;

/**
 * The sites' list pages kept a while by their address, each as the promise of its answer: the page after the one served is
 * asked at once (`ahead`), so that it is here, or on its way, when the user scrolls to it. A page that failed is not kept:
 * Try again asks again. What the user has (known()) is never kept: it is read for every page, in about a millisecond.
 */
export class PageStore<T> {
  private pages = new Map<string, { at: number; got: Promise<T> }>();
  constructor(private keepMs = PAGE_KEEP_MS, private most = PAGES_KEPT, private clock = () => Date.now()) {}
  /** The page at this address: kept, coming (asked ahead), or asked now. `how` says which, for Server-Timing. */
  get(key: string, ask: () => Promise<T>): { got: Promise<T>; how: "kept" | "asked" } {
    const had = this.pages.get(key);
    if (had && this.clock() - had.at < this.keepMs) return { got: had.got, how: "kept" };
    return { got: this.put(key, ask), how: "asked" };
  }
  /** The page at this address asked now, unless it is kept or coming; its failure is nobody's (it is asked again when wanted). */
  ahead(key: string, ask: () => Promise<T>): void {
    const had = this.pages.get(key);
    if (had && this.clock() - had.at < this.keepMs) return;
    this.put(key, ask).catch(() => {});
  }
  forget(): void {
    this.pages.clear();
  }
  private put(key: string, ask: () => Promise<T>): Promise<T> {
    const got = ask();
    this.pages.delete(key);
    this.pages.set(key, { at: this.clock(), got });
    got.catch(() => { if (this.pages.get(key)?.got === got) this.pages.delete(key); });
    for (const old of this.pages.keys()) {
      if (this.pages.size <= this.most) break;
      this.pages.delete(old);
    }
    return got;
  }
}

type CivPage = { items?: CivModel[]; metadata?: { nextCursor?: string | number } };
type HfPage = { repos: HfRepo[]; next: string | null };
const civitaiPages = new PageStore<CivPage | null>();
const huggingFacePages = new PageStore<HfPage>();
/** For the tests: forget the pages kept. @internal */
export const forgetPages = () => {
  civitaiPages.forget();
  huggingFacePages.forget();
};

/**
 * A list page of Civitai's models, asked without the user's key: Civitai's shared cache bypasses every request that carries
 * one (3.5 to 6.5 s a page with 27 base models, on 2026-10-24), and keeps those without for 5 minutes (40 to 80 ms then),
 * while the models listed and their cursors were the same either way. The key still goes with what is the account's own: a
 * model opened from a link, a version's files, a download.
 */
const civitaiPage = (path: string) => {
  const deadline = AbortSignal.timeout(PAGE_DEADLINE_MS);
  return civitaiGet<CivPage>(path, "", deadline).catch((err: unknown) => {
    throw deadline.aborted ? httpError(`Civitai did not answer in ${PAGE_DEADLINE_MS / 1000} s.`, 504) : err;
  });
};

/**
 * How many models a block asked of Civitai after the first page holds: Civitai's time goes by the query, hardly by its size
 * (27 base models: 24 models in 6.2 to 6.5 s, 72 in 6.7 to 6.8, 100 in 7.3, on 2026-10-24), so one block, asked ahead,
 * serves the next four pages. The first page stays at 24, so that opening waits no longer than it did.
 */
const BLOCK = 96;

/**
 * Where a page of Find models' own starts: Civitai's cursor of the block it is in ("" the first), and how far into that
 * block (`<cursor>~<at>`). A cursor without "~" is Civitai's own, read as the start of its block.
 */
function blockCursor(cursor: string | undefined): { from: string; at: number } {
  const cut = cursor?.lastIndexOf("~") ?? -1;
  if (!cursor || cut < 0) return { from: cursor ?? "", at: 0 };
  return { from: cursor.slice(0, cut), at: Math.max(0, Math.min(BLOCK, Number(cursor.slice(cut + 1)) || 0)) };
}

/** The block of Civitai's models from its cursor `from` for this query: kept, coming, or asked now; or only asked ahead. */
function civitaiBlock(params: URLSearchParams, from: string, ahead?: false): { got: Promise<CivPage | null>; how: "kept" | "asked" };
function civitaiBlock(params: URLSearchParams, from: string, ahead: true): void;
function civitaiBlock(params: URLSearchParams, from: string, ahead = false) {
  const asked = new URLSearchParams(params);
  asked.set("limit", String(from ? BLOCK : PAGE));
  if (from) asked.set("cursor", from);
  const key = `${civitaiSites()}?${asked}`;
  const ask = () => civitaiPage(`/api/v1/models?${asked}`);
  if (ahead) return civitaiPages.ahead(key, ask);
  return civitaiPages.get(key, ask);
}

/** A list page of Hugging Face's repositories, and the cursor of the next one (in its Link header). */
const huggingFacePage = async (params: URLSearchParams, token: string): Promise<HfPage> => {
  const deadline = AbortSignal.timeout(PAGE_DEADLINE_MS);
  const res = await fetchPublic(`${hfSite()}/api/models?${params}`, { headers: hfHeaders(token), signal: deadline }, [hfSite()]).catch(() => null);
  if (!res?.ok) throw httpError(deadline.aborted ? `Hugging Face did not answer in ${PAGE_DEADLINE_MS / 1000} s.` : "Hugging Face did not answer.", deadline.aborted ? 504 : 502);
  const repos = (await res.json().catch(() => [])) as HfRepo[];
  const next = /<[^>]*[?&]cursor=([^&>]+)[^>]*>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
  return { repos: Array.isArray(repos) ? repos : [], next: next ? decodeURIComponent(next) : null };
};

/** A Server-Timing entry (DevTools' Timing tab): its name, how long, and what it was. */
const timing = (name: string, from: number, desc?: string) => `${name};dur=${Math.round(performance.now() - from)}${desc ? `;desc="${desc}"` : ""}`;

/** A list page that took long, logged with whose time it was. */
const sayIfSlow = (site: string, from: number, how: string) => {
  const ms = performance.now() - from;
  if (ms > SLOW_PAGE_MS) console.warn(`[browse] ${site} took ${(ms / 1000).toFixed(1)} s for a page (${how})`);
};

const csv = z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).flatMap((x) => x.split("|")).filter(Boolean).slice(0, 20));

export function registerBrowse(app: FastifyInstance, s: Services): void {
  const lookupsOn = async () => {
    const settings = await readSettings(s.db);
    if (!settings.civitaiLookups) throw httpError("Searching Hugging Face and Civitai is off. Turn it on in Settings › Models.", 409);
    return settings;
  };

  /** The filters' choices: Civitai's base models, and the user's families with theirs (the filter starts on those). */
  app.get("/api/browse/bases", async () => {
    const settings = await readSettings(s.db);
    const families = s.registry.families().filter((f) => !f.imported && FAMILY_BASES[f.id]).map((f) => ({ id: f.id, name: f.name, on: settings.families[f.id] !== false, bases: FAMILY_BASES[f.id]!, hf: FAMILY_HF_BASES[f.id] ?? [] }));
    return { families, types: TYPES, sorts: SORTS, periods: PERIODS };
  });

  /** Civitai's models for words and filters, a page at a time (its cursor), as cards. */
  app.get("/api/browse/civitai", async (req, reply) => {
    const q = z.object({
      q: z.string().max(200).default(""), types: csv, bases: csv, sort: z.enum(SORTS).default("Most Downloaded"), period: z.enum(PERIODS).default("AllTime"), cursor: z.string().max(400).optional(),
      all: z.enum(["1", "0"]).default("0"),
      // one creator's models only (the command bar's by:), by their Civitai name
      by: z.string().trim().max(80).regex(/^[\w.-]*$/, "a Civitai user name").default(""),
    }).parse(req.query);
    await lookupsOn();
    const params = new URLSearchParams({ sort: q.sort, period: q.period });
    if (q.q.trim()) params.set("query", q.q.trim());
    if (q.by) params.set("username", q.by);
    for (const t of q.types) params.append("types", t);
    for (const b of q.bases) params.append("baseModels", b);
    // Civitai's API leaves part of its models out unless asked for all of them (both its sites alike): the user's switch
    if (q.all === "1") params.set("nsfw", "true");
    const { from, at } = blockCursor(q.cursor);
    const start = performance.now();
    const block = civitaiBlock(params, from);
    const got = await block.got;
    sayIfSlow("Civitai", start, block.how);
    const site = timing("civitai", start, block.how);
    const models = got?.items ?? [];
    const after = got?.metadata?.nextCursor !== undefined ? String(got.metadata.nextCursor) : null;
    // the block after this one, asked now: here, or on its way, when the list is scrolled to its end
    if (after) civitaiBlock(params, after, true);
    const shown = models.slice(at, at + PAGE);
    const next = at + PAGE < models.length ? `${from}~${at + PAGE}` : after !== null ? `${after}~0` : null;
    const read = performance.now();
    const k = await known(s);
    const knew = timing("known", read);
    const made = performance.now();
    // the switch off: what Civitai still sends that is for adults by its rating, name or tags is left out (a page may come
    // shorter; its cursor still goes on)
    const items = shown.filter((m) => q.all === "1" || !forAdults(m)).map((m) => civitaiCard(m, k));
    reply.header("Server-Timing", [site, knew, timing("cards", made), timing("total", start)].join(", "));
    return { items, next };
  });

  /**
   * Hugging Face's repositories for words, and "made for" one base model (its adapters: Hugging Face takes one such filter
   * at a time, several meaning all of them at once), a page at a time.
   */
  app.get("/api/browse/huggingface", async (req, reply) => {
    const q = z.object({ q: z.string().max(200).default(""), base: z.string().max(120).refine((b) => Object.values(FAMILY_HF_BASES).flat().includes(b), "a base model the browser offers").optional(), kind: z.enum(["comfyui", "loras", "all"]).default("comfyui"), sort: z.enum(["downloads", "likes", "lastModified", "trendingScore"]).default("downloads"), cursor: z.string().max(400).optional(), by: z.string().trim().max(96).regex(/^[\w.-]*$/, "a Hugging Face user or organisation").default("") }).parse(req.query);
    const settings = await lookupsOn();
    const params = new URLSearchParams({ sort: q.sort, direction: "-1", limit: String(PAGE), full: "true" });
    if (q.q.trim()) params.set("search", q.q.trim());
    // one user's or organisation's repositories only (the command bar's by:)
    if (q.by) params.set("author", q.by);
    if (q.base) params.append("filter", `base_model:adapter:${q.base}`);
    // ComfyUI's kind of files (single-file models, as Comfy-Org's repacks are tagged), LoRAs, or anything (most of the
    // Hub is text models): Hugging Face reads several filters as all of them at once, so one kind at a time
    if (q.kind === "comfyui" && !q.base) params.append("filter", "diffusion-single-file");
    if (q.kind === "loras") params.append("filter", "lora");
    if (q.cursor) params.set("cursor", q.cursor);
    // kept by the token too: a gated repository's listing may differ with it
    const token = settings.huggingFaceToken;
    const keyOf = (p: URLSearchParams) => `${hfSite()}?${p}#${token ? "token" : ""}`;
    const start = performance.now();
    const page = huggingFacePages.get(keyOf(params), () => huggingFacePage(params, token));
    const { repos, next } = await page.got;
    sayIfSlow("Hugging Face", start, page.how);
    const site = timing("huggingface", start, page.how);
    if (next) {
      const after = new URLSearchParams(params);
      after.set("cursor", next);
      huggingFacePages.ahead(keyOf(after), () => huggingFacePage(after, token));
    }
    const read = performance.now();
    const k = await known(s);
    const knew = timing("known", read);
    const made = performance.now();
    const family = new Map(Object.entries(FAMILY_HF_BASES).flatMap(([id, bases]) => bases.map((b) => [b, s.registry.families().find((f) => f.id === id)?.name ?? id] as [string, string])));
    const items = repos.map((r) => huggingFaceCard(r, k, family));
    reply.header("Server-Timing", [site, knew, timing("cards", made), timing("total", start)].join(", "));
    return { items, next };
  });

  /** A Hugging Face repository opened: its model files with their sizes and SHA-256. */
  app.get("/api/browse/huggingface/files", async (req) => {
    const { repo } = z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "a repository is owner/name").max(200) }).parse(req.query);
    const settings = await lookupsOn();
    return { files: await repoFiles(repo, settings.huggingFaceToken, await known(s)) };
  });

  /**
   * A pasted link as a card: a Civitai model or version page, a Hugging Face repository, or a file of one. What any search
   * box of models takes (a Model set, the Deploy dialog, the browser).
   */
  app.post("/api/browse/link", async (req) => {
    const { link } = z.strictObject({ link: z.string().min(8).max(2000) }).parse(req.body);
    const settings = await lookupsOn();
    let at: URL;
    try {
      at = new URL(link.trim());
    } catch {
      throw httpError("That is not an address: paste a Civitai model page, or a Hugging Face repository or file.");
    }
    const k = await known(s);
    const civitaiHosts = civitaiSites().map((x) => new URL(x).hostname);
    if (/(^|\.)civitai\.(com|red)$/i.test(at.hostname) || civitaiHosts.includes(at.hostname)) {
      const versionId = Number(at.searchParams.get("modelVersionId") ?? /\/(?:model-versions|api\/download\/models)\/(\d+)/.exec(at.pathname)?.[1] ?? 0);
      let modelId = Number(/\/models\/(\d+)/.exec(at.pathname)?.[1] ?? 0);
      if (!modelId && versionId) modelId = (await civitaiGet<{ modelId?: number }>(`/api/v1/model-versions/${versionId}`, settings.civitaiKey))?.modelId ?? 0;
      if (!modelId) throw httpError("That Civitai address names no model: open the model's page and copy its address.");
      const m = await civitaiGet<CivModel>(`/api/v1/models/${modelId}`, settings.civitaiKey);
      if (!m) throw httpError("Civitai does not show that model (removed, or it needs an account: a Civitai key in Settings helps).", 404);
      const card = civitaiCard(m, k);
      // the version the link names first
      if (versionId) card.versions.sort((a, b) => Number(b.id === String(versionId)) - Number(a.id === String(versionId)));
      return { card };
    }
    if (/(^|\.)(huggingface|hf)\.co$/i.test(at.hostname) || at.origin === hfSite()) {
      const m = /^\/([\w.-]+)\/([\w.-]+)(?:\/(?:resolve|blob|tree)\/[^/]+\/?(.*))?$/.exec(at.pathname);
      if (!m) throw httpError("On Hugging Face, paste a repository's address, or a file's.");
      const repo = `${m[1]}/${m[2]}`;
      const files = await repoFiles(repo, settings.huggingFaceToken, k);
      const wanted = m[3] ? decodeURIComponent(m[3]) : "";
      // a file's address: that file alone; a repository's: its model files
      const picked = wanted && isModelFile(wanted) ? files.filter((f) => `${f.note ? `${f.note}/` : ""}${f.name}` === wanted) : files;
      if (!picked.length) throw httpError(wanted ? "That repository has no such model file." : "That repository holds no model file.", 404);
      return {
        card: {
          site: "huggingface", id: repo, name: m[2]!, type: "", base: "", creator: m[1]!, downloads: 0, likes: 0, updatedAt: null, thumb: null, page: `https://huggingface.co/${repo}`,
          licence: { commercial: null, credit: false, derivatives: null }, fits: null, have: picked.some((f) => f.have.some((h) => h.kind === "pc")), update: null, gated: false,
          versions: [{ id: "main", name: "main", base: "", publishedAt: null, trainedWords: [], files: picked }],
        } satisfies BrowseCard,
      };
    }
    throw httpError("Afflatus reads a Civitai model page, or a Hugging Face repository or file.");
  });
}

