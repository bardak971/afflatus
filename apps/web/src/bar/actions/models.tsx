import { Copy, Download as DownloadIcon, ExternalLink, FolderOpen, ListPlus, RotateCcw, Search, Server, Square, User, X } from "lucide-react";
import { api, type BrowseCard, type BrowseFile, type Download, type FileWhere, type UpdateRow } from "../../api";
import { ask, askChoice } from "../../Confirm";
import { addPicked, clearPicked, dropPicked, foldersFor, getOnPc, openFindModels, openFindModelsOn, pickedNow, pickedOf, thisPcTarget, civitaiExact, type FindTarget } from "../../findModels/store";
import { PAID_HELP, askPaid, paidWords } from "../../findModels/paid";
import { plural } from "../../format";
import { toFind, type BrowseAsk } from "../browseSearch";
import { retype } from "./retype";
import { size } from "../../format";
import { machineLabel } from "../../machines";
import { queryKeys } from "../../queryKeys";
import { settingHref } from "../../screens/settings/settingsIndex";
import { copyText } from "../../secureContext";
import type { SearchValue } from "../items";
import { inLine } from "../../downloadLine";
import type { Action, BarCtx } from "./ctx";
/**
 * What the bar does with Civitai and Hugging Face: a pasted link's file downloaded onto this PC or another ComfyUI, a
 * download stopped, dismissed or asked again, a newer version of a model fetched. Every download is asked first, with
 * its size and where it goes: a stray Enter in a bar is easy, and a model is gigabytes.
 */

/** Find models as Settings › Models opens it: what is picked downloads onto this PC (the bar's `find models`, a pasted link's Tab). */
export const onThisPc = (x: BarCtx): FindTarget => thisPcTarget(x.client);

/** A ComfyUI a download can go to: this PC (the first one, no id) or another, by its id. */
type Where = { id?: string; name: string };

/** The machines past the first, as the queue lists them: where else a file can go (a rented pod's ComfyUI). */
const others = (x: BarCtx): Array<Where & { online: boolean | null }> =>
  (x.queue?.machines ?? []).slice(1).map((m) => ({ id: m.id, name: machineLabel(m), online: m.online }));

/** Asked, then started: one file of a link, into its folder (asked when the source does not say). */
async function download(x: BarCtx, card: BrowseCard, version: string, f: BrowseFile, to: Where) {
  const folder = f.folder ?? (await askChoice({
    title: `Which folder does ${f.name} go in?`, text: "Its source does not say what kind of model it is: the ComfyUI folder it is read from.",
    choices: (await foldersFor(x.client, to.id)).map((v) => ({ value: v, label: v })), no: "Cancel",
  }));
  if (!folder) return;
  // a version Civitai sells: said in the same question (card #163), the download still possible
  const paid = card.versions.find((v) => v.id === version)?.paid;
  const yes = await ask({
    title: `Download ${f.name}?`,
    text: `${f.bytes ? size(f.bytes) : "Size not given"} from ${card.site === "civitai" ? "Civitai" : "Hugging Face"}, into ${folder} on ${to.name}.${paid ? ` ${paidWords(paid)}: Buzz needed, Civitai refuses its download until it is unlocked on its page.` : ""}`,
    yes: paid ? "Download anyway" : "Download",
    ...(paid ? { help: PAID_HELP } : {}),
  });
  if (!yes) return;
  const page = card.site === "civitai" && f.source.kind === "civitai" ? `${card.page}?modelVersionId=${f.source.version}` : card.page;
  try {
    await api.startDownload({
      file: f.name, folder, page: { url: page, title: card.site === "civitai" ? `${card.name} · ${card.versions.find((v) => v.id === version)?.name ?? version}` : card.id },
      ...(to.id ? { machine: to.id } : {}),
      ...(f.source.kind === "civitai" ? { civitai: f.source.version, pick: f.source.pick, ...civitaiExact(f.source) } : { url: f.source.url }),
    });
    void x.client.invalidateQueries({ queryKey: queryKeys.downloads() });
    x.good(`Downloading ${f.name}`, `Into ${folder} on ${to.name}. Type ! in the bar to follow it.`);
  } catch (err) {
    x.failed(`Could not download ${f.name}`)(err);
  }
}

/** A pasted link's file: downloaded onto this PC (Enter) or the next ComfyUI (Ctrl+Enter), both asked; its page, Find models, its words. */
export function linkActions(x: BarCtx, card: BrowseCard, version: string, file: string): Action[] {
  const v = card.versions.find((y) => y.id === version);
  const f = v?.files.find((y) => y.name === file);
  if (!v || !f) return [];
  const have = f.have.length > 0;
  // the first ComfyUI by its name only beside others: alone, it is this PC's
  const first = x.queue?.machines?.[0];
  const pcName = first && x.queue!.machines.length > 1 ? machineLabel(first) : "this PC";
  const words = v.trainedWords.join(", ");
  return [
    {
      label: `Download onto ${pcName}`, icon: <DownloadIcon size={14} />, note: have ? "you have it already · asked first" : v.paid ? `${paidWords(v.paid)} on Civitai · asked first` : "asked first, with its size",
      run: () => download(x, card, version, f, { name: pcName }),
    },
    ...others(x).map((m): Action => ({
      label: `Download onto ${m.name}`, icon: <Server size={14} />, disabled: m.online === false, note: m.online === false ? "it does not answer" : "asked first, with its size",
      run: () => download(x, card, version, f, m),
    })),
    { label: "Open in Find models", icon: <Search size={14} />, note: "every version and file, to pick from", run: () => openFindModels(onThisPc(x), card.page) },
    { label: `Its page on ${card.site === "civitai" ? "Civitai" : "Hugging Face"}`, icon: <ExternalLink size={14} />, run: () => window.open(card.page, "_blank", "noopener") },
    ...(words ? [{ label: "Copy its trigger words", icon: <Copy size={14} />, note: words.slice(0, 60), stay: true, run: () => copyText(words).then(() => x.onCopied("its trigger words"), () => x.onCopied("")) }] : []),
  ];
}

/** A download in `!`: shown, cancelled (taken out of the line while it waits), dismissed, tried again as it was first asked; done, its place on disk. */
export function downloadActions(x: BarCtx, d: Download): Action[] {
  const show: Action = { label: "Show the downloads", icon: <DownloadIcon size={14} />, note: "Settings › Models", run: () => x.go(settingHref("models.downloads")) };
  const done = () => void x.client.invalidateQueries({ queryKey: queryKeys.downloads() });
  const dismiss: Action = { label: "Dismiss", icon: <X size={14} />, stay: true, run: () => api.stopDownload(d.id).then(done, x.failed("Could not take it off the list")) };
  if (d.status === "starting" || d.status === "downloading") {
    // the line's own words: a file waiting its turn is taken out of the line, one under way cancelled
    const out = inLine(d) ? "Take it out of the line" : "Cancel this download";
    return [show, { label: out, icon: <Square size={14} />, danger: true, note: inLine(d) ? `waiting its turn, ${d.waiting}` : "nothing is kept of it", stay: true, run: () => api.stopDownload(d.id).then(done, x.failed("Not cancelled")) }];
  }
  if (d.status === "error" || d.status === "stopped") {
    return [
      d.again
        ? { label: "Try again", icon: <RotateCcw size={14} />, note: "as it was asked", stay: true, run: () => api.downloadAgain(d.id).then(done, x.failed("Not started again")) }
        : { label: "Try again", icon: <RotateCcw size={14} />, disabled: true, note: "Afflatus restarted since: from where it was found", run: () => {} },
      dismiss, show,
    ];
  }
  return d.status === "done" ? [dismiss, ...whereActions(x, whereAsk({ kind: "download", d })!), show] : [show];
}

/** A model of yours with a newer version on Civitai: that version fetched (asked, as the Settings card's Get it), its page. */
export function newerActions(x: BarCtx, u: UpdateRow): Action[] {
  const n = u.newer;
  if (!n) return [];
  return [
    {
      label: `Get ${n.name}`, icon: <DownloadIcon size={14} />, note: "its newer version on Civitai · asked first",
      run: async () => {
        const yes = await ask({ title: `Download ${u.modelName} · ${n.name}?`, text: `${n.name} from Civitai, into ${u.folder}.`, yes: "Download" });
        if (!yes) return;
        await api.startDownload({ file: n.file ?? u.file, folder: u.folder, civitai: n.id, ...(n.file ? { pick: n.file } : {}), page: { url: n.page, title: `${u.modelName} · ${n.name}` } })
          .then(() => {
            void x.client.invalidateQueries({ queryKey: queryKeys.downloads() });
            x.good(`Downloading ${u.modelName} · ${n.name}`, "Type ! in the bar to follow it.");
          }, x.failed("Could not download it"));
      },
    },
    { label: "Its newer version's page", icon: <ExternalLink size={14} />, run: () => window.open(n.page, "_blank", "noopener") },
  ];
}

/** Find models opened on the bar's search: the same site, words and filters (Ctrl+Enter on any of its rows). */
export const findAction = (x: BarCtx, ask: BrowseAsk): Action => ({
  label: "Find models on this search", icon: <Search size={14} />, note: "the same words and filters, to pick from",
  run: () => openFindModelsOn(onThisPc(x), toFind(ask)),
});

/**
 * The file a found model's Pick and Download take: its newest version's first, on Civitai; on Hugging Face, the repository's
 * model files read first, one asked for when it has several. Null when there is none, or nothing was chosen.
 */
async function fileOf(x: BarCtx, card: BrowseCard): Promise<{ f: BrowseFile; version: string; card: BrowseCard } | null> {
  if (card.site === "civitai") {
    const v = card.versions[0];
    const f = v?.files[0];
    return v && f ? { f, version: v.id, card } : null;
  }
  const files = await x.client.fetchQuery({ queryKey: queryKeys.browse.repo(card.id), queryFn: ({ signal }) => api.browseRepoFiles(card.id, { signal }), staleTime: 5 * 60_000 }).then((r) => r.files, () => []);
  if (!files.length) {
    x.say({ id: "bar:repo", tone: "bad", title: `${card.id} has no model files`, text: "Nothing ComfyUI loads is in this repository." });
    return null;
  }
  const name = files.length === 1 ? files[0]!.name : await askChoice({
    title: `Which file of ${card.id}?`, text: "The repository holds several model files.",
    choices: files.slice(0, 30).map((f) => ({ value: f.name, label: `${f.name}${f.bytes ? ` · ${size(f.bytes)}` : ""}` })), no: "Cancel",
  });
  const f = files.find((y) => y.name === name);
  return f ? { f, version: "main", card: { ...card, versions: [{ id: "main", name: "main", base: "", publishedAt: "", trainedWords: [], files }] } } : null;
}

/** A model a search found: opened in Find models, the search there, a file picked or downloaded (asked), its page, more by its creator. */
export function cardActions(x: BarCtx, card: BrowseCard, ask: BrowseAsk): Action[] {
  const site = card.site === "civitai" ? "Civitai" : "Hugging Face";
  return [
    { label: "Open in Find models", icon: <Search size={14} />, note: "its versions and files", run: () => openFindModelsOn(onThisPc(x), { ...toFind(ask), opened: card }) },
    findAction(x, ask),
    {
      label: "Add to Picked", icon: <ListPlus size={14} />, note: card.site === "civitai" ? "its newest version's file · > picked gets them" : "a file of it · > picked gets them", stay: true,
      run: async () => {
        const got = await fileOf(x, card);
        if (!got) return;
        const v = got.card.versions.find((y) => y.id === got.version)!;
        if (!(await askPaid(v, "Pick"))) return;
        const folder = got.f.folder ?? (await askChoice({ title: `Which folder does ${got.f.name} go in?`, text: "Its source does not say what kind of model it is.", choices: (await foldersFor(x.client)).map((y) => ({ value: y, label: y })), no: "Cancel" }));
        if (!folder) return;
        x.flash(addPicked(pickedOf(got.f, got.card, v.name, folder)) ? `${got.f.name} picked · > picked gets them` : `${got.f.name} was picked already`);
      },
    },
    {
      label: "Download onto this PC", icon: <DownloadIcon size={14} />, note: "asked first, with its size",
      run: async () => {
        const got = await fileOf(x, card);
        if (got) await download(x, got.card, got.version, got.f, { name: "this PC" });
      },
    },
    { label: `Its page on ${site}`, icon: <ExternalLink size={14} />, run: () => window.open(card.page, "_blank", "noopener") },
    ...(card.creator ? [{ label: `More by ${card.creator}`, icon: <User size={14} />, note: `by:${card.creator}`, stay: true, run: retype(`${ask.site === "civitai" ? "civitai:" : "hf:"} by:${card.creator} `) }] : []),
  ];
}

/** What is picked, said for a question: how many, and their size where the sources give it. */
function totalSaid(files: ReadonlyArray<{ size?: number | null }>): string {
  const bytes = files.reduce((n, f) => n + (f.size ?? 0), 0);
  const unknown = files.filter((f) => !f.size).length;
  return `${plural(files.length, "file")}${bytes ? `, ${size(bytes)}` : ""}${unknown ? ` (${unknown} without a size)` : ""}`;
}

/** `> picked`: the files picked in Find models or the bar, downloaded onto this PC after asking, opened there, or let go. */
export function pickedActions(x: BarCtx): Action[] {
  const files = pickedNow();
  const none = !files.length;
  return [
    {
      label: "Get them onto this PC", icon: <DownloadIcon size={14} />, disabled: none, note: none ? "nothing picked yet" : `${totalSaid(files)} · asked first`,
      run: async () => {
        const yes = await ask({ title: `Download ${totalSaid(files)}?`, text: files.map((f) => `${f.file} → ${f.folder}`).join("\n"), yes: "Download" });
        if (!yes) return;
        const refused = await getOnPc(files);
        dropPicked(files.filter((f) => !refused.some((r) => r.file === f)));
        void x.client.invalidateQueries({ queryKey: queryKeys.downloads() });
        if (refused.length) x.failed(`${plural(refused.length, "file")} could not start`)(refused[0]!.error);
        else x.good(`Downloading ${plural(files.length, "file")}`, "Type ! in the bar to follow them.");
      },
    },
    { label: "Open them in Find models", icon: <Search size={14} />, note: "the picked list, beside what is found", run: () => openFindModels(onThisPc(x)) },
    { label: "Clear picked", icon: <X size={14} />, disabled: none, stay: true, run: () => { clearPicked(); x.flash("Nothing picked now"); } },
  ];
}

/** A missing file's source: its own address, else the file of exactly its name on Hugging Face, else an exact match on Civitai. */
async function sourceOf(m: { file: string; folder: string | null; url?: string }): Promise<{ from: { url: string } | { civitai: number; pick: string; sha256?: string; fileId?: number }; bytes: number } | null> {
  if (m.url) return { from: { url: m.url }, bytes: 0 };
  const found = await api.civitaiFind(m.file, m.folder).catch(() => null);
  const hf = found?.exact.find((h) => !h.gated);
  if (hf) return { from: { url: hf.url }, bytes: 0 };
  const civ = found?.items.find((c) => c.exact && c.fits && c.versionId);
  return civ ? { from: { civitai: civ.versionId!, pick: civ.file, ...civitaiExact(civ) }, bytes: civ.bytes } : null;
}

/** `> get missing files`: the open form's missing model files looked up, then downloaded onto this PC after asking (with their total). */
export function missingActions(x: BarCtx): Action[] {
  return [
    {
      label: "Get missing files", icon: <DownloadIcon size={14} />, note: "looked up, then asked with their total",
      run: async () => {
        const t = await x.form();
        if (!t) return x.noDraft();
        const st = (await x.client.fetchQuery({ queryKey: queryKeys.setup(), queryFn: ({ signal }) => api.setup({ signal }) })).recipes.find((r) => r.id === t.recipe.id);
        const missing = st?.missing ?? [];
        if (!missing.length) return x.good(`${t.recipe.title} has every file it needs`);
        x.flash(`Looking up ${plural(missing.length, "file")}…`);
        const found = await Promise.all(missing.map(async (m) => ({ m, src: m.folder ? await sourceOf(m) : null })));
        const ready = found.filter((f) => f.src);
        const nowhere = found.filter((f) => !f.src).map((f) => f.m.file);
        if (!ready.length) return x.say({ id: "bar:missing", tone: "bad", title: `No source found for ${plural(missing.length, "missing file")}`, text: `${nowhere.join(", ")}. Settings › Models looks them up one by one.`, href: settingHref("server.downloadModels"), go: "Open Settings › Models" });
        const yes = await ask({
          title: `Download ${totalSaid(ready.map((r) => ({ size: r.src!.bytes || null })))} for ${t.recipe.title}?`,
          text: [...ready.map((r) => `${r.m.file} → ${r.m.folder}`), ...(nowhere.length ? [`Not found anywhere: ${nowhere.join(", ")}`] : [])].join("\n"),
          yes: "Download",
        });
        if (!yes) return;
        const tried = await Promise.allSettled(ready.map((r) => api.startDownload({ file: r.m.file, folder: r.m.folder!, ...r.src!.from })));
        void x.client.invalidateQueries({ queryKey: queryKeys.downloads() });
        const bad = tried.find((r): r is PromiseRejectedResult => r.status === "rejected");
        if (bad) x.failed("Some files could not start")(bad.reason);
        else x.good(`Downloading ${plural(ready.length, "file")} for ${t.recipe.title}`, "Type ! in the bar to follow them.");
      },
    },
    { label: "Show them in Settings › Models", icon: <Search size={14} />, run: () => x.go(settingHref("server.downloadModels")) },
  ];
}

/** A model file whose place on disk the bar offers (FileWhere's): the folders it may be in, tried in order, and its ComfyUI. */
export type WhereAsk = { folders: string[]; file: string; machine?: string };

/** The model folders a model value of the render search may be read from, as its page is looked for. */
export const MODEL_FOLDERS = ["checkpoints", "diffusion_models", "unet"];

/** The file a row stands for, whose place Show in folder or Copy path gives: a LoRA, a model, a download that is done. */
export function whereAsk(v: SearchValue | undefined): WhereAsk | null {
  if (v?.kind === "lora") return { folders: ["loras"], file: v.file };
  if (v?.kind === "model") return { folders: MODEL_FOLDERS, file: v.file };
  if (v?.kind === "download" && v.d.status === "done") return { folders: [v.d.folder], file: v.d.file, ...(v.d.machine ? { machine: v.d.machine } : {}) };
  return null;
}

/** Where a file is, as FileWhere reads it: read once by useBarActions for the row the bar is on, kept in the same cache. */
export const whereQuery = (folder: string, file: string, machine?: string) => ({
  queryKey: queryKeys.modelFileWhere(folder, file, machine),
  queryFn: ({ signal }: { signal: AbortSignal }) => api.modelFileWhere({ folder, file, ...(machine ? { machine } : {}) }, { signal }),
  staleTime: 60_000,
});

/**
 * A model file's place on disk (card #64), as FileWhere offers it: Show in folder for each place when the bar is open on the
 * computer Afflatus runs on, else Copy path; a ComfyUI on another machine has no path, its folder and name are copied then.
 * The path is never sent: Show in folder names the file and which of its places, the server finds it.
 */
export function whereActions(x: BarCtx, w: WhereAsk): Action[] {
  // a folder whose place could not be read (the server's answer failed) is passed over, said once none of the others has it:
  // read as "being read", the row waited for good
  let unread = false;
  for (const folder of w.folders) {
    const state = x.client.getQueryState<FileWhere>(queryKeys.modelFileWhere(folder, w.file, w.machine));
    const d = state?.data;
    if (!d && state?.status === "error") {
      unread = true;
      continue;
    }
    if (!d) return [{ label: "Show in folder", icon: <FolderOpen size={14} />, disabled: true, note: "its place on disk being read", run: () => {} }];
    if (!d.places.length) continue;
    return d.places.map((p, at) => (d.reveal
      ? { label: "Show in folder", icon: <FolderOpen size={14} />, note: p.path, run: () => api.revealModelFile({ folder, file: w.file, at, ...(w.machine ? { machine: w.machine } : {}) }).catch(x.failed("Could not show it in its folder")) }
      : { label: "Copy path", icon: <Copy size={14} />, note: p.path, stay: true, run: () => copyText(p.path).then(() => x.onCopied("the path"), () => x.onCopied("")) }));
  }
  if (unread) return [{ label: "Show in folder", icon: <FolderOpen size={14} />, disabled: true, note: "its place on disk could not be read", run: () => {} }];
  // found in none of its folders: the page copies its folder and name; a model, whose folder is not known, has nothing to copy
  if (w.folders.length > 1) return [];
  const said = `${w.folders[0]}/${w.file}`;
  return [{ label: "Copy path", icon: <Copy size={14} />, note: said, stay: true, run: () => copyText(said).then(() => x.onCopied("the path"), () => x.onCopied("")) }];
}
