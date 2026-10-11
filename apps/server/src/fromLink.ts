import { isModelFile } from "@afflatus/core";
import { civitaiGet, civitaiSites, pretendSites } from "./civitai";
import { httpError } from "./errors";
import { assertPublicUrl, fetchPublic } from "./outbound";

/**
 * A model from a link: the address of a model's page on Civitai, of one of its versions, or of a file
 * on Hugging Face (or anywhere, when the address ends in a model file's name). What the link leads to
 * is worked out here: its files with their sizes, and the ComfyUI folder it most likely belongs in. The
 * download itself is the usual one.
 */

export interface LinkFile {
  /** The name the site gives it. */
  name: string;
  bytes: number;
  /** What tells it apart from the others of the same version ("int8", "fp16 · pruned"). */
  note: string;
}

export interface LinkFound {
  source: "civitai" | "huggingface" | "address";
  title: string;
  /** What kind of thing the site says it is, and the model it is for ("Checkpoint · MiniMax H3"). */
  about: string;
  /** Its page, to remember for the file. */
  page: string;
  /** Civitai: the version the files belong to, and the others to choose from. */
  version?: number;
  versions?: Array<{ id: number; name: string }>;
  /** Anything else: the address the one file is fetched from. */
  url?: string;
  files: LinkFile[];
  /** The ComfyUI folder it most likely goes in, and why when that is not obvious. */
  folder: string | null;
  why?: string;
}

const FOLDER_OF_KIND: Record<string, string> = {
  Checkpoint: "checkpoints", LORA: "loras", LoCon: "loras", DoRA: "loras", VAE: "vae", TextEncoder: "text_encoders",
  Upscaler: "upscale_models", Controlnet: "controlnet", TextualInversion: "embeddings",
};
/** Families whose "checkpoints" are the diffusion model alone: ComfyUI loads those from diffusion_models. */
const ALONE = /flux|wan\b|wan ?\d|krea|minimax|(^|[^a-z0-9])h3([^a-z0-9]|$)|qwen|hunyuan|ltx|chroma|z.?image|lumina|hidream|cosmos|aura/i;
/** ComfyUI's folder names, as they appear in the path of a file on Hugging Face. */
const KNOWN_FOLDERS = ["checkpoints", "diffusion_models", "unet", "loras", "vae", "text_encoders", "clip", "clip_vision", "upscale_models", "controlnet", "embeddings", "model_patches", "audio_encoders"];

type ApiFile = { name?: string; sizeKB?: number; type?: string; metadata?: { fp?: string | null; size?: string | null; format?: string | null } };
type ApiVersion = { id: number; name?: string; baseModel?: string; modelId?: number; model?: { name?: string; type?: string }; files?: ApiFile[] };
type ApiModel = { id: number; name: string; type?: string; modelVersions?: ApiVersion[] };

const bad = (message: string) => httpError(message);

export async function resolveLink(link: string, key: string): Promise<LinkFound> {
  let at: URL;
  try {
    at = new URL(link.trim());
  } catch {
    throw bad("That is not an address. Paste the address of a model's page on Civitai, or of a file on Hugging Face.");
  }
  if (/(^|\.)civitai\.(com|red)$/i.test(at.hostname)) return fromCivitai(at, key);
  if (/(^|\.)huggingface\.co$/i.test(at.hostname) || /(^|\.)hf\.co$/i.test(at.hostname)) return fromHuggingFace(at);
  const name = decodeURIComponent(at.pathname.split("/").pop() ?? "");
  if (at.protocol === "https:" && isModelFile(name)) {
    // a file anywhere: anywhere on the internet, not inside this network
    assertPublicUrl(at.href, civitaiSites());
    return { source: "address", title: name, about: at.hostname, page: at.href, url: at.href, files: [{ name, bytes: await sizeOf(at.href), note: "" }], folder: null };
  }
  throw bad("Afflatus can fetch from a Civitai model page, a file on Hugging Face, or an https address that ends in a model file's name.");
}

async function fromCivitai(at: URL, key: string): Promise<LinkFound> {
  const versionId = Number(at.searchParams.get("modelVersionId") ?? /\/(?:model-versions|api\/download\/models)\/(\d+)/.exec(at.pathname)?.[1] ?? 0);
  const modelId = Number(/\/models\/(\d+)/.exec(at.pathname)?.[1] ?? 0);
  if (!versionId && !modelId) throw bad("That Civitai address does not name a model. Open the model's page and copy its address.");
  let model: ApiModel | null = modelId ? await civitaiGet<ApiModel>(`/api/v1/models/${modelId}`, key) : null;
  let version: ApiVersion | null | undefined = versionId ? model?.modelVersions?.find((v) => v.id === versionId) ?? (await civitaiGet<ApiVersion>(`/api/v1/model-versions/${versionId}`, key)) : model?.modelVersions?.[0];
  if (!version) throw httpError("Civitai does not show that model (it may be removed, or need an account: a Civitai key in Settings helps).", 404);
  // an address of a version alone: its model says what the other versions are
  if (!model && version.modelId) model = await civitaiGet<ApiModel>(`/api/v1/models/${version.modelId}`, key).catch(() => null);
  const kind = model?.type ?? version.model?.type ?? "";
  const base = version.baseModel ?? "";
  const name = model?.name ?? version.model?.name ?? "A model on Civitai";
  const files = (version.files ?? []).filter((f) => isModelFile(f.name ?? "")).map((f) => ({
    name: f.name!, bytes: Math.round((f.sizeKB ?? 0) * 1024),
    note: [f.metadata?.fp, f.metadata?.size, f.metadata?.format && f.metadata.format !== "SafeTensor" ? f.metadata.format : ""].filter(Boolean).join(" · "),
  }));
  if (!files.length) throw httpError("That version has no model file to download.", 404);
  const alone = kind === "Checkpoint" && ALONE.test(`${base} ${name}`);
  return {
    source: "civitai", title: [name, version.name].filter(Boolean).join(" · "), about: [kind, base].filter(Boolean).join(" · "),
    page: `https://civitai.com/models/${model?.id ?? version.modelId ?? modelId}?modelVersionId=${version.id}`,
    version: version.id, versions: (model?.modelVersions ?? []).map((v) => ({ id: v.id, name: v.name ?? String(v.id) })),
    files, folder: alone ? "diffusion_models" : FOLDER_OF_KIND[kind] ?? null,
    ...(alone ? { why: `Civitai calls it a checkpoint, but models for ${base || "this family"} are usually the diffusion model alone, which ComfyUI loads from diffusion_models. A full checkpoint goes in checkpoints.` } : {}),
  };
}

async function fromHuggingFace(at: URL): Promise<LinkFound> {
  // /<owner>/<repo>/resolve|blob/<revision>/<path to the file>
  const m = /^\/([^/]+)\/([^/]+)\/(?:resolve|blob)\/([^/]+)\/(.+)$/.exec(at.pathname);
  const name = decodeURIComponent(m?.[4]?.split("/").pop() ?? "");
  if (!m || !isModelFile(name)) throw bad("On Hugging Face, open the file itself (in \"Files and versions\") and copy its address: it ends in the file's name.");
  const [, owner, repo, revision, path] = m;
  const url = `https://huggingface.co/${owner}/${repo}/resolve/${revision}/${path}`;
  const folder = decodeURIComponent(path!).split("/").slice(0, -1).reverse().find((part) => KNOWN_FOLDERS.includes(part.toLowerCase()))?.toLowerCase() ?? null;
  return {
    source: "huggingface", title: name, about: `${owner}/${repo}`, page: `https://huggingface.co/${owner}/${repo}/blob/${revision}/${path}`, url,
    files: [{ name, bytes: await sizeOf(url), note: "" }], folder: folder === "unet" ? "diffusion_models" : folder === "clip" ? "text_encoders" : folder,
  };
}

/** How large a file is, asked without fetching it. 0 when the site does not say. */
async function sizeOf(url: string): Promise<number> {
  // where a pretend Civitai stands in (the tests, the demo), no other site is asked either
  if (pretendSites()) return 0;
  try {
    const res = await fetchPublic(url, { method: "HEAD", headers: { "User-Agent": "afflatus" }, signal: AbortSignal.timeout(15_000) });
    return Number(res.headers.get("x-linked-size") ?? res.headers.get("content-length") ?? 0) || 0;
  } catch {
    return 0;
  }
}
