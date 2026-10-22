import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { envSaid } from "./config";
import { civitaiSites, civitaiVersion, pretendSites } from "./civitai";
import type { Comfy } from "./comfy";
import type { DownloadView } from "./downloads";
import { httpError as bad } from "./errors";
import { fileName } from "./media";
import { webUrl } from "./modelPages";
import { assertPublicUrl } from "./outbound";
import { isOfficialFile } from "@afflatus/core";
import type { Services } from "./services";
import { readSettings, type Settings } from "./settings";

/**
 * Fetching one model file into ComfyUI: from Civitai (a version, and which of its files), or from the
 * address a workflow's author or a pack gives. Afflatus writes it into ComfyUI's folder itself when it can,
 * else ComfyUI's node pack or ComfyUI-Manager does (downloads.ts). Only when the user turned this on in
 * Settings. Used by the Download buttons and by packs.
 */

export const downloadBody = z.strictObject({
  // left empty for a Civitai version: the file keeps the name Civitai gives it
  file: z.string().max(400).default(""), folder: z.string().min(1).max(120),
  civitai: z.number().int().positive().optional(), url: z.string().url().max(2000).optional(),
  // of a Civitai version with several files: the one to fetch, by the name Civitai gives it
  pick: z.string().max(400).optional(),
  // the page it comes from, kept for the file: its name then leads there
  page: z.strictObject({ url: webUrl, title: z.string().max(300) }).optional(),
  // the ComfyUI it goes to, by its id (settings.ts machines); left out: the first
  machine: z.string().max(40).optional(),
});
export type DownloadBody = z.infer<typeof downloadBody>;

/** The address ComfyUI will fetch from: the one this page was opened at, unless one is set. */
function selfUrl(req: FastifyRequest): string {
  return envSaid.publicUrl()?.trim() || `${req.protocol}://${req.headers.host}`;
}

/** The ComfyUI a download goes to, with its folder on this computer (empty when it has none here): the one asked for, or the first. */
export async function downloadTarget(s: Services, settings: Settings, id: string | undefined): Promise<{ comfy: Comfy; dir: string; machine?: string }> {
  if (!id) {
    if (!settings.machines.length) throw bad("There is no ComfyUI to download into: add yours in Settings › ComfyUI.", 409);
    return { comfy: await s.comfy(), dir: settings.comfyDir };
  }
  const found = (await s.machines()).find((m) => m.machine.id === id);
  if (!found) throw bad("there is no ComfyUI with that id", 404);
  return { comfy: found.comfy, dir: found.machine.dir, machine: id };
}

export async function beginDownload(s: Services, req: FastifyRequest, b: DownloadBody): Promise<DownloadView> {
  const settings = await readSettings(s.db);
  // a family's official file, its Download pressed (a form, a Queue row, Settings › Models): the press is the consent, and the
  // address is the family's own, not a lookup. Anything else needs downloads and lookups turned on
  const official = isOfficialFile(s.registry.families(), b);
  if (!official && !settings.downloadModels) throw bad("Downloading into ComfyUI is turned off. Turn it on in Settings.");
  // "Lookups off" means Afflatus never contacts Civitai or Hugging Face, which is where model files come from
  if (!official && !settings.civitaiLookups) throw bad("Looking up models online is turned off. Turn on “Search Hugging Face and Civitai” in Settings › Models to fetch model files.");
  if (!b.civitai === !b.url) throw bad("a source is needed: a Civitai version or a URL");
  const { comfy, dir, machine } = await downloadTarget(s, settings, b.machine);
  const self = selfUrl(req);
  const local = (host: string) => /^(localhost|127\.|\[::1\]|::1)/.test(host);
  if (!envSaid.publicUrl() && local(new URL(self).hostname) && !local(new URL(comfy.url).hostname)) {
    throw bad("ComfyUI runs on another machine and cannot reach Afflatus at this URL. Open Afflatus by its network URL, or set PUBLIC_URL to it.");
  }
  const name = b.file.split(/[\\/]/).pop()!;
  const keepPage = async (saved: string) => {
    if (!b.page || !/^[\w-]{1,64}$/.test(b.folder)) return;
    const key = { folder: b.folder, name: fileName(saved) };
    await s.db.insertInto("model_pages").values({ ...key, url: b.page.url, title: b.page.title, found_at: new Date().toISOString() })
      .onConflict((oc) => oc.columns(["folder", "name"]).doUpdateSet({ url: b.page!.url, title: b.page!.title })).execute();
  };
  if (b.url) {
    if (!name) throw bad("no filename given");
    if (!/^https:\/\//.test(b.url) && !pretendSites()) throw bad("only https URLs are downloaded");
    // not an address inside this network, ComfyUI's machine included (a pretend Civitai in the tests and the demo is fine)
    assertPublicUrl(b.url, civitaiSites());
    // a gated model's file needs an account that accepted its terms: the user's Hugging Face token, to Hugging Face alone
    const hf = settings.huggingFaceToken && /^https:\/\/(huggingface\.co|hf\.co)\//i.test(b.url) ? { Authorization: `Bearer ${settings.huggingFaceToken}` } : undefined;
    const started = await s.downloads.start(comfy, self, { file: b.file, folder: b.folder, title: name, source: b.url, ...(hf ? { headers: hf } : {}), comfyDir: dir, machine });
    await keepPage(started.file);
    return started;
  }
  const found = await civitaiVersion(b.civitai!, b.pick ?? name, settings.civitaiKey);
  if (!found?.file.downloadUrl) throw bad("Civitai lists no file to download for that version.", 404);
  if (b.pick && found.file.name?.toLowerCase() !== b.pick.toLowerCase()) throw bad(`That version has no file called ${b.pick}.`, 404);
  const saveAs = b.file || (found.file.name ?? "model.safetensors").replace(/[\\/:*?"<>|]/g, "_");
  await keepPage(saveAs);
  return s.downloads.start(comfy, self, {
    file: saveAs, folder: b.folder, title: found.title || name,
    source: found.file.downloadUrl, headers: settings.civitaiKey ? { Authorization: `Bearer ${settings.civitaiKey}` } : undefined,
    total: Math.round((found.file.sizeKB ?? 0) * 1024), comfyDir: dir, machine,
  });
}
