import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { envSaid } from "./config";
import { civitaiSites, civitaiVersion, keyFor, pretendSites } from "./civitai";
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
  // of a Civitai version with several files: the one to fetch, by the name Civitai gives it where it was seen, and by its
  // SHA-256 and Civitai's id for it when known (Civitai's search and its version page name the same file differently)
  pick: z.string().max(400).optional(),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(), fileId: z.number().int().positive().optional(),
  // the page it comes from, kept for the file: its name then leads there
  page: z.strictObject({ url: webUrl, title: z.string().max(300) }).optional(),
  // the ComfyUI it goes to, by its id (settings.ts machines); left out: the first
  machine: z.string().max(40).optional(),
});
export type DownloadBody = z.infer<typeof downloadBody>;

/** The address ComfyUI will fetch from: the one this page was opened at, unless one is set. */
export function selfUrl(req: FastifyRequest): string {
  return envSaid.publicUrl()?.trim() || `${req.protocol}://${req.headers.host}`;
}

/** The ComfyUI a download goes to, with its folder on this computer (empty when it has none here): the one asked for, or the first. */
export async function downloadTarget(s: Services, settings: Settings, id: string | undefined): Promise<{ comfy: Comfy; dir: string; machine?: string }> {
  if (!id) {
    if (!settings.machines.length) throw bad("There is no ComfyUI to download into: add yours in Settings › ComfyUI.", 409);
    return { comfy: await s.comfy(), dir: settings.comfyDir };
  }
  const found = (await s.machines()).find((m) => m.machine.id === id);
  if (!found) throw bad("That ComfyUI is no longer in Settings › ComfyUI: pick another one to download into.", 409);
  return { comfy: found.comfy, dir: found.machine.dir, machine: id };
}

/**
 * `from`: the request it was asked with, or the address it was asked from then (a download asked again after a restart).
 * What it was asked with is kept with it: a restart while it waits asks it again, and a failed one has a Try again.
 */
export async function beginDownload(s: Services, from: FastifyRequest | string, b: DownloadBody): Promise<DownloadView> {
  const settings = await readSettings(s.db);
  // a family's official file, its Download pressed (a form, a Queue row, Settings › Models): the press is the consent, and the
  // address is the family's own, not a lookup. Anything else needs downloads turned on; "Search Hugging Face and Civitai"
  // covers only what Afflatus asks on its own, and a Download (a file Find models showed, a link pasted) is the user asking (card #166)
  const official = isOfficialFile(s.registry.families(), b);
  if (!official && !settings.downloadModels) throw bad("Downloading into ComfyUI is turned off. Turn on “Download missing models” in Settings › Models.");
  if (!b.civitai === !b.url) throw bad("a source is needed: a Civitai version or a URL");
  const { comfy, dir, machine } = await downloadTarget(s, settings, b.machine);
  const self = typeof from === "string" ? from : selfUrl(from);
  const local = (host: string) => /^(localhost|127\.|\[::1\]|::1)/.test(host);
  if (!envSaid.publicUrl() && local(new URL(self).hostname) && !local(new URL(comfy.url).hostname)) {
    throw bad("ComfyUI runs on another machine and cannot reach Afflatus at this URL. Open Afflatus by its network URL, or set PUBLIC_URL to it.");
  }
  const name = b.file.split(/[\\/]/).pop()!;
  // the place chosen for this folder on this machine (Settings › Models), and what it was asked with
  const place = settings.downloadPlaces[machine ?? settings.machines[0]?.id ?? ""]?.[b.folder];
  const kept = { ask: b, ...(place ? { place } : {}) };
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
    // the user's own account for the site the file is on, to that site alone (keyFor)
    const key = keyFor(b.url, settings);
    const started = await s.downloads.start(comfy, self, { file: b.file, folder: b.folder, title: name, source: b.url, ...(key ? { headers: key } : {}), comfyDir: dir, machine, ...kept });
    await keepPage(started.file);
    return started;
  }
  // 409, not 404: the route is there, it is Civitai's answer that changed (a 404 reads as a missing route in the console)
  const gone = `Civitai no longer lists ${b.pick ?? "that file"} for this version: open it again in Find models.`;
  const found = await civitaiVersion(b.civitai!, b.pick ?? name, settings.civitaiKey, { sha256: b.sha256, fileId: b.fileId });
  if (!found?.file.downloadUrl) throw bad(b.pick || b.sha256 || b.fileId ? gone : "Civitai lists no file to download for that version: open it again in Find models.", 409);
  // a file asked by its name alone is that very file, not only the closest name
  if (b.pick && found.by === "near") throw bad(gone, 409);
  // under the name the user saw it by: "on this PC", presets and forms know it by that name, not the version page's
  const saveAs = b.file || (b.pick ?? found.file.name ?? "model.safetensors").replace(/[\\/:*?"<>|]/g, "_");
  await keepPage(saveAs);
  return s.downloads.start(comfy, self, {
    file: saveAs, folder: b.folder, title: found.title || name,
    source: found.file.downloadUrl, headers: settings.civitaiKey ? { Authorization: `Bearer ${settings.civitaiKey}` } : undefined,
    total: Math.round((found.file.sizeKB ?? 0) * 1024), comfyDir: dir, machine, ...kept,
  });
}
