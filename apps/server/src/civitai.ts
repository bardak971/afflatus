import { envSaid } from "./config";
import { httpError } from "./errors";
import { fetchPublic } from "./outbound";

/**
 * Asking Civitai where a model file can be had. Two sites answer the same way: civitai.com, and
 * civitai.red, which also shows the models the first one hides. Both are asked, and what they find is
 * put together. Nothing here runs unless the user turned lookups on.
 */

/**
 * Whether the sites asked are pretend ones on this machine (the tests, the demo). Only then is a plain-http download
 * allowed, and a real site never asked for what no pretend one stands in for (Hugging Face, Manager's model list). One
 * switch for it, set by the test config and the demo: CIVITAI_URL only says where Civitai is, and a mirror named there
 * lifts no rule.
 */
export const pretendSites = envSaid.pretendSites;

/** The sites to ask, in order. CIVITAI_URL replaces them (the tests and the demo point it at a pretend one). */
export const civitaiSites = () => { const own = envSaid.civitaiUrl(); return own ? [own.replace(/\/+$/, "")] : ["https://civitai.com", "https://civitai.red"]; };
const hostOf = (site: string) => {
  try {
    return new URL(site).host.replace(/^www\./, "");
  } catch {
    return site;
  }
};

/** What Civitai calls the kind of model that goes in each of ComfyUI's folders. */
export const KINDS: Record<string, string[]> = {
  checkpoints: ["Checkpoint"], diffusion_models: ["Checkpoint"], unet: ["Checkpoint"],
  loras: ["LORA", "LoCon", "DoRA"], vae: ["VAE"], text_encoders: ["TextEncoder"], clip: ["TextEncoder"],
  upscale_models: ["Upscaler"], controlnet: ["Controlnet"], embeddings: ["TextualInversion"],
  // the Impact pack's detectors are Civitai's "Detection" models; its SAM files have no type of their own there
  ultralytics: ["Detection"], sams: ["Other"],
};

export type ApiFile = { name?: string; sizeKB?: number; type?: string; primary?: boolean; downloadUrl?: string };
export type ApiVersion = { id?: number; name?: string; baseModel?: string; trainedWords?: string[]; files?: ApiFile[]; model?: { name?: string } };
export type ApiModel = { id: number; name: string; type?: string; modelVersions?: ApiVersion[] };

export interface CivitaiFound {
  name: string;
  /** Civitai's word for what it is: Checkpoint, LORA, TextEncoder, Upscaler, Workflows… */
  kind: string;
  /** Its page, on the site that has it. */
  url: string;
  site: string;
  version: string;
  base: string;
  words: string[];
  /** What a download of it fetches: the version, the file's own name and its size (0 when Civitai does not say). */
  versionId: number | null;
  file: string;
  bytes: number;
  /** One of its versions has a file of exactly the name asked for. */
  exact: boolean;
  /** It is the kind of model the folder holds. A workflow or a pose found by the same words is not. */
  fits: boolean;
  /** The words of the name asked for that are in its own names. */
  hits: string[];
  /** How many words the name asked for has. */
  of: number;
  /** This ComfyUI already has the file a download would fetch: where (the folder kind, and its name there). */
  have?: { folder: string; file: string };
}

export const STEM = /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i;
export const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
/** The words of a file's name: "qwen3vl_4b_fp8_scaled" → qwen3vl, 4b, fp8, scaled. */
export const wordsOf = (file: string) => [...new Set((file.split(/[\\/]/).pop() ?? file).replace(STEM, "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2))];

const headers = (key: string): Record<string, string> => ({ Accept: "application/json", "User-Agent": "afflatus", ...(key ? { Authorization: `Bearer ${key}` } : {}) });
/** Civitai's API asked: a redirect is judged hop by hop, and the key goes to the site asked only (outbound.ts). */
const ask = (url: string, key: string) => fetchPublic(url, { headers: headers(key), signal: AbortSignal.timeout(20_000) }, civitaiSites());

/**
 * The models both sites find for a file's name, the likeliest first: the one that has a file of exactly
 * that name, then the right kind of model, then the names closest to it.
 */
export async function findOnCivitai(file: string, folder: string | null, key: string): Promise<{ items: CivitaiFound[]; asked: string[]; silent: string[] }> {
  const name = file.split(/[\\/]/).pop() ?? file;
  const words = wordsOf(name);
  const sites = civitaiSites();
  const wanted = folder ? KINDS[folder] : undefined;
  const search = async (query: string) => {
    const answers = await Promise.all(sites.map(async (site) => {
      try {
        // nsfw=true: without it the sites leave out every model marked mature, which is a large share of them.
        // The kind is asked for too, so that workflows and LoRAs that only mention the model do not fill the answer.
        const params = new URLSearchParams({ query, limit: "20", nsfw: "true" });
        for (const kind of wanted ?? []) params.append("types", kind);
        const res = await ask(`${site}/api/v1/models?${params}`, key);
        if (!res.ok) return { site, models: null as ApiModel[] | null };
        return { site, models: (((await res.json().catch(() => ({}))) as { items?: ApiModel[] }).items ?? []) };
      } catch {
        return { site, models: null as ApiModel[] | null };
      }
    }));
    return answers;
  };
  let answers = await search(words.join(" ") || name);
  if (answers.every((a) => a.models === null)) throw httpError("Civitai did not answer.", 502);
  const fitsOf = (m: ApiModel) => !wanted || wanted.includes(m.type ?? "");
  // a file's name says more than a model's: the model is found by its first words, then told apart by the rest
  for (const fewer of [3, 2, 1]) {
    if (answers.some((a) => a.models?.some(fitsOf)) || words.length <= fewer) continue;
    const less = await search(words.slice(0, fewer).join(" "));
    if (less.some((a) => a.models?.length)) answers = less;
  }

  const seen = new Set<number>();
  const items: CivitaiFound[] = [];
  for (const { site, models } of answers) {
    for (const m of models ?? []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const versions = m.modelVersions ?? [];
      // a version often has several files of the model (fp8, int8, GGUF…): the one whose name is closest, its main one when they tie
      const fileOf = (v: ApiVersion) => {
        const models = (v.files ?? []).filter((f) => STEM.test(f.name ?? ""));
        const near = (f: ApiFile) => words.filter((w) => squash(f.name ?? "").includes(squash(w))).length + (f.primary ? 0.5 : 0);
        return models.find((f) => f.name?.toLowerCase() === name.toLowerCase()) ?? [...models].sort((a, b) => near(b) - near(a))[0] ?? v.files?.[0];
      };
      const hitsOf = (v: ApiVersion) => {
        const text = squash([m.name, v.name ?? "", ...(v.files ?? []).map((f) => f.name ?? "")].join(" "));
        return words.filter((w) => text.includes(squash(w)));
      };
      const exactIn = versions.find((v) => v.files?.some((f) => f.name?.toLowerCase() === name.toLowerCase()));
      // the version that has the file itself; else the one whose names are closest; else the newest
      const version = exactIn ?? [...versions].sort((a, b) => hitsOf(b).length - hitsOf(a).length)[0];
      const picked = version ? fileOf(version) : undefined;
      items.push({
        name: m.name, kind: m.type ?? "", site: hostOf(site),
        // links go to the real sites even when a pretend one answered
        url: `${envSaid.civitaiUrl() ? "https://civitai.com" : site}/models/${m.id}`,
        version: version?.name ?? "", base: version?.baseModel ?? "", words: (version?.trainedWords ?? []).slice(0, 12),
        versionId: version?.id ?? null, file: picked?.name ?? "", bytes: Math.round((picked?.sizeKB ?? 0) * 1024),
        exact: Boolean(exactIn), fits: fitsOf(m), hits: version ? hitsOf(version) : [], of: words.length,
      });
    }
  }
  const rank = (i: CivitaiFound) => (i.exact ? 1000 : 0) + (i.fits ? 100 : 0) + i.hits.length;
  const sorted = items.map((item, at) => ({ item, at })).sort((a, b) => rank(b.item) - rank(a.item) || a.at - b.at).map((x) => x.item);
  // what is not the right kind of thing is only shown when nothing else was found
  const right = sorted.filter((i) => i.fits || i.exact);
  return {
    items: (right.length ? right : sorted).slice(0, 8),
    asked: answers.filter((a) => a.models !== null).map((a) => hostOf(a.site)),
    silent: answers.filter((a) => a.models === null).map((a) => hostOf(a.site)),
  };
}

/** One thing asked of Civitai's API, from whichever of its sites has it. Null when neither knows it. */
export async function civitaiGet<T>(path: string, key: string): Promise<T | null> {
  let failed: Error | null = null;
  for (const site of civitaiSites()) {
    try {
      const res = await ask(`${site}${path}`, key);
      if (res.status === 404) continue;
      if (!res.ok) {
        failed = httpError(`Civitai refused (${res.status}).`, 502);
        continue;
      }
      return (await res.json()) as T;
    } catch (err) {
      failed = httpError(`Civitai did not answer: ${(err as Error).message}`, 502);
    }
  }
  if (failed) throw failed;
  return null;
}

/** One version by its number, from whichever site has it, with the file a download of it fetches. */
export async function civitaiVersion(id: number, wanted: string, key: string): Promise<{ title: string; file: ApiFile } | null> {
  let failed: Error | null = null;
  for (const site of civitaiSites()) {
    let res: Response;
    try {
      res = await ask(`${site}/api/v1/model-versions/${id}`, key);
    } catch (err) {
      failed = httpError(`Civitai did not answer: ${(err as Error).message}`, 502);
      continue;
    }
    if (res.status === 404) continue;
    if (!res.ok) {
      failed = httpError(`Civitai refused (${res.status}).`, 502);
      continue;
    }
    const v = (await res.json()) as ApiVersion;
    const files = (v.files ?? []).filter((f) => f.downloadUrl && STEM.test(f.name ?? ""));
    // the file of that very name when the version has it, else the one the lookup showed: the closest name, its main file on a tie
    const words = wordsOf(wanted);
    const near = (f: ApiFile) => words.filter((w) => squash(f.name ?? "").includes(squash(w))).length + (f.primary ? 0.5 : 0);
    const file = files.find((f) => f.name?.toLowerCase() === wanted.toLowerCase()) ?? [...files].sort((a, b) => near(b) - near(a))[0];
    if (!file) return null;
    return { title: [v.model?.name, v.name].filter(Boolean).join(" · "), file };
  }
  if (failed) throw failed;
  return null;
}
