import { envSaid } from "./config";
import { pretendSites, wordsOf } from "./civitai";
import { fetchPublic } from "./outbound";

/**
 * Looking for a file on Hugging Face by its exact name. Unlike Civitai, where models are found by words
 * and the files are renamed, the files ComfyUI's loaders are usually pointed at (text readers, VAEs, the
 * repacked models) sit on Hugging Face under the very names workflows use. So only exact names count
 * here: what is found is the file itself, not something like it.
 */

export interface HuggingFaceFound {
  /** "Comfy-Org/Krea-2" */
  repo: string;
  /** The file's place in the repository. */
  path: string;
  /** Where the file itself is fetched from. */
  url: string;
  /** The repository's page. */
  page: string;
  /** How often the repository was downloaded: the well-known one is usually the right one. */
  downloads: number;
  /** A file whose download needs an account that accepted the repository's terms. */
  gated: boolean;
}

type Repo = { id: string; downloads?: number; gated?: boolean | string; siblings?: Array<{ rfilename: string }> };

const site = () => (envSaid.huggingfaceUrl() ?? "https://huggingface.co").replace(/\/+$/, "");
const KEEP_MS = 60 * 60_000;
let official: { at: number; repos: Promise<Repo[]> } | null = null;

async function list(params: Record<string, string>): Promise<Repo[]> {
  // a redirect is judged hop by hop (outbound.ts), as a download's is
  const res = await fetchPublic(`${site()}/api/models?${new URLSearchParams({ ...params, full: "true" })}`, { headers: { "User-Agent": "afflatus" }, signal: AbortSignal.timeout(20_000) }, [site()]);
  if (!res.ok) throw new Error(`Hugging Face answered HTTP ${res.status}`);
  return ((await res.json().catch(() => [])) as Repo[]) ?? [];
}

/** For the tests: forget what was learned about the repositories. */
export function forgetHuggingFace(): void {
  official = null;
}

/**
 * The repositories that hold a file of exactly this name, the most downloaded first. Two places are
 * looked in: the repositories of Comfy-Org (ComfyUI's own repacks, where most standard files are; their
 * list is kept for an hour), and the repositories found by the words given: the first words of the
 * file's name, and any others that say which model it is for (a loader's "type", the name of the model).
 */
export async function findOnHuggingFace(file: string, hints: string[] = []): Promise<{ items: HuggingFaceFound[]; answered: boolean }> {
  const name = (file.split(/[\\/]/).pop() ?? file).toLowerCase();
  // where a pretend Civitai stands in (the tests, the demo), the real Hugging Face is not asked either
  if (pretendSites() && !envSaid.huggingfaceUrl()) return { items: [], answered: false };
  if (!official || Date.now() - official.at > KEEP_MS) {
    official = { at: Date.now(), repos: list({ author: "Comfy-Org", limit: "500" }) };
    official.repos.catch(() => (official = null));
  }
  const words = wordsOf(name);
  const queries = [...new Set([words.slice(0, 2).join(" "), words[0] ?? "", ...hints.map((h) => h.trim().toLowerCase())].filter((q) => q.length >= 3))].slice(0, 5);
  const answers = await Promise.all([official.repos.catch(() => null), ...queries.map((q) => list({ search: q, limit: "40" }).catch(() => null))]);
  const seen = new Set<string>();
  const items: HuggingFaceFound[] = [];
  for (const repos of answers) {
    for (const r of repos ?? []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const hit = r.siblings?.find((s) => (s.rfilename.split("/").pop() ?? "").toLowerCase() === name);
      if (!hit) continue;
      items.push({
        repo: r.id, path: hit.rfilename, downloads: r.downloads ?? 0, gated: Boolean(r.gated),
        url: `${site()}/${r.id}/resolve/main/${hit.rfilename.split("/").map(encodeURIComponent).join("/")}`,
        page: `${site()}/${r.id}`,
      });
    }
  }
  // ComfyUI's own repositories first, then the most downloaded
  const rank = (i: HuggingFaceFound) => (i.repo.startsWith("Comfy-Org/") ? 1e12 : 0) + i.downloads;
  return { items: items.sort((a, b) => rank(b) - rank(a)).slice(0, 5), answered: answers.some((a) => a !== null) };
}
