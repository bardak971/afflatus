import { plural } from "@afflatus/core";
import { z } from "zod";
import { browseCivitai, browseHuggingFace, civitaiQuery, huggingFaceQuery, known, lookupsOnFor, repoFiles, type BrowseCard, type BrowseFile } from "./browse";
import { withoutPaths, type DownloadView } from "./downloads";
import { httpError } from "./errors";
import { beginDownload, downloadBody } from "./fetchFile";
import { familyIsOn, formArgs, formAsked, machineName, machineOf, seen, statusOf } from "./mcpForms";
import { quoted, tool, type ToolCtx } from "./mcpTool";
import { refusal } from "./mcpTokens";
import { modelSetsOf } from "./modelSets";
import { saveModelSettings } from "./modelSettings";
import { licencesPending, presetsWithFiles } from "./presetFiles";
import type { Services } from "./services";
import { readSettings, type Machine } from "./settings";
import { OWNER } from "./db";

/**
 * The models, from outside (MCP): what each machine has (families, files, LoRAs) and the licences the user accepted; Find
 * models (Civitai, Hugging Face, the user's own, what a form lacks); downloads into a ComfyUI or onto a pod through the
 * downloads' own line (fetchFile.ts beginDownload: its switches, sizes and sums, a gated file with the user's Hugging Face
 * token); the Model sets; and the values saved per model file. Each through the route's own code.
 *
 * A licence is the user's to accept, never an agent's: a file a preset puts under a licence not accepted yet is refused,
 * with the licence named, and the user accepts it in Afflatus (the preset, a Model set's Get, the Deploy dialog). Anything
 * fetched onto a rented pod keeps it busy, so billed: that needs Spend, and room under the token's cap.
 */

/** Files listed of one folder on one machine, at most: a LoRA folder can hold thousands. */
const FILES_SHOWN = 200;

const listModels = tool({
  name: "list_models",
  scope: "look",
  title: "Models",
  description: "The models each machine has. Without arguments: every model family, whether it is on, and on each machine whether it is ready and which of its usual files it lacks; and the presets whose licence the user accepted. `family`: its slots on each machine (the file in use, the ones that fit, its usual file and address). `folder` (checkpoints, loras, diffusion_models, text_encoders, vae, upscale_models…): its files on each machine, filtered by `q`.",
  input: {
    family: z.string().max(120).optional().describe("A family's id (list_forms names them)."),
    folder: z.string().max(120).optional().describe("A ComfyUI model folder."),
    q: z.string().max(200).optional().describe("Words a file's name has (with folder)."),
  },
  async run(a, ctx) {
    const { s } = ctx;
    const at = await seen(s);
    if (a.folder) {
      const words = (a.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const machines = await Promise.all(at.machines.map(async ({ machine }) => {
        const comfy = (await s.machines()).find((m) => m.machine.id === machine.id)?.comfy;
        const files = comfy ? await comfy.client.models(a.folder!).catch(() => null) : null;
        const hits = files?.filter((f) => words.every((w) => f.toLowerCase().includes(w))) ?? null;
        return { id: machine.id, name: machineName(machine), files: hits?.slice(0, FILES_SHOWN) ?? null, ...(hits && hits.length > FILES_SHOWN ? { more: hits.length - FILES_SHOWN } : {}), ...(files ? {} : { said: "not answering" }) };
      }));
      ctx.said(`Looked at the ${quoted(a.folder)} files${a.q ? ` with ${quoted(a.q)}` : ""}`);
      return { folder: a.folder, machines };
    }
    const families = s.registry.families().filter((f) => !f.imported && (!a.family || f.id === a.family));
    if (a.family && !families.length) throw httpError(`There is no model family called ${a.family}: list_models without arguments lists them.`, 404);
    const accepted = new Set(at.settings.acceptedPresets);
    const licences = (await presetsWithFiles(s)).filter((p) => p.licence && accepted.has(p.id)).map((p) => ({ preset: p.name, licence: p.licence!.name }));
    ctx.said(a.family ? `Looked at the family ${quoted(a.family)}` : `Looked at the models: ${plural(families.length, "family", "families")}`);
    return {
      families: families.map((f) => ({
        id: f.id, name: f.name, on: familyIsOn(s, at, f.id),
        machines: at.machines.map(({ machine, scan }) => {
          const fam = scan?.families.find((x) => x.id === f.id);
          const forms = scan?.recipes.filter((r) => s.registry.recipe(r.id)?.family === f.id) ?? [];
          const lacks = fam?.slots.filter((x) => !x.file && !x.optional).map((x) => x.label) ?? [];
          return {
            id: machine.id, name: machineName(machine),
            ...(scan ? { ready: forms.some((r) => r.ready), formsReady: `${forms.filter((r) => r.ready).length} of ${forms.length}`, ...(lacks.length ? { lacks } : {}) } : { said: "not answering" }),
            ...(machine.families[f.id] !== undefined ? { switchedHere: machine.families[f.id] } : {}),
            ...(a.family && fam ? { slots: fam.slots.map((x) => ({ id: x.id, label: x.label, folder: x.folder, file: x.file, ...(x.chosen ? { chosenByHand: true } : {}), fits: x.choices.slice(0, 20), ...(x.optional ? { optional: true } : {}), ...(x.get ? { usual: x.get } : {}) })) } : {}),
          };
        }),
      })),
      ...(a.family ? {} : { licencesAccepted: licences }),
    };
  },
});

/** A file of Find models as the tools say it, with what download takes for it (an address, or a Civitai version and pick). */
const fileSaid = (f: BrowseFile) => ({
  name: f.name, bytes: f.bytes, ...(f.note ? { note: f.note } : {}), folder: f.folder, ...(f.sha256 ? { sha256: f.sha256 } : {}), ...(f.have.length ? { have: true } : {}),
  download: f.source.kind === "url" ? { url: f.source.url } : { civitai: f.source.version, pick: f.source.pick },
});

/** A card of Find models as the tools say it: the model, whether the user has it, and its newest versions' files. */
function cardSaid(c: BrowseCard) {
  return {
    site: c.site, id: c.id, name: c.name, type: c.type, base: c.base, creator: c.creator, downloads: c.downloads, page: c.page,
    ...(c.fits ? { fits: c.fits } : {}), ...(c.have ? { have: true } : {}), ...(c.update ? { update: c.update } : {}), ...(c.gated ? { gated: true } : {}),
    licence: c.licence,
    ...(c.versions.length ? { versions: c.versions.slice(0, 3).map((v) => ({ id: v.id, name: v.name, base: v.base, ...(v.trainedWords.length ? { trainedWords: v.trainedWords.slice(0, 12) } : {}), files: v.files.slice(0, 6).map(fileSaid) })) } : {}),
    ...(c.modelFiles !== undefined ? { modelFiles: c.modelFiles } : {}),
  };
}

const findModels = tool({
  name: "find_models",
  scope: "look",
  title: "Find models",
  description: "Find models as the app's Find models does. `civitai`: Civitai's models for words, types (LORA, Checkpoint…), base models and order, a page at a time (`cursor`). `huggingface`: Hugging Face's repositories (ComfyUI's single files, LoRAs, or anything), then `repo` lists one repository's model files with their sizes and SHA-256. `yours`: the user's presets, families' usual files and model files on this PC. `lacks`: what a draft or a form lacks to render (its family's files, the files and node packs it names), with each usual file's address. Civitai and Hugging Face need Search Hugging Face and Civitai on in Settings › Models. Each file says its folder and size; download fetches it.",
  input: {
    site: z.enum(["civitai", "huggingface", "repo", "yours", "lacks"]),
    q: z.string().max(200).optional().describe("Words (civitai, huggingface, yours); a repository owner/name (repo)."),
    types: z.array(z.string().max(40)).max(10).optional().describe("Civitai's types: LORA, Checkpoint, Upscaler…"),
    bases: z.array(z.string().max(80)).max(10).optional().describe("Civitai's base models (\"Flux.1 D\", \"Wan Video 2.2 I2V-A14B\")."),
    sort: z.string().max(40).optional().describe("Civitai: Most Downloaded, Highest Rated, Newest; Hugging Face: downloads, likes, lastModified, trendingScore."),
    kind: z.enum(["comfyui", "loras", "all"]).optional().describe("Hugging Face: ComfyUI's single files, LoRAs, or anything."),
    cursor: z.string().max(400).optional().describe("The next page, as the last answer gave it."),
    ...formArgs,
  },
  async run(a, ctx) {
    const { s } = ctx;
    if (a.site === "civitai") {
      const got = await browseCivitai(s, civitaiQuery.parse({ q: a.q ?? "", ...(a.types ? { types: a.types } : {}), ...(a.bases ? { bases: a.bases } : {}), ...(a.sort ? { sort: a.sort } : {}), ...(a.cursor ? { cursor: a.cursor } : {}) }));
      ctx.said(`Searched Civitai${a.q ? ` for ${quoted(a.q)}` : ""}: ${got.items.length}`);
      return { items: got.items.map(cardSaid), next: got.next };
    }
    if (a.site === "huggingface") {
      const got = await browseHuggingFace(s, huggingFaceQuery.parse({ q: a.q ?? "", ...(a.kind ? { kind: a.kind } : {}), ...(a.sort ? { sort: a.sort } : {}), ...(a.cursor ? { cursor: a.cursor } : {}) }));
      ctx.said(`Searched Hugging Face${a.q ? ` for ${quoted(a.q)}` : ""}: ${got.items.length}`);
      return { items: got.items.map(cardSaid), next: got.next, said: "repo with a repository's id lists its model files." };
    }
    if (a.site === "repo") {
      if (!a.q || !/^[\w.-]+\/[\w.-]+$/.test(a.q)) throw httpError("A repository is owner/name, as huggingface lists it.");
      const settings = await lookupsOnFor(s);
      const files = await repoFiles(a.q, settings.huggingFaceToken, await known(s));
      ctx.said(`Opened the repository ${quoted(a.q)}: ${plural(files.length, "file")}`);
      return { repo: a.q, files: files.map(fileSaid) };
    }
    if (a.site === "yours") {
      const got = await modelSetsOf(s).search(a.q ?? "", true);
      ctx.said(`Looked through the user's models${a.q ? ` for ${quoted(a.q)}` : ""}`);
      return got;
    }
    // what a form lacks: its family's files, the files and node packs it names, as Create's lacks line says them
    const asked = await formAsked(s, a);
    const at = await seen(s);
    const st = statusOf(at, asked.recipe.id);
    const fam = at.machines.flatMap((m) => m.scan?.families.filter((f) => f.id === asked.recipe.family) ?? [])[0];
    const slots = fam?.slots.filter((x) => st?.missingSlots.includes(x.id)) ?? [];
    ctx.said(`Looked at what ${quoted(asked.name)} lacks`);
    return {
      form: asked.recipe.id, ready: st?.ready ?? false,
      files: [...slots.map((x) => ({ slot: x.label, folder: x.folder, ...(x.get ? { file: x.get.file, url: x.get.url } : {}) })), ...(st?.missing ?? []).map((f) => ({ file: f.file, folder: f.folder, ...(f.url ? { url: f.url } : {}) }))],
      nodes: st?.missingNodes ?? [],
      ...(st?.problems.length ? { problems: st.problems } : {}),
      ...(st?.limitedBy.length ? { optionsOffFor: st.limitedBy } : {}),
    };
  },
});

/**
 * The machine a download or a Model set's Get goes to: the one asked for, else the first machine, as the downloads line
 * and the sets pick it (fetchFile.ts downloadTarget, modelSets.ts get). Worked out before the Spend check: the first
 * machine of a setup with rented GPUs only is a pod.
 */
async function targetOf(s: Services, asked: string | undefined): Promise<Machine | undefined> {
  if (asked) return machineOf(await seen(s), asked);
  return (await s.machines())[0]?.machine;
}

/** Whether this token may have files fetched onto a rented pod: Spend, and room left under its cap. A pod fetching is busy, billed. */
async function mayFetchOnto(ctx: ToolCtx, m: Machine | undefined): Promise<void> {
  if (!m?.rented) return;
  if (!ctx.token.scopes.includes("spend")) throw refusal(`This token cannot spend on rented GPUs, and ${machineName(m)} is one: a pod fetching files is busy, billed. Tick Spend on it in Settings › Interface › Access, or fetch onto a machine of the user's own.`);
  await ctx.maySpend(0);
}

/** Refused when a file comes under a preset's licence the user has not accepted: the user accepts it, never an agent. */
async function licenceFree(s: Services, files: Array<{ folder: string; file: string }>): Promise<void> {
  const pending = await licencesPending(s, files);
  if (pending.length) throw refusal(`${pending.map((p) => `${p.name} comes under the ${p.licence!.name}`).join("; ")}: the user accepts it in Afflatus (the preset, a Model set's Get, or the Deploy dialog), never an agent for them.`);
}

/** A download as the tools say it: never the folder on disk it is written into, nor one in what went wrong. */
const downloadSaid = (d: DownloadView) => ({
  id: d.id, file: d.file, folder: d.folder, title: d.title, status: d.status, bytes: d.bytes, total: d.total,
  ...(d.error ? { error: withoutPaths(d.error) } : {}), ...(d.waiting ? { waiting: withoutPaths(d.waiting) } : {}), ...(d.via ? { via: d.via } : {}), ...(d.note ? { note: withoutPaths(d.note) } : {}), ...(d.machine ? { machine: d.machine } : {}),
});

const download = tool({
  name: "download",
  scope: "manage",
  title: "Download a model",
  description: "Fetch a model file into a ComfyUI of the user's own or onto a rented pod, through the app's downloads line with its checks: from an address (Hugging Face, a direct https link; a gated Hugging Face file with the user's token) or a Civitai version (`civitai`, with `pick`/`sha256` to name one of its files), into a model folder. Needs Download missing models on in Settings › Models (a family's usual file excepted). A file under a preset's licence the user has not accepted is refused. Onto a pod needs Spend (a pod fetching is billed). Answers the download; downloads follows it.",
  input: {
    folder: z.string().min(1).max(120).describe("The ComfyUI model folder (loras, checkpoints, diffusion_models…), as find_models says it."),
    file: z.string().max(400).optional().describe("The name it gets; left out for a Civitai version: Civitai's name."),
    url: z.string().url().max(2000).optional(),
    civitai: z.number().int().positive().optional().describe("A Civitai version's id."),
    pick: z.string().max(400).optional().describe("Of a Civitai version with several files: the one, by name."),
    sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
    machine: z.string().optional().describe("A machine's id or name (list_machines); left out, the first machine."),
  },
  async run(a, ctx) {
    const { s } = ctx;
    const m = await targetOf(s, a.machine);
    await mayFetchOnto(ctx, m);
    const name = a.file || a.pick;
    if (name) await licenceFree(s, [{ folder: a.folder, file: name }]);
    const view = await beginDownload(s, ctx.self, downloadBody.parse({ folder: a.folder, file: a.file ?? "", ...(a.url ? { url: a.url } : {}), ...(a.civitai ? { civitai: a.civitai } : {}), ...(a.pick ? { pick: a.pick } : {}), ...(a.sha256 ? { sha256: a.sha256 } : {}), ...(a.machine && m ? { machine: m.id } : {}) }));
    ctx.said(`Downloading ${quoted(view.file)} into ${quoted(a.folder)}${m ? ` on ${quoted(machineName(m))}` : ""}`);
    return downloadSaid(view);
  },
});

const downloads = tool({
  name: "downloads",
  scope: "look",
  title: "Downloads",
  description: "The downloads line: each file being fetched, waiting its turn, done, failed or stopped, with its bytes, who fetches it and on which machine. change_downloads cancels, reorders, tries again or clears.",
  async run(_args, ctx) {
    const items = ctx.s.downloads.list().filter((d) => !d.quiet);
    const on = (await readSettings(ctx.s.db)).downloadModels;
    ctx.said(`Looked at the downloads: ${items.length}`);
    return { downloadModels: on, items: items.map(downloadSaid) };
  },
});

const changeDownloads = tool({
  name: "change_downloads",
  scope: "manage",
  title: "Change the downloads",
  description: "Act on the downloads line as its card does: `cancel` a download under way or waiting (nothing is left behind), `move` a waiting one before another waiting one of the same machine (or to the end), `again` a failed or stopped one as it was first asked, `clear` the finished ones off the list.",
  input: {
    action: z.enum(["cancel", "move", "again", "clear"]),
    id: z.string().max(80).optional().describe("The download (downloads gives the ids); not for clear."),
    before: z.string().max(80).nullable().optional().describe("move: the waiting download it goes before; null: to the end."),
  },
  async run(a, ctx) {
    const d = ctx.s.downloads;
    if (a.action === "clear") {
      const cleared = d.clearDone();
      ctx.said(`Cleared ${plural(cleared, "finished download")}`);
      return { cleared };
    }
    if (!a.id) throw httpError("Which download: downloads gives the ids.");
    const was = d.list().find((x) => x.id === a.id);
    if (!was) throw httpError("There is no such download: downloads gives the ids.", 404);
    if (a.action === "cancel") {
      const stopped = d.stop(a.id);
      if (stopped === "late") throw httpError("Download complete: ComfyUI is saving the file now.", 409);
      if (stopped === "manager") throw httpError("ComfyUI-Manager downloads this one on its own: it cannot be stopped from Afflatus.", 409);
      ctx.said(`Cancelled the download of ${quoted(was.file)}`);
      return { cancelled: a.id };
    }
    if (a.action === "move") {
      if (!d.move(a.id, a.before ?? null)) throw httpError("Only a download still waiting its turn moves, before another one waiting on the same ComfyUI.", 409);
      ctx.said(`Moved the download of ${quoted(was.file)}`);
      return { moved: a.id };
    }
    // again: as the card's Try again, through the same checks (a pod's Spend among them)
    if (was.status !== "error" && was.status !== "stopped") throw httpError("That download has not failed or been stopped.", 409);
    const kept = d.askOf(a.id);
    if (!kept) throw httpError("It was not asked from a page of Afflatus: download it again from where it was found.", 409);
    const ask = downloadBody.parse(kept.ask);
    await mayFetchOnto(ctx, await targetOf(ctx.s, ask.machine));
    await licenceFree(ctx.s, [{ folder: ask.folder, file: ask.file || ask.pick || "" }]);
    const started = await beginDownload(ctx.s, ctx.self, ask);
    d.stop(a.id);
    ctx.said(`Asked again for ${quoted(was.file)}`);
    return downloadSaid(started);
  },
});

const modelSets = tool({
  name: "model_sets",
  scope: "look",
  title: "Model sets",
  description: "The Model sets (lists of model files to bring onto a machine or a pod at once: presets' files and files of their own), each with its presets, their licences and whether the user accepted them, how many files and their size. `set`: its files, each with where it comes from and which machines have it already.",
  input: { set: z.string().max(80).optional().describe("A set's id.") },
  async run({ set }, ctx) {
    const sets = modelSetsOf(ctx.s);
    if (set) {
      const row = await sets.find(set);
      const { items } = await sets.files(set);
      ctx.said(`Looked at the Model set ${quoted(row.name)}`);
      return { id: set, name: row.name, files: items };
    }
    const { items } = await sets.list();
    ctx.said(`Looked at the Model sets: ${items.length}`);
    return { sets: items };
  },
});

const setFields = {
  name: z.string().trim().min(1).max(120).optional(),
  presets: z.array(z.string().min(1).max(120)).max(20).optional().describe("The presets it holds, by id (find_models yours lists them)."),
  files: z.array(z.object({ file: z.string().max(400), folder: z.string().max(120), url: z.string().max(2000).optional(), size: z.number().optional() }).passthrough()).max(200).optional().describe("Its own files."),
  off: z.array(z.string().max(600)).max(200).optional().describe("Files of its presets left out, as \"folder|name\"."),
};

const editModelSet = tool({
  name: "edit_model_set",
  scope: "manage",
  title: "Change a Model set",
  description: "Make, change, duplicate or delete a Model set, as Settings › Models › Model sets does; or `get` its files a machine lacks onto it (a ComfyUI of the user's own through the downloads line, a pod through what it fetches: that needs Spend). A preset under a licence the user has not accepted is refused: the user accepts it in Afflatus.",
  input: {
    action: z.enum(["new", "edit", "duplicate", "delete", "get"]),
    set: z.string().max(80).optional().describe("The set's id (not for new)."),
    ...setFields,
    machine: z.string().optional().describe("get: the machine's id or name; left out, the first machine."),
  },
  async run(a, ctx) {
    const { s } = ctx;
    const sets = modelSetsOf(s);
    if (a.action === "new") {
      if (!a.name) throw httpError("A new set needs a name.");
      const made = await sets.save(null, { name: a.name, presets: a.presets ?? [], files: a.files ?? [], off: a.off ?? [] });
      ctx.said(`Made the Model set ${quoted(made.name)}`);
      return made;
    }
    if (!a.set) throw httpError("Which set: model_sets gives the ids.");
    const row = await sets.find(a.set);
    if (a.action === "delete") {
      await sets.remove(a.set);
      ctx.said(`Deleted the Model set ${quoted(row.name)}`);
      return { deleted: a.set, said: "Deleted for good; the model files it named stay where they are." };
    }
    if (a.action === "duplicate") {
      const made = await sets.duplicate(a.set);
      ctx.said(`Duplicated the Model set ${quoted(row.name)}`);
      return made;
    }
    if (a.action === "edit") {
      const def = JSON.parse(row.def) as { presets: string[]; files: unknown[]; off: string[] };
      const saved = await sets.save(a.set, { name: a.name ?? row.name, presets: a.presets ?? def.presets, files: a.files ?? def.files, off: a.off ?? def.off });
      ctx.said(`Changed the Model set ${quoted(saved.name)}`);
      return saved;
    }
    const m = await targetOf(s, a.machine);
    await mayFetchOnto(ctx, m);
    // its files under licences not accepted yet are refused here as for the route, said as the user's to accept
    const { items } = await sets.files(a.set);
    await licenceFree(s, items.filter((f) => !f.off));
    const got = await sets.get(ctx.self, a.set, { ...(a.machine && m ? { machine: m.id } : {}), accept: false });
    ctx.said(`Fetching the Model set ${quoted(row.name)}${m ? ` onto ${quoted(machineName(m))}` : ""}: ${plural(got.sent, "file")}`);
    return got;
  },
});

const modelSettings = tool({
  name: "model_settings",
  scope: "look",
  title: "Settings per model file",
  description: "The values saved with a model file (its sampler, steps, CFG, quality tags…: a family's inputs marked per model): the start whenever that file is picked in a form, a draft recording only what it changes on top. `family`, `file`: one family's or one file's.",
  input: { family: z.string().max(120).optional(), file: z.string().max(500).optional() },
  async run(a, ctx) {
    let q = ctx.s.db.selectFrom("model_settings").select(["family", "file", "values", "updated_at"]).where("owner_id", "=", OWNER);
    if (a.family) q = q.where("family", "=", a.family);
    if (a.file) q = q.where("file", "=", a.file);
    const rows = await q.orderBy("family").orderBy("file").execute();
    ctx.said(`Looked at the settings saved per model file: ${rows.length}`);
    return { items: rows.map((r) => ({ family: r.family, file: r.file, values: JSON.parse(r.values) as Record<string, unknown>, updatedAt: r.updated_at })) };
  },
});

const changeModelSettings = tool({
  name: "change_model_settings",
  scope: "manage",
  title: "Change settings per model file",
  description: "Save the values that travel with a model file, as the form's Save for this model does: only the family's inputs marked per model are kept (describe_form says which: perModel), the rest dropped. `values` null (or empty) forgets them: the form's own start again.",
  input: {
    family: z.string().min(1).max(120),
    file: z.string().min(1).max(500),
    values: z.record(z.string(), z.unknown()).nullable(),
  },
  async run(a, ctx) {
    const saved = await saveModelSettings(ctx.s, a.family, a.file, a.values ?? {});
    ctx.said(Object.keys(saved.values).length ? `Saved ${plural(Object.keys(saved.values).length, "value")} with ${quoted(a.file)}` : `Forgot the values saved with ${quoted(a.file)}`);
    return saved;
  },
});

export const MODEL_TOOLS = [listModels, findModels, download, downloads, changeDownloads, modelSets, editModelSet, modelSettings, changeModelSettings];
