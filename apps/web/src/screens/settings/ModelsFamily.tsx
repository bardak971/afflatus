import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ChevronDown, Download as DownloadIcon } from "lucide-react";
import { EITHER_PACKS, EXTRA_PACKS, folderOfFileInput, nodesOfPack, packOfNode } from "@afflatus/core";
import { api, type RecipeInfo, type RecipeStatus, type Scan } from "../../api";
import { useOfficialSizes, useSettings, useSetup } from "../../data";
import { fileLabel, plural, problemSaid, size } from "../../format";
import { GetFile } from "../../GetFile";
import { useDownloads } from "../../useGetFile";
import { Select } from "../../Select";
import { useSayFailed } from "../../sayFailed";
import { Button, Chip, cx, Help } from "../../ui";
import { queryKeys } from "../../queryKeys";
import { PackInstallActions, PackStateLine, usePackInstall } from "../PackInstall";

/** One of a family's files, as ComfyUI has it (the setup scan's slot). */
export type Slot = Scan["families"][number]["slots"][number];

/**
 * A file of a family, said once whatever needs it: one of its slots (a diffusion model, a text encoder, Edit's Kontext
 * model) or a file an operation names itself (an imported workflow's), with the operations that use it.
 */
export interface FileRow {
  key: string;
  label: string;
  folder: string | null;
  /** The file ComfyUI has for it; null while it is missing. */
  file: string | null;
  /** Where to put it and what fits (a missing one), or what it brings (an optional one). */
  hint: string;
  /** Where it can be downloaded from, when that is known. */
  get?: { file: string; url?: string };
  /** The titles of the operations that cannot run without it. */
  users: string[];
  /** Every operation of the family needs it. */
  every: boolean;
  /** Everything runs without it: an option or a speed-up. */
  optional: boolean;
  /** Its slot, for its picker when more than one file fits. */
  slot?: Slot;
}

/** An optional file's hint was written for a line that said "optional" in front of it: its section says so. */
const broughtSaid = (hint: string) => hint.replace(/^optional[:,]\s*/i, "").replace(/^./, (c) => c.toUpperCase());

/**
 * A family's files, each once: the ones its operations cannot run without (its slots that are not optional, and the
 * optional ones an operation needs, as Edit needs FLUX.1's Kontext model; then the files an operation names itself), and
 * its optional ones (here or to add), with the image tools' detectors it would use (`lent`). Each operation listed every
 * file it lacked, with its download: FLUX.1 said its four files under each of its seven operations (the owner, 2026-10-17).
 */
export function familyFiles(slots: readonly Slot[], recipes: readonly RecipeInfo[], statuses: readonly RecipeStatus[], lent: readonly Slot[] = []): { needed: FileRow[]; optional: FileRow[] } {
  const titles = recipes.map((r) => r.title);
  const needers = (s: Slot) => (s.optional ? recipes.filter((r) => r.needs?.includes(s.id)).map((r) => r.title) : titles);
  const ofSlot = (s: Slot, optional: boolean): FileRow => {
    const users = optional ? [] : needers(s);
    return { key: `slot:${s.id}`, label: s.label, folder: s.folder, file: s.file, hint: optional ? broughtSaid(s.hint) : s.hint, get: s.get, users, every: !optional && users.length === recipes.length, optional, slot: s };
  };
  const needed = slots.filter((s) => needers(s).length > 0).map((s) => ofSlot(s, false));
  // the files an operation names itself, missing: once each, with every operation that names it
  const named = new Map<string, FileRow>();
  for (const r of recipes) {
    for (const m of statuses.find((x) => x.id === r.id)?.missing ?? []) {
      const key = `file:${m.folder ?? ""}/${m.file}`;
      const row = named.get(key) ?? { key, label: fileLabel(m.file), folder: m.folder, file: null, hint: "", get: m.url ? { file: m.file, url: m.url } : { file: m.file }, users: [], every: false, optional: false };
      if (!row.users.includes(r.title)) row.users.push(r.title);
      row.every = row.users.length === recipes.length;
      named.set(key, row);
    }
  }
  const own = new Set(slots.map((s) => s.id));
  const optional = [
    // a file only hidden recipes use is left out: what it is for cannot be opened (Swap's files, in a release that hides it)
    ...slots.filter((s) => s.optional && !s.onlyHidden && !needers(s).length && (s.file || s.get)),
    ...lent.filter((s, i) => !own.has(s.id) && lent.findIndex((x) => x.id === s.id) === i),
  ].map((s) => ofSlot(s, true));
  return { needed: [...needed, ...named.values()], optional };
}

/** The image tools' detectors an operation of the family picks from (a face detailer's detection model), missing: offered with its optional files. */
function lentSlots(family: string, recipes: readonly RecipeInfo[], families: Scan["families"]): Slot[] {
  const folders = new Set<string>(recipes.flatMap((r) => r.inputs.flatMap((i) => (i.type === "choice" && i.options && !Array.isArray(i.options) ? [folderOfFileInput(i.options.node, i.options.input)] : []))).filter((f) => f === "ultralytics"));
  // detectors only: a model folder (diffusion_models) would bring in every other family's optional models
  return families.filter((f) => f.id !== family).flatMap((f) => f.slots).filter((x) => folders.has(x.folder) && x.optional && !x.file && x.get);
}

/** What an operation that is not ready waits for, in a few words: the files above it points to, its custom nodes. */
export function needsSaid(s: RecipeStatus, rows: readonly FileRow[], extra: number): string {
  const missing = rows.filter((r) => r.slot && s.missingSlots.includes(r.slot.id));
  const shared = missing.filter((r) => r.every);
  const parts = [
    ...(shared.length > 1 ? [`the ${shared.length} files above`] : shared.map((r) => `${r.label} ↑`)),
    ...missing.filter((r) => !r.every).map((r) => `${r.label} ↑`),
    ...(extra ? [`${plural(extra, "file")} above`] : []),
    ...(s.missingNodes.length ? [`custom nodes: ${s.missingNodes.join(", ")}`] : []),
  ];
  return parts.length ? `needs ${parts.join(" + ")}` : "not ready";
}

/** Which of the family's missing needed files can be downloaded now, and starting them all: "Download all" in its head. */
export function useDownloadAll(family: string, recipes: readonly RecipeInfo[], machine?: string) {
  const setup = useSetup(machine);
  const downloads = useDownloads(machine);
  const client = useQueryClient();
  const failed = useSayFailed({ id: "models", href: "/settings/models", go: "Open Models" });
  const slots = setup.data?.families.find((f) => f.id === family)?.slots ?? [];
  const { needed } = familyFiles(slots, recipes, setup.data?.recipes ?? []);
  const coming = (r: FileRow) => (downloads.data?.items ?? []).some((d) => d.file === r.get?.file && d.folder === r.folder && (!machine || d.machine === machine) && d.status !== "error" && d.status !== "stopped");
  // only the families' official files (their `get`): downloaded on this press whatever the download settings (fetchFile.ts)
  const can = Boolean(downloads.data) && downloads.data?.via !== "none";
  const files = can ? needed.filter((r) => !r.file && r.get?.url && r.folder && !coming(r)) : [];
  const start = useMutation({
    mutationFn: () => Promise.all(files.map((r) => api.startDownload({ file: r.get!.file, folder: r.folder!, url: r.get!.url!, ...(machine ? { machine } : {}) }))),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.downloads() }),
    onError: failed("Could not start the downloads"),
  });
  return { files, start };
}

/** "Download all · 3 files" in a family's head: the needed files it lacks that have a download, each then with its own bar below. */
export function DownloadAll({ family, recipes, machine }: { family: string; recipes: readonly RecipeInfo[]; machine?: string }) {
  const { files, start } = useDownloadAll(family, recipes, machine);
  if (!files.length) return null;
  return (
    <Button size="sm" tone="primary" className="h-7 shrink-0 gap-1.5" disabled={start.isPending} data-tip={files.map((r) => r.get!.file).join("\n")} onClick={() => start.mutate()}>
      <DownloadIcon size={13} /> Download all · {plural(files.length, "file")}
    </Button>
  );
}

/** The picker's last entry: not a file, the way to another one (FileLine's search and download). */
const ANOTHER = "\u0000another";

/**
 * Its picker, on every file there: which one is used (several fit: two SeedVR2 models, a fine-tune beside the base), by hand
 * or left to the patterns, and "Another file…" to get one more. With one file, a plain name hid that it can be changed (the
 * owner, 2026-10-17: "those are things the user could change").
 */
function SlotPicker({ family, slot, onAnother }: { family: string; slot: Slot; onAnother(): void }) {
  const settings = useSettings();
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (file: string) => {
      const all = { ...(settings.data?.slotFiles ?? {}) };
      const mine = { ...(all[family] ?? {}) };
      if (file) mine[slot.id] = file;
      else delete mine[slot.id];
      if (Object.keys(mine).length) all[family] = mine;
      else delete all[family];
      return api.saveSettings({ slotFiles: all });
    },
    onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: queryKeys.settings() }), client.invalidateQueries({ queryKey: queryKeys.setup() })]),
  });
  // one file there and none picked by hand: that file, no "Automatic" beside the only one it could be
  const one = slot.choices.length <= 1 && !slot.chosen;
  const files = one
    ? [{ value: "", label: fileLabel(slot.file ?? slot.auto ?? ""), note: "the only one here" }]
    : [{ value: "", label: slot.auto ? `Automatic: ${fileLabel(slot.auto)}` : "Automatic", note: "the first its patterns name" }, ...slot.choices.map((f) => ({ value: f, label: fileLabel(f) }))];
  return (
    <Select
      size="sm"
      label={`File used for ${slot.label}`}
      value={slot.chosen ? (slot.file ?? "") : ""}
      onChange={(file) => (file === ANOTHER ? onAnother() : save.mutate(file))}
      options={[...files, { value: ANOTHER, label: "Another file…", note: "download or search one" }]}
    />
  );
}

/** A file's line: there (its file, or its picker), or missing (where to put it, and its download and search, or its bar while it comes). */
function FileLine({ row, family, name, imported }: { row: FileRow; family: string; name: string; imported?: boolean }) {
  const picker = row.slot && row.file;
  const [another, setAnother] = useState(false);
  const find = encodeURIComponent(row.label);
  // another file for it: the one Afflatus knows to download when it is not the one there, else a search by its name
  const known = row.slot?.get && row.slot.get.file !== row.file ? row.slot.get : null;
  // a missing file with an official download is one to come (Download, or a pod fetches it), said in grey: not a fault
  const coming = !row.file && !row.optional && Boolean(row.get);
  const bytes = useOfficialSizes().data?.[row.get?.url ?? ""];
  return (
    <div className="grid grid-cols-[14px_minmax(0,1fr)_7.5rem_minmax(0,18rem)] items-start gap-3 border-t border-line py-2 first:border-t-0">
      {row.file
        ? <span aria-label="there" className="mt-1 size-2.5 rounded-full bg-good" />
        : <span aria-label={row.optional ? "not there, optional" : coming ? "not here" : "missing"} className={cx("mt-1 size-2.5 rounded-full border-[1.5px]", row.optional ? "border-dashed border-ink-3" : coming ? "border-ink-3" : "border-warn-ink")} />}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className={cx("font-semibold", coming ? "text-ink-2" : !row.file && !row.optional && "text-warn-ink")}>{row.label}</span>
          {coming && <span className="text-xs text-ink-3">not here{bytes ? ` · ${size(bytes)}` : ""}</span>}
          {!row.optional && !row.every && row.users.length > 0 && <Chip size="xs" tone="accent" tip={`Only ${row.users.join(", ")} cannot run without it`}>{row.users.join(", ")} only</Chip>}
        </span>
        {/* where to put a missing one, what an optional one brings */}
        {(!row.file || row.optional) && row.hint && <span className="text-xs text-ink-2">{row.hint}</span>}
      </span>
      <span className="truncate pt-0.5 font-mono text-meta text-ink-3">{row.folder ?? ""}</span>
      <span className="flex min-w-0 flex-col">
        {picker ? <SlotPicker family={family} slot={row.slot!} onAnother={() => setAnother(true)} />
          : row.file ? <span className="truncate pt-0.5 text-xs text-ink-2" data-tip={row.file}>{fileLabel(row.file)}</span>
          : (
            <>
              {/* a file an operation names itself (an imported workflow's) has no slot's hint: where to look for it */}
              {!row.slot && (
                <span className="flex flex-wrap items-center gap-x-2 text-xs">
                  <a className="font-semibold text-accent underline" href={`https://civitai.com/search/models?query=${find}`} target="_blank" rel="noreferrer">Civitai</a>
                  <a className="font-semibold text-accent underline" href={`https://huggingface.co/models?search=${find}`} target="_blank" rel="noreferrer">Hugging Face</a>
                  {imported && <Link href="/workflows" className="font-semibold text-accent underline">Workflows</Link>}
                </span>
              )}
              {row.get && <GetFile file={row.get.file} folder={row.folder} url={row.get.url} hints={[name]} />}
            </>
          )}
      </span>
      {another && (
        <div className="col-span-full ml-[26px] flex flex-col gap-1 rounded-lg border border-line bg-panel px-3 py-2 text-xs text-ink-2">
          <span className="flex items-center gap-2">
            <span className="grow">Another {row.label}: put its file in ComfyUI's {row.folder} folder, or get one here. It then shows in the list above.</span>
            <button type="button" className="shrink-0 font-semibold text-accent hover:underline" onClick={() => setAnother(false)}>Close</button>
          </span>
          {/* auto: looked up at once when Afflatus knows no other file to offer */}
          <GetFile file={known?.file ?? row.file!} folder={row.folder} url={known?.url} hints={[name]} auto={!known} />
        </div>
      )}
    </div>
  );
}

/**
 * A node pack some options of the family use, missing: an optional line like the files', installed through ComfyUI-Manager
 * and ComfyUI restarted as a workflow's missing packs are (the owner: Veda's pack was nowhere to be seen before a render failed).
 */
function PackLine({ pack, nodes, users, machine, extra, asked }: { pack: string; nodes: string[]; users: string[]; machine?: string; extra?: string; asked?: string }) {
  const install = usePackInstall({
    missing: nodes,
    packs: Object.fromEntries(nodes.map((n) => [n, pack])),
    machine,
    // ComfyUI asked afresh: the line goes once the pack's nodes are there
    readAgain: async () => {
      const scan = await api.rescanSetup(machine);
      if (!scan.comfy.online) throw new Error("ComfyUI is not answering yet");
    },
    again: { what: "the models list", reopen: "open Settings › Models again" },
  });
  return (
    <div className="grid grid-cols-[14px_minmax(0,1fr)_7.5rem_minmax(0,18rem)] items-start gap-3 border-t border-line py-2 first:border-t-0">
      <span aria-label="not there, optional" className="mt-1 size-2.5 rounded-full border-[1.5px] border-dashed border-ink-3" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-semibold">Node pack {pack}{extra && <span className="font-normal text-ink-3"> · faster with it</span>}</span>
        {/* one no option asks for (KJNodes, VideoHelperSuite): what it brings, used whenever it is there */}
        <span className="text-xs text-ink-2">{extra ? `Brings ${extra}. Used whenever it is there${asked ? `, and asked for by a render with ${asked}` : ""}; installed by ComfyUI-Manager, then ComfyUI restarts.` : `Brings ${nodes.join(", ")}, which some options of ${users.join(", ")} use. Installed by ComfyUI-Manager, then ComfyUI restarts.`}</span>
      </span>
      <span className="truncate pt-0.5 font-mono text-meta text-ink-3">custom_nodes</span>
      <span className="flex min-w-0 flex-col gap-1 text-xs">
        <PackStateLine s={install.stateOf(pack)} />
        <PackInstallActions install={install} named={1} missingLeft={false} />
      </span>
    </div>
  );
}

/**
 * Packs that stand in for each other (RTX VSR: NVIDIA's or DaSiWa's), missing both: one line, "either one", with an Install
 * for each. A render that asks for it has the last one installed (the queue's pick, core EITHER_PACKS).
 */
function EitherLine({ either, users, machine }: { either: (typeof EITHER_PACKS)[number]; users: string[]; machine?: string }) {
  const [picked, setPicked] = useState<number | null>(null);
  const readAgain = async () => {
    const scan = await api.rescanSetup(machine);
    if (!scan.comfy.online) throw new Error("ComfyUI is not answering yet");
  };
  const again = { what: "the models list", reopen: "open Settings › Models again" };
  // one install each, the hooks always both there; the one picked is followed
  const installs = [
    usePackInstall({ missing: [either.nodes[0]!], packs: { [either.nodes[0]!]: either.packs[0]! }, machine, readAgain, again }),
    usePackInstall({ missing: [either.nodes[1]!], packs: { [either.nodes[1]!]: either.packs[1]! }, machine, readAgain, again }),
  ];
  const owner = (i: number) => (i === 0 ? "NVIDIA's" : "DaSiWa's");
  return (
    <div className="grid grid-cols-[14px_minmax(0,1fr)_7.5rem_minmax(0,18rem)] items-start gap-3 border-t border-line py-2 first:border-t-0">
      <span aria-label="not there, optional" className="mt-1 size-2.5 rounded-full border-[1.5px] border-dashed border-ink-3" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-semibold">{either.what}<span className="font-normal text-ink-3"> · either one</span></span>
        <span className="text-xs text-ink-2">{either.said} ({either.packs.join(" or ")}): used by {users.join(", ")}. NVIDIA RTX cards only. A render that asks for it has DaSiWa's installed.</span>
      </span>
      <span className="truncate pt-0.5 font-mono text-meta text-ink-3">custom_nodes</span>
      <span className="flex min-w-0 flex-col gap-1 text-xs">
        {picked === null ? (
          <span className="flex flex-wrap items-center gap-2">
            {installs.map((install, i) => (
              <Button key={either.packs[i]} size="sm" tone={i === 0 ? "primary" : undefined} disabled={install.noManager || install.start.isPending} onClick={() => {
                setPicked(i);
                install.start.mutate();
              }}>
                {i === 0 ? `Install ${owner(i)} with ComfyUI-Manager` : `or ${owner(i)}`}
              </Button>
            ))}
            {installs[0]!.noManager && <span>ComfyUI-Manager was not found in your ComfyUI: turn it on first (Settings → Models → Missing models says how).</span>}
          </span>
        ) : (
          <>
            <PackStateLine s={installs[picked]!.stateOf(either.packs[picked]!)} />
            <PackInstallActions install={installs[picked]!} named={1} missingLeft={false} />
          </>
        )}
      </span>
    </div>
  );
}

/**
 * An opened family: what it makes, its files once each (the needed ones always in sight, then the optional ones to add,
 * those there folded behind one line; a picker on each where more than one fits), its operations a line each saying ready or what they
 * wait for, and once, the custom nodes some of their options need. What was said under each operation, and the Optional
 * and Files in use sections apart (the owner's pick, mock "Models view", A).
 */
export function FamilyBody({ family, name, help, recipes, machine, imported }: { family: string; name: string; help?: string; recipes: RecipeInfo[]; machine?: string; imported?: boolean }) {
  const setup = useSetup(machine);
  const [optionalOpen, setOptionalOpen] = useState(false);
  const scanned = setup.data?.families ?? [];
  const slots = scanned.find((f) => f.id === family)?.slots ?? [];
  const statuses = setup.data?.recipes ?? [];
  const { needed, optional } = familyFiles(slots, recipes, statuses, lentSlots(family, recipes, scanned));
  const allThere = needed.every((r) => r.file);
  // the custom nodes some options need: once, with the operations they are off in
  const limited = new Map<string, string[]>();
  for (const r of recipes) for (const node of statuses.find((x) => x.id === r.id)?.limitedBy ?? []) limited.set(node, [...(limited.get(node) ?? []), r.title]);
  // packs that stand in for each other: one line when both are missing, none when one is there (the option runs)
  const eitherLines = EITHER_PACKS.flatMap((e) => {
    const off = e.nodes.filter((n) => limited.has(n));
    const users = [...new Set(off.flatMap((n) => limited.get(n)!))];
    for (const n of e.nodes) limited.delete(n);
    return off.length === e.nodes.length ? [<EitherLine key={`either:${e.what}`} either={e} users={users} machine={machine} />] : [];
  });
  // packs no form needs (KJNodes, VideoHelperSuite): a line each, with what they bring and the option that asks for one, whatever option names a node of theirs
  const extraLines = EXTRA_PACKS.flatMap((x) => {
    const nodes = nodesOfPack(x.name);
    const off = nodes.filter((n) => limited.has(n));
    const users = [...new Set(off.flatMap((n) => limited.get(n)!))];
    for (const n of nodes) limited.delete(n);
    return off.length ? [<PackLine key={`extra:${x.name}`} pack={x.name} nodes={off} users={users} machine={machine} extra={x.uses} asked={x.asked} />] : [];
  });
  // the ones of a known pack get a line of their own with the optional files, to install from there; the rest are only said
  const packsOff = new Map<string, { nodes: string[]; users: Set<string> }>();
  const loose = new Map<string, string[]>();
  for (const [node, users] of limited) {
    const pack = packOfNode(node);
    if (!pack || pack.own) {
      loose.set(node, users);
      continue;
    }
    const p = packsOff.get(pack.name) ?? { nodes: [], users: new Set<string>() };
    p.nodes.push(node);
    for (const u of users) p.users.add(u);
    packsOff.set(pack.name, p);
  }
  const offIn = [...new Set([...loose.values()].flat())];
  const packLines = [...eitherLines, ...[...packsOff].map(([pack, p]) => <PackLine key={`pack:${pack}`} pack={pack} nodes={p.nodes} users={[...p.users]} machine={machine} />), ...extraLines];
  const line = (row: FileRow) => <FileLine key={row.key} row={row} family={family} name={name} imported={imported} />;
  return (
    <div className="flex flex-col gap-4">
      {help && <span className="text-xs text-ink-2">{help}</span>}

      {(needed.length > 0 || optional.length > 0 || packLines.length > 0) && (
        <section aria-label="Files" data-setting="models.files" className="flex flex-col">
          {needed.length > 0 && (
            <>
              <span className="flex items-center gap-2 pb-1">
                <span className="text-meta font-bold tracking-label text-ink-3 uppercase">Files · {needed.length} needed</span>
                {/* what misses is said; nothing of them all being there (the owner: that all is fine is too much) */}
                {!allThere && (needed.every((r) => r.file || r.get)
                  ? <span className="text-xs text-ink-3">{needed.filter((r) => !r.file).length} not here</span>
                  : <span className="text-xs text-warn-ink">{plural(needed.filter((r) => !r.file).length, "missing", "missing")}</span>)}
                <Help title="Files" text="Each file the family needs, once, whatever needs it: an operation that lacks one says so in its line below. Where more than one file fits, its picker says which is used: left to itself, the first its patterns name." />
              </span>
              {/* always in sight once the family is opened: what it runs with, and their pickers, are what one opens it for (the owner; they were folded) */}
              {needed.map(line)}
            </>
          )}
          {(optional.length > 0 || packLines.length > 0) && (
            <>
              <span className={cx("flex items-center gap-1.5 pb-1", needed.length > 0 && "pt-3.5")}>
                <span className="text-meta font-bold tracking-label text-ink-3 uppercase">Optional · {[...(optional.length ? [plural(optional.length, "file")] : []), ...(packLines.length ? [plural(packLines.length, "node pack")] : [])].join(" · ")}</span>
                <Help text="Everything runs without these: each brings an option or a speed-up, said on its line." />
              </span>
              {/* what can be added stays in sight; the ones there (their pickers) fold behind one line */}
              {optional.filter((r) => !r.file).map(line)}
              {packLines}
              {optional.some((r) => r.file) && (
                <>
                  <button type="button" aria-expanded={optionalOpen} onClick={() => setOptionalOpen(!optionalOpen)} className="flex items-center gap-2 border-t border-line py-2 text-left text-xs text-ink-2 first:border-t-0 hover:text-ink">
                    <ChevronDown size={13} className={cx("shrink-0 text-ink-3 transition-transform", !optionalOpen && "-rotate-90")} />
                    {/* neutral: nothing said of them being there, as of the needed ones (the owner) */}
                    <span className="font-semibold">{optional.filter((r) => r.file).length} more</span>
                  </button>
                  {optionalOpen && optional.filter((r) => r.file).map(line)}
                </>
              )}
            </>
          )}
        </section>
      )}

      <section aria-label={imported ? "Workflows" : "Operations"} className="flex flex-col">
        <span className="pb-1 text-meta font-bold tracking-label text-ink-3 uppercase">{imported ? "Workflows" : "Operations"}</span>
        {recipes.map((r) => {
          const s = statuses.find((x) => x.id === r.id);
          const extra = needed.filter((row) => !row.slot && row.users.includes(r.title)).length;
          const notes = [
            ...(s?.problems ?? []).map((p) => `${problemSaid(p)}${r.imported ? " Fix it in Workflows, with Edit." : ""}`),
            ...(s?.emptyInputs ?? []).map((id) => {
              const input = r.inputs.find((i) => i.id === id);
              return `ComfyUI has no model file for "${input?.label ?? id}"${input?.note ? ` (${input.note})` : ""}`;
            }),
          ];
          const said = s ? (s.ready ? "Ready" : needsSaid(s, needed, extra)) : "Unknown";
          return (
            <div key={r.id} className="flex flex-col gap-0.5 py-1">
              <div className="flex items-baseline gap-2.5">
                <span className={cx("h-2 w-2 shrink-0 translate-y-[-1px] rounded-full", s?.ready ? "bg-good" : s ? "bg-warn-ink" : "bg-ink-3")} />
                <span className="w-36 shrink-0 truncate font-semibold">{r.title}</span>
                {/* the room left (w-0 grow), cut short: at its whole length, Edit's widened the card past its 860 px */}
                <span className="w-0 min-w-0 grow truncate text-xs text-ink-2" data-tip={r.summary}>{r.summary}</span>
                {/* it may be cut short (whole in its tip), never shrink-0: a long one widened the whole card */}
                <span className={cx("max-w-[45%] truncate text-xs font-semibold", s?.ready ? "text-good" : "text-warn-ink")} data-tip={said}>{said}</span>
              </div>
              {notes.map((n) => <div key={n} className="pl-[18px] text-xs text-warn-ink">{n}</div>)}
            </div>
          );
        })}
      </section>

      {loose.size > 0 && (
        <span className="rounded-lg border border-dashed border-line-strong px-3 py-2 text-xs text-ink-2">
          Some options are off in {offIn.join(", ")}: missing custom nodes {[...loose.keys()].join(", ")}.
        </span>
      )}
    </div>
  );
}
