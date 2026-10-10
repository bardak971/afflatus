import { folderOfFileInput } from "@afflatus/core";
import type { FileSource } from "@afflatus/workflows";
import { civitaiGet, KINDS, pretendSites, squash, STEM, wordsOf, type ApiFile, type ApiModel, type ApiVersion } from "./civitai";

/**
 * Where a missing model file can be had, worked out before anyone searches. Three places, in order:
 * ComfyUI-Manager's list of standard files (detectors, SAM, upscalers, VAEs, text encoders…), which
 * gives the address outright; the links the workflow's author left in its notes, when they point at
 * Civitai model pages (often with the very version); and that author's other models on Civitai, for
 * the files the notes do not name. Only when lookups are on: Civitai and GitHub are asked.
 */

const LIST_URL = "https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/model-list.json";
const KEEP_MS = 60 * 60_000;
type Known = { name: string; filename: string; url: string; save_path?: string; type?: string };
let known: { at: number; list: Promise<Map<string, Known>> } | null = null;

/** Manager's list of standard model files, by lower-case file name; kept an hour. Empty where a pretend Civitai stands in (the tests, the demo), unless a list is given. */
export async function knownFiles(): Promise<Map<string, Known>> {
  const url = process.env.MODEL_LIST_URL ?? (pretendSites() ? null : LIST_URL);
  if (!url) return new Map();
  if (!known || Date.now() - known.at > KEEP_MS) {
    const list = (async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`model list: ${res.status}`);
      const body = (await res.json()) as { models?: Known[] };
      const map = new Map<string, Known>();
      for (const m of body.models ?? []) if (m.filename && m.url && !map.has(m.filename.toLowerCase())) map.set(m.filename.toLowerCase(), m);
      return map;
    })();
    known = { at: Date.now(), list };
    list.catch(() => (known = null));
  }
  return known.list.catch(() => new Map());
}

type Missing = { node: string; input: string; classType: string; file: string; url?: string };
type Model = ApiModel & { creator?: { username?: string } };
type Pool = Array<{ model: Model; version?: number }>;

const baseOf = (file: string) => file.split(/[\\/]/).pop() ?? file;
const modelFiles = (v: ApiVersion) => (v.files ?? []).filter((f) => STEM.test(f.name ?? ""));

/**
 * How well a model answers for a file: a version with the file itself (exact), else the version linked
 * to, else the one whose names hold most words of the file's name; and the file of that version to take.
 */
function match(m: Model, wanted: string, prefer?: number) {
  const words = wordsOf(wanted);
  const versions = m.modelVersions ?? [];
  const exactIn = versions.find((v) => modelFiles(v).some((f) => f.name?.toLowerCase() === wanted.toLowerCase()));
  const hitsOf = (v: ApiVersion) => {
    const text = squash([m.name, v.name ?? "", ...modelFiles(v).map((f) => f.name ?? "")].join(" "));
    return words.filter((w) => text.includes(squash(w))).length;
  };
  const version = exactIn ?? versions.find((v) => v.id === prefer) ?? [...versions].sort((a, b) => hitsOf(b) - hitsOf(a))[0];
  if (!version) return null;
  const near = (f: ApiFile) => words.filter((w) => squash(f.name ?? "").includes(squash(w))).length + (f.primary ? 0.5 : 0);
  const file = modelFiles(version).find((f) => f.name?.toLowerCase() === wanted.toLowerCase()) ?? [...modelFiles(version)].sort((a, b) => near(b) - near(a))[0];
  if (!file?.name) return null;
  return { exact: Boolean(exactIn), hits: hitsOf(version), of: words.length, version, file };
}

/** The best of a pool of models for a file: the right kind for its folder, the file itself first, else enough of the name's words. */
function best(m: Missing, pool: Pool, how: FileSource["how"]): FileSource | null {
  const folder = folderOfFileInput(m.classType, m.input);
  const kinds = folder ? KINDS[folder] : undefined;
  const name = baseOf(m.file);
  let top: { score: number; src: FileSource } | null = null;
  for (const { model, version } of pool) {
    if (kinds && !kinds.includes(model.type ?? "")) continue;
    const r = match(model, name, version);
    if (!r) continue;
    // a third of the words at least: "babes illustrious … dmd2" is the model, "babes" alone is not
    if (!r.exact && r.hits < Math.max(2, Math.ceil(r.of / 3))) continue;
    const score = (r.exact ? 1000 : 0) + r.hits;
    if (!top || score > top.score) {
      top = { score, src: { how, title: [model.name, r.version.name].filter(Boolean).join(" · "), file: r.file.name!, exact: r.exact, page: `https://civitai.com/models/${model.id}`, ...(r.version.id ? { civitai: r.version.id } : {}) } };
    }
  }
  return top?.src ?? null;
}

/** A source for each missing file that has one, by "node.input". Files the workflow itself gives an address for are left alone. */
export async function sourcesFor(missing: Missing[], links: Array<{ url: string }>, key: string): Promise<Record<string, FileSource>> {
  const out: Record<string, FileSource> = {};
  const keyOf = (m: Missing) => `${m.node}.${m.input}`;
  const todo = missing.filter((m) => !m.url);
  if (!todo.length) return out;

  // 1. standard files, by their name
  const list = await knownFiles();
  for (const m of todo) {
    const k = list.get(baseOf(m.file).toLowerCase());
    if (k) out[keyOf(m)] = { how: "known", title: k.name, file: k.filename, exact: true, url: k.url };
  }
  if (todo.every((m) => out[keyOf(m)])) return out;

  // 2. the author's links to Civitai model pages, with the version when the link says
  const linked = new Map<number, number | undefined>();
  for (const l of links) {
    const m = /civitai\.(?:com|red|green)\/models\/(\d+)(?:[^\s#]*?[?&]modelVersionId=(\d+))?/i.exec(l.url);
    if (m && !linked.has(Number(m[1])) && linked.size < 8) linked.set(Number(m[1]), m[2] ? Number(m[2]) : undefined);
  }
  const fetched = await Promise.all([...linked].map(async ([id, version]) => ({ model: await civitaiGet<Model>(`/api/v1/models/${id}`, key).catch(() => null), version })));
  const models: Pool = fetched.flatMap((f) => (f.model ? [{ model: f.model, version: f.version }] : []));
  for (const m of todo) {
    if (out[keyOf(m)]) continue;
    const src = best(m, models, "notes");
    if (src) out[keyOf(m)] = src;
  }

  // 3. the same authors' other models of the kind the folder holds, for what is still not settled by its own name
  const creators = [...new Set(models.map((x) => x.model.creator?.username).filter((u): u is string => Boolean(u)))].slice(0, 2);
  const lists = new Map<string, Promise<Model[]>>();
  const byCreator = (user: string, kinds: string[] | undefined) => {
    const k = `${user}|${(kinds ?? []).join(",")}`;
    if (!lists.has(k)) {
      const params = new URLSearchParams({ username: user, limit: "100", nsfw: "true" });
      for (const kind of kinds ?? []) params.append("types", kind);
      lists.set(k, civitaiGet<{ items?: Model[] }>(`/api/v1/models?${params}`, key).then((r) => r?.items ?? []).catch(() => []));
    }
    return lists.get(k)!;
  };
  for (const m of todo) {
    const have = out[keyOf(m)];
    if (have?.exact) continue;
    const folder = folderOfFileInput(m.classType, m.input);
    for (const user of creators) {
      const pool: Pool = (await byCreator(user, folder ? KINDS[folder] : undefined)).map((model) => ({ model }));
      const src = best(m, pool, "creator");
      // the author's own pointer stands unless the file itself turns up
      if (src && (src.exact || !have)) {
        out[keyOf(m)] = src;
        if (src.exact) break;
      }
    }
  }
  return out;
}
