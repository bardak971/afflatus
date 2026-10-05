import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { civitaiSites, civitaiVersion } from "./civitai";
import type { DownloadView } from "./downloads";
import { httpError as bad } from "./errors";
import { fileName } from "./media";
import { assertPublicUrl, hostnameOf } from "./outbound";
import type { Services } from "./services";
import { readSettings } from "./settings";

/**
 * Fetching one model file into ComfyUI: from Civitai (a version, and which of its files), or from the
 * address a workflow's author or a pack gives. ComfyUI-Manager does the saving; Afflatus passes the bytes
 * through. Only when the user turned this on in Settings. Used by the Download buttons and by packs.
 */

export const downloadBody = z.strictObject({
  // left empty for a Civitai version: the file keeps the name Civitai gives it
  file: z.string().max(400).default(""), folder: z.string().min(1).max(120),
  civitai: z.number().int().positive().optional(), url: z.string().url().max(2000).optional(),
  // of a Civitai version with several files: the one to fetch, by the name Civitai gives it
  pick: z.string().max(400).optional(),
  // the page it comes from, kept for the file: its name then leads there
  page: z.strictObject({ url: z.string().url().max(2000), title: z.string().max(300) }).optional(),
});
export type DownloadBody = z.infer<typeof downloadBody>;

/** The address ComfyUI will fetch from: the one this page was opened at, unless one is set. */
function selfUrl(req: FastifyRequest): string {
  return process.env.PUBLIC_URL?.trim() || `${req.protocol}://${req.headers.host}`;
}

export async function beginDownload(s: Services, req: FastifyRequest, b: DownloadBody): Promise<DownloadView> {
  const settings = await readSettings(s.db);
  if (!settings.downloadModels) throw bad("Downloading into ComfyUI is turned off. Turn it on in Settings.");
  // "Lookups off" means Afflatus never contacts Civitai or Hugging Face, which is where model files come from
  if (!settings.civitaiLookups) throw bad("Looking up models online is turned off. Turn on Civitai lookups in Settings to fetch model files.");
  if (!b.civitai === !b.url) throw bad("a source is needed: a Civitai version or a URL");
  const comfy = await s.comfy();
  const self = selfUrl(req);
  const local = (host: string) => /^(localhost|127\.|\[::1\]|::1)/.test(host);
  if (!process.env.PUBLIC_URL && local(new URL(self).hostname) && !local(new URL(comfy.url).hostname)) {
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
    if (!/^https:\/\//.test(b.url) && !process.env.CIVITAI_URL) throw bad("only https URLs are downloaded");
    // not an address inside this network (ComfyUI's own machine, and a pretend Civitai in the tests, are fine)
    assertPublicUrl(b.url, [hostnameOf(comfy.url), ...civitaiSites().map(hostnameOf)]);
    const started = await s.downloads.start(comfy, self, { file: b.file, folder: b.folder, title: name, source: b.url });
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
    total: Math.round((found.file.sizeKB ?? 0) * 1024),
  });
}
