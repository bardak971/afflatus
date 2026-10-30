import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fileKey } from "@afflatus/core";
import { ChevronRight, Plus } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { api, type ModelFile, type ModelLibrary } from "../../api";
import { useRecipes } from "../../data";
import { openFindModels, thisPcTarget } from "../../findModels/store";
import { dayOf, plural, size, when } from "../../format";
import { queryKeys } from "../../queryKeys";
import { useSayFailed } from "../../sayFailed";
import { useBanners } from "../../store";
import { Button, Checkbox, Chip, CloseButton, cx, ErrorNote, Help, SearchField, Segmented, Spinner, TwoStep } from "../../ui";
import { ModelFileDetail, Picture } from "./ModelFileDetail";
import { DeleteDialog } from "./ModelFilesDelete";
import { AddingStrip, useDropFiles } from "./ModelFilesDrop";
import { BANDS, figures, idleFiles, KIND_PLURAL, KINDS, lastSaid, nameOf, NO_FILTER, placeOfId, shown, type Filters, type SortKey } from "./modelFilesView";

/**
 * What Empty would erase, asked before it does: each file with its size, and the ones of which no other copy stays here
 * said first, as such (no other file on disk with their sha256; one not hashed has no copy known). A file seen through two
 * folders went away whole: nothing of it stays in the other place.
 */
function EmptyAsk({ files, from }: { files: ModelFile[]; from: string }) {
  const only = files.filter((f) => !f.copies.length);
  const sorted = [...only, ...files.filter((f) => f.copies.length)];
  const bytes = (fs: ModelFile[]) => fs.reduce((n, f) => n + (f.size ?? 0), 0);
  return (
    <div className="flex flex-col gap-2 border-b border-line bg-attention-wash/40 px-[18px] py-2.5 text-body">
      <span>
        <b>{plural(files.length, "file")} · {size(bytes(files))}</b> erased for good from {from}.
        {only.length > 0 && <> <b className="text-attention-ink">{only.length === files.length ? (files.length === 1 ? "It is the only copy" : "Each is the only copy") : `${only.length} of them ${only.length === 1 ? "is the only copy" : "are the only copy"}`}</b> <span className="text-attention-ink">({size(bytes(only))}): no other file with the same sha256 stays here.</span></>}
      </span>
      <div className="flex max-h-[220px] flex-col overflow-y-auto rounded-lg border border-line bg-panel">
        {sorted.map((f) => (
          <div key={f.id} className={cx("grid grid-cols-[minmax(0,1fr)_minmax(0,auto)_76px] gap-3 border-b border-line/60 px-3 py-1.5 last:border-b-0", !f.copies.length && "bg-attention-wash/50")}>
            <span className="truncate font-mono text-xs" data-tip={`${f.folder}/${f.file}`}>{f.folder}/{f.file}</span>
            {f.copies.length
              ? <span className="truncate text-xs text-ink-3" data-tip={f.copies.map((c) => placeOfId(c)).join(", ")}>a copy stays: {placeOfId(f.copies[0]!)}</span>
              : <span className="text-xs font-semibold text-attention-ink">{f.sha256 ? "the only copy" : "the only copy known (not hashed)"}</span>}
            <span className="text-right font-mono text-xs">{f.size === null ? "—" : size(f.size)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The list of a machine, read again on the server's "models" event (a file hashed, matched, added or moved). */
export const useModelFiles = (machine?: string) => useQuery({ queryKey: queryKeys.modelInfo.files(machine), queryFn: ({ signal }) => api.modelFiles(machine, { signal }), staleTime: 30_000 });

const HELP = "Every file in ComfyUI's model folders on this PC (extra_model_paths.yaml's folders too; one file that two of them reach is listed once, with its places): since when it is here, how often Afflatus's jobs loaded it, what was made with it, and what needs it. Afflatus sees only its own jobs: a render made straight in ComfyUI is not counted, so check before deleting a file you use there.";
const USES_HELP = "Afflatus jobs that loaded this file, counted from the graph each job sent to ComfyUI. ≈: some were counted from a job made before Afflatus kept each job's files, its helper files (VAE, text encoder…) read from today's recipe. Renders made straight in ComfyUI are not counted.";

/** The table's columns, folding as the card narrows: the base and what was made at 1240 px, the date and what needs it at 1000. */
const GRID = "grid grid-cols-[28px_40px_minmax(0,1fr)_118px_104px_76px_92px_52px_120px_84px_150px_18px] @max-[1240px]:grid-cols-[28px_40px_minmax(0,1fr)_118px_76px_92px_52px_120px_150px_18px] @max-[1000px]:grid-cols-[28px_40px_minmax(0,1fr)_118px_76px_52px_120px_18px] items-center gap-x-3";
const WIDE = "@max-[1240px]:hidden";
const MID = "@max-[1000px]:hidden";

/** Settings › Model files: its own tab, after Models. */
export function ModelFilesTab() {
  const client = useQueryClient();
  const [, go] = useLocation();
  const search = new URLSearchParams(useSearch());
  const family = search.get("family");
  const [machine, setMachine] = useState<string | undefined>(undefined);
  const lib = useModelFiles(machine);
  const families = useRecipes().data?.families ?? [];
  const [f, setF] = useState<Filters>({ ...NO_FILTER, family, sort: { key: "size", down: true } });
  // the family comes from the address (Settings › Models' "its files in Model files ›"): its ✕ takes it off the address too
  if (f.family !== family) setF((o) => ({ ...o, family }));
  const set = (patch: Partial<Filters>) => setF((o) => ({ ...o, ...patch }));
  const [open, setOpen] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const last = useRef<string | null>(null);
  const [asking, setAsking] = useState<ModelFile[] | null>(null);
  const [emptying, setEmptying] = useState(false);
  const drop = useDropFiles(lib.data);
  const said = useSayFailed({ id: "model-files", href: "/settings/model-files", go: "Settings › Model files" });
  const readAgain = () => void client.invalidateQueries({ queryKey: queryKeys.modelInfo.all() });
  const back = useMutation({ mutationFn: api.putBackModelFiles, onSuccess: (r) => r.left.length && useBanners.getState().push({ id: `model-files:${Date.now()}`, tone: "bad", title: `${plural(r.left.length, "file")} not put back`, text: r.left.map((l) => `${l.file}: ${l.why}`).join(" · ") }), onError: said("Could not put them back"), onSettled: readAgain });
  const empty = useMutation({ mutationFn: api.emptyModelFiles, onSuccess: (r) => useBanners.getState().push({ id: `model-files:${Date.now()}`, tone: "good", title: `Erased for good · ${plural(r.erased, "file")} · ${size(r.bytes)}` }), onError: said("Could not empty them"), onSettled: () => { setEmptying(false); readAgain(); } });

  const l = lib.data;
  const now = Date.now();
  const rows = useMemo(() => (l ? shown(l, f, now) : []), [l, f, now]);
  const figs = useMemo(() => (l ? figures(l, f.family, now) : null), [l, f.family, now]);
  if (lib.isError) return <ErrorNote>{lib.error.message}</ErrorNote>;
  if (!l || !figs) return <div className="flex items-center gap-2 text-ink-3"><Spinner /> Reading ComfyUI's model folders…</div>;

  const ro = l.readOnly;
  const live = rows.filter((x) => !x.removed);
  const picked = l.files.filter((x) => sel.has(x.id) && !x.removed);
  const pickedBytes = picked.reduce((n, x) => n + (x.size ?? 0), 0);
  // what Delete will ask about: a preset's or a set's file of which no copy stays (DeleteDialog's own rule)
  const staying = new Set(l.files.filter((x) => !x.removed && !sel.has(x.id)).map((x) => fileKey(x)));
  const needy = [...new Set(picked.filter((x) => !staying.has(fileKey(x)) && x.needs.some((n) => n.kind !== "family")).map((x) => fileKey(x)))];
  const allOn = live.length > 0 && live.every((x) => sel.has(x.id));
  const filtered = Boolean(f.family || f.q || f.kind !== "all" || f.idle !== "any" || f.copies || f.noMatch);
  const familyName = f.family ? families.find((x) => x.id === f.family)?.name ?? f.family : null;
  const counts = Object.fromEntries(KINDS.map((k) => [k, l.files.filter((x) => !x.removed && x.kind === k && (!f.family || x.families.includes(f.family))).length]));
  const day = (iso: string) => dayOf(iso, now);

  const toggle = (id: string, shift: boolean) => {
    const order = live.map((x) => x.id);
    setSel((s) => {
      const next = new Set(s);
      if (shift && last.current && order.includes(last.current) && order.includes(id)) {
        const [i, j] = [order.indexOf(last.current), order.indexOf(id)].sort((a, b) => a - b);
        const on = !s.has(id);
        for (const x of order.slice(i!, j! + 1)) if (on) next.add(x); else next.delete(x);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    last.current = id;
  };
  const sortBy = (key: SortKey) => set({ sort: f.sort.key === key ? { key, down: !f.sort.down } : { key, down: !["name", "kind", "base"].includes(key) } });
  const head = (key: SortKey, label: string, cls = "", tip?: string) => (
    <button type="button" onClick={() => sortBy(key)} data-tip={tip} className={cx("truncate text-left text-meta font-bold tracking-label uppercase hover:text-ink", f.sort.key === key ? "text-ink" : "text-ink-3", cls)}>
      {label}{f.sort.key === key ? (f.sort.down ? " ↓" : " ↑") : ""}
    </button>
  );
  const away = l.away;
  const binWord = l.bin ? "the Recycle Bin" : "the set-aside folder";

  return (
    <div {...drop.zone} className="relative flex flex-col gap-4">
      <section data-setting="modelFiles.list" className="@container overflow-hidden rounded-card border border-line bg-panel shadow-card">
        <div className="flex min-h-[48px] flex-wrap items-center gap-2.5 border-b border-line px-[18px] py-2.5">
          <h2 className="text-title font-bold">Model files</h2>
          <Help title="Model files" text={HELP} className="-ml-1" />
          {l.machines.length > 1 && <Segmented size="sm" label="Machine" value={l.machine} options={l.machines.map((m) => ({ value: m.id, label: m.name }))} onChange={(m) => { setMachine(m); setSel(new Set()); setOpen(null); }} />}
          <span className="grow" />
          <span className="font-mono text-xs text-ink-2">{plural(figs.total.files, "file")}{ro ? "" : ` · ${size(figs.total.bytes)}`}</span>
          <Button size="sm" tone="primary" onClick={() => openFindModels(thisPcTarget(client))}><Plus size={14} /> Find models</Button>
        </div>
        {ro && <div className="border-b border-line bg-picture/5 px-[18px] py-2 text-body text-ink-2">{l.machines.find((m) => m.id === l.machine)?.name}'s files, as its ComfyUI lists them: names only, no sizes. Delete is done on that machine. <Help text="Afflatus reads another machine's files through its ComfyUI (its last scan). It never deletes files there; a rented pod's volume has its own Files (Settings › Rented GPUs)." /></div>}
        {l.noFolder && !ro && <div className="border-b border-line px-[18px] py-3 text-body text-ink-2">No model folder is known on this PC: set ComfyUI's folder in Settings › ComfyUI › Folder on this computer. Files can then be listed, dropped here and deleted.</div>}
        {!ro && l.hashing.files > l.hashing.hashed && (
          <div className="flex items-center gap-3 border-b border-line px-[18px] py-2 text-body">
            <span className="font-mono text-xs">Hashing {l.hashing.hashed} of {l.hashing.files}</span>
            <span className="h-1.5 w-40 overflow-hidden rounded-full bg-line"><span className="block h-full bg-accent" style={{ width: `${(l.hashing.hashed / Math.max(1, l.hashing.files)) * 100}%` }} /></span>
            <span className="text-ink-2">names, pictures and copies come as each file is hashed</span>
            <Help text="Each file's sha256 is read once (kept with its size and date, so only new or changed files are read again), then looked up on Civitai and Hugging Face. Sizes, dates and uses are known already: sorting and deleting work meanwhile." />
          </div>
        )}
        {!ro && (
          <div className="grid grid-cols-4 gap-4 border-b border-line px-[18px] py-4 @max-[1000px]:grid-cols-2">
            <Figure big={size(figs.total.bytes)} said={`in ${plural(figs.total.files, "file")}${familyName ? ` of ${familyName}` : ""}`} />
            <Figure big={size(figs.idle.bytes)} tone="attention" said={<>{idleWords(figs.idle.never, l.since, day)} · {plural(figs.idle.files.length, "file")} <Help text={idleHelp(figs.idle.never, l.since, day)} /></>}
              acts={[{ label: "Select them", on: () => setSel(new Set(figs.idle.files.map((x) => x.id))), off: !figs.idle.files.length }, { label: "Show them", on: () => set({ idle: figs.idle.filter }) }]} />
            <Figure big={size(figs.extra.bytes)} said={<>in {plural(figs.extra.files.length, "extra copy", "extra copies")} of the same file <Help text="The same sha256 in two files on disk: the same model kept twice. One file ComfyUI reaches through two folders (extra_model_paths.yaml listing a folder twice) is not a copy: it is listed once, with its places. Select the copies keeps the one Afflatus used most and selects the others." /></>}
              acts={[{ label: "Select the copies", on: () => setSel(new Set(figs.extra.files.map((x) => x.id))), off: !figs.extra.files.length }, { label: "Show them", on: () => set({ copies: true }) }]} />
            <Figure big={plural(figs.noMatch, "file")} said={<>with no match on Civitai or Hugging Face <Help text="Matched by sha256 on Civitai, by name and hash on Hugging Face. No match: trained or merged here, renamed and re-saved, or taken down." /></>}
              acts={[{ label: "Show them", on: () => set({ noMatch: true }) }]} />
            <SpaceBar bands={figs.bands} idle={f.idle} onBand={(b) => set({ idle: f.idle === b ? "any" : b })} />
          </div>
        )}
        {away.files > 0 && !ro && (
          <div className="flex flex-wrap items-center gap-2.5 border-b border-line bg-good/5 px-[18px] py-2.5 text-body">
            <span className="text-good">●</span>
            <span><b>{plural(away.files, "file")} · {size(away.bin + away.aside)}</b> deleted from here, kept in {away.bin && away.aside ? "the Recycle Bin and the set-aside folder" : away.bin ? "the Recycle Bin" : "the set-aside folder"}. <span className="text-ink-2">The space comes back once they are emptied.</span></span>
            <Help text={`They stay listed, greyed, until they are put back or emptied. Put back returns each one to its own folder.${away.bin ? ` In the Recycle Bin: ${size(away.bin)} (Windows' own Restore puts them back too, and Windows erases the oldest of the bin when it fills).` : ""}${away.aside ? ` In the set-aside folder (.afflatus-set-aside, beside the model folders): ${size(away.aside)}.` : ""} Empty erases them for good; agents (MCP) cannot.`} />
            <span className="grow" />
            <Button size="sm" disabled={back.isPending} onClick={() => back.mutate({ ids: l.files.filter((x) => x.removed).map((x) => x.removed!.id) })}>Put all back</Button>
            {emptying
              ? <TwoStep open tone="danger" title="Empty" note="This cannot be undone." yes={`Erase ${size(away.bin + away.aside)} for good`} busy={empty.isPending} onCancel={() => setEmptying(false)} onYes={() => empty.mutate()} />
              : <Button size="sm" tone="danger" disabled={empty.isPending} onClick={() => setEmptying(true)}>Empty · {size(away.bin + away.aside)}</Button>}
          </div>
        )}
        {emptying && away.files > 0 && !ro && <EmptyAsk files={l.files.filter((x) => x.removed)} from={away.bin && away.aside ? "the Recycle Bin and the set-aside folder" : away.bin ? "the Recycle Bin" : "the set-aside folder"} />}
        <AddingStrip drop={drop} />
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-[18px] py-2.5">
          {familyName && <Chip size="sm" onRemove={() => go("/settings/model-files")} removeLabel="Every family again">Family: {familyName}</Chip>}
          {f.noMatch && <Chip size="sm" onRemove={() => set({ noMatch: false })} removeLabel="Every file again">No match</Chip>}
          <div className="w-64 @max-[1000px]:w-44"><SearchField size={32} value={f.q} onChange={(q) => set({ q })} label="Search the model files" placeholder="Search by name, file, base model" /></div>
          <div className="flex flex-wrap gap-1">
            <Chip size="sm" tone={f.kind === "all" ? "accent" : "neutral"} onClick={() => set({ kind: "all" })}>All <span className="font-mono text-ink-3">{figs.total.files}</span></Chip>
            {KINDS.filter((k) => counts[k]).map((k) => <Chip key={k} size="sm" tone={f.kind === k ? "accent" : "neutral"} onClick={() => set({ kind: f.kind === k ? "all" : k })}>{KIND_PLURAL[k] ?? k} <span className="font-mono text-ink-3">{counts[k]}</span></Chip>)}
          </div>
          <span className="grow" />
          {!ro && (
            <span className="flex items-center gap-2 text-xs text-ink-3">Not used for
              <Help text={`Days since an Afflatus job last loaded the file (since it is here, or since ${l.since ? day(l.since) : "Afflatus began keeping each job's files"}, for one never used). Never used: no Afflatus job has loaded it since ${l.since ? day(l.since) : "then"}. Renders made straight in ComfyUI are not seen.`} />
              <Segmented size="sm" label="Not used by Afflatus for" value={f.idle === "idle" ? "90" : ["any", "30", "90", "never"].includes(f.idle) ? f.idle : "any"} options={[{ value: "any", label: "any time" }, { value: "30", label: "30+ days" }, { value: "90", label: "90+ days" }, { value: "never", label: "never used" }]} onChange={(idle) => set({ idle: idle as Filters["idle"] })} />
            </span>
          )}
          {!ro && <Chip size="sm" tone={f.copies ? "accent" : "neutral"} onClick={() => set({ copies: !f.copies })} tip="The models kept twice or more: the same sha256 in other files on disk">Copies</Chip>}
        </div>
        <div className={cx("flex min-h-[44px] items-center gap-3 border-b border-line px-[18px] py-1.5", picked.length > 0 && "bg-accent-wash/40")}>
          <Checkbox checked={allOn ? true : live.some((x) => sel.has(x.id)) ? "some" : false} disabled={ro} label={`Select the ${plural(live.length, "file")} shown`} onChange={() => setSel(allOn ? new Set() : new Set(live.map((x) => x.id)))} />
          <button type="button" disabled={ro} onClick={() => setSel(allOn ? new Set() : new Set(live.map((x) => x.id)))} className="text-body text-accent hover:underline disabled:text-ink-3 disabled:no-underline">Select all {live.length} shown</button>
          <span className="h-4 w-px bg-line-strong" />
          {picked.length
            ? <span className="flex items-center gap-2 text-body"><b>{plural(picked.length, "file")} selected · {size(pickedBytes)}</b>{needy.length > 0 && <Chip size="xs" tone="attention" tip="A preset or a model set needs them: Delete asks first">{plural(needy.length, "needed by a preset or set", "needed by a preset or set")}</Chip>}<button type="button" className="text-xs text-ink-3 underline hover:text-ink" onClick={() => setSel(new Set())}>Clear</button></span>
            : <span className="text-body text-ink-2">{filtered ? `${plural(rows.length, "file")} shown · ${size(rows.reduce((n, x) => n + (x.size ?? 0), 0))}` : "Click a box to select, shift-click for a range"}</span>}
          <span className="grow" />
          <Button size="sm" tone="danger" disabled={!picked.length || ro} data-tip={ro ? "Another machine's files are deleted on that machine" : `Moves the selected files to ${binWord}; asks first, and again for a file a preset or a model set needs. Agents (MCP) cannot do this: it is on their never-list.`} onClick={() => setAsking(picked)}>
            Delete{picked.length ? ` ${plural(picked.length, "file")}` : ""}
          </Button>
        </div>
        <div role="table" aria-label="Model files" className="flex flex-col">
          <div role="row" className={cx(GRID, "border-b border-line px-[18px] py-2")}>
            <span /><span />
            {head("name", "Name · file")}
            {head("kind", "Kind")}
            <span className={WIDE}>{head("base", "Base")}</span>
            {head("size", "Size", "text-right w-full")}
            <span className={MID}>{head("added", "Here since", "", "The file's date on disk")}</span>
            <span className="flex justify-end">{head("uses", "Uses", "text-right", USES_HELP)}</span>
            {head("last", "Last used")}
            <span className={WIDE}>{head("takes", "Made")}</span>
            <span className={cx(MID, "text-meta font-bold tracking-label text-ink-3 uppercase")}>Needed by</span>
            <span />
          </div>
          {rows.slice(0, 600).map((x) => {
            const ls = lastSaid(x, l.since, day, (iso) => when(iso, now));
            const isOpen = open === x.id;
            const gone = Boolean(x.removed);
            return (
              <div key={x.id} className="border-b border-line/60 last:border-b-0">
                <div role="row" onClick={(e) => (e.shiftKey && !ro && !gone ? toggle(x.id, true) : setOpen(isOpen ? null : x.id))} className={cx(GRID, "min-h-[52px] cursor-pointer px-[18px] py-1.5 hover:bg-hover", sel.has(x.id) && "bg-accent-wash/40", isOpen && "bg-raised", gone && "opacity-60")}>
                  <span onClickCapture={(e) => { e.stopPropagation(); if (!ro && !gone) toggle(x.id, e.shiftKey); }}>
                    <Checkbox checked={sel.has(x.id)} disabled={ro || gone} label={`Select ${nameOf(x)}`} onChange={() => {}} />
                  </span>
                  <Picture f={x} small />
                  <span className="flex min-w-0 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-semibold">{nameOf(x)}</span>
                      {x.version && x.name && <span className="shrink-0 truncate text-xs text-ink-3">{x.version}</span>}
                      {gone && <Chip size="xs" tone="good">{x.removed!.place === "bin" ? "in the bin" : "set aside"}</Chip>}
                      {!gone && x.copies.length > 0 && <Chip size="xs" tone="attention" tip={`The same model in another file: ${x.copies.map((c) => placeOfId(c)).join(", ")}`}>copy</Chip>}
                      {!gone && x.also.length > 0 && <Chip size="xs" tip={`The same file on disk, also seen as ${x.also.map((a) => `${a.folder}/${a.file}`).join(", ")}: not a copy (a folder extra_model_paths.yaml lists twice)`}>{x.also.length + 1} places</Chip>}
                      {!gone && x.match === "pending" && !ro && <Chip size="xs" tip="Not hashed yet: its Civitai or Hugging Face match comes once it is">hashing…</Chip>}
                      {!gone && x.match === "none" && <Chip size="xs" tip="No match on Civitai or Hugging Face">no match</Chip>}
                    </span>
                    <span className="truncate font-mono text-xs text-ink-3" data-tip={`${x.folder}/${x.file}`}>{x.folder}/{x.file}</span>
                  </span>
                  <span className="flex min-w-0 flex-col text-body"><span className="truncate">{x.kind}</span><span className="hidden truncate text-xs text-ink-3 @max-[1240px]:block">{x.base ?? "—"}</span></span>
                  <span className={cx(WIDE, "truncate text-body text-ink-2")}>{x.base ?? "—"}</span>
                  <span className="text-right font-mono text-xs">{x.size === null ? "—" : size(x.size)}</span>
                  <span className={cx(MID, "text-body text-ink-2")}>{x.mtime ? day(new Date(x.mtime).toISOString()) : "—"}</span>
                  <span className="text-right font-mono text-xs" data-tip={x.approx ? "≈: some counted from a job made before Afflatus kept each job's files" : undefined}>{x.uses ? `${x.approx ? "≈" : ""}${x.uses}` : <span className="text-ink-3">0</span>}</span>
                  <span className={cx("truncate text-body", ls.idle && "text-attention-ink")} data-tip={ls.tip}>
                    {gone ? <Button size="sm" onClick={(e) => { e.stopPropagation(); back.mutate({ ids: [x.removed!.id] }); }}>Put back</Button> : ls.text}
                  </span>
                  <span className={cx(WIDE, "font-mono text-xs text-ink-2")}>{x.takes ? plural(x.takes, "take") : <span className="text-ink-3">—</span>}</span>
                  <span className={cx(MID, "flex min-w-0 gap-1")}>
                    {x.needs.length ? <NeedChips f={x} /> : <span className="text-xs text-ink-3">—</span>}
                  </span>
                  <ChevronRight size={14} className={cx("text-ink-3 transition-transform", isOpen && "rotate-90")} />
                </div>
                {isOpen && <ModelFileDetail f={x} lib={l} onDelete={() => setAsking([x])} onPutBack={() => back.mutate({ ids: [x.removed!.id] })} />}
              </div>
            );
          })}
          {rows.length > 600 && <div className="px-[18px] py-3 text-body text-ink-3">{rows.length - 600} more: narrow the list with the search or the filters.</div>}
          {!rows.length && (
            <div className="flex flex-col items-center gap-2 px-[18px] py-10 text-center">
              <h3 className="text-title font-semibold">{l.files.length ? "No file matches" : "No model file in ComfyUI's model folders"}</h3>
              <p className="text-body text-ink-2">{l.files.length ? `Nothing${f.q ? ` named "${f.q}"` : ""} with these filters.` : "Fetch a family's files or any model with Find models, or drop model files here: each goes to its kind's folder."}</p>
              {l.files.length > 0 && <Button size="sm" onClick={() => { go("/settings/model-files"); setF({ ...NO_FILTER, sort: f.sort }); }}>Show every file</Button>}
            </div>
          )}
        </div>
      </section>
      {drop.over && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-card border-2 border-dashed border-accent bg-panel/85 text-title font-semibold">
          Drop model files: each goes to its kind's folder
        </div>
      )}
      {asking && <DeleteDialog files={asking} all={l.files} bin={l.bin} since={l.since} onClose={() => setAsking(null)} onDone={(ids) => setSel((s) => new Set([...s].filter((x) => !ids.includes(x))))} />}
    </div>
  );
}

/** One of the figures on top, with what it selects or shows. */
function Figure({ big, said, acts = [], tone }: { big: string; said: ReactNode; acts?: Array<{ label: string; on(): void; off?: boolean }>; tone?: "attention" }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <b className={cx("font-mono text-display leading-tight", tone === "attention" && "text-attention-ink")}>{big}</b>
      <span className="text-body text-ink-2">{said}</span>
      {acts.length > 0 && (
        <span className="flex gap-3">
          {acts.map((a) => <button key={a.label} type="button" disabled={a.off} onClick={a.on} className="text-xs text-accent hover:underline disabled:text-ink-3 disabled:no-underline">{a.label}</button>)}
        </span>
      )}
    </div>
  );
}

/** The space by last use in Afflatus: a band clicked shows only its files, again for all. */
function SpaceBar({ bands, idle, onBand }: { bands: ReturnType<typeof figures>["bands"]; idle: Filters["idle"]; onBand(b: (typeof BANDS)[number]["id"]): void }) {
  // "30+" and "90+" take in the never-used files here that long: their band stays lit with them
  const lit: Record<string, string[]> = { 30: ["quarter", "idle", "never"], 90: ["idle", "never"] };
  const dim = (id: string) => idle !== "any" && idle !== id && !lit[idle]?.includes(id);
  return (
    <div className="col-span-4 flex flex-col gap-2 @max-[1000px]:col-span-2">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-line">
        {bands.map((b) => b.bytes > 0 && <button key={b.id} type="button" aria-label={b.label} data-tip-head={b.label} data-tip={`${size(b.bytes)} · ${plural(b.files, "file")} · click to show only these`} onClick={() => onBand(b.id)} className={cx(b.tone, dim(b.id) && "opacity-30")} style={{ flex: b.bytes }} />)}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {/* an empty band is left out (31–90 days cannot fill before the records are that old), unless it is the one shown */}
        {bands.filter((b) => b.bytes > 0 || idle === b.id).map((b) => (
          <button key={b.id} type="button" onClick={() => onBand(b.id)} className={cx("flex items-center gap-1.5 text-ink-2 hover:text-ink", idle === b.id && "font-semibold text-ink")}>
            <i className={cx("size-2.5 rounded-sm", b.tone)} />{b.short} <span className="font-mono">{size(b.bytes)}</span>
          </button>
        ))}
        <span className="grow" />
        <span className="text-ink-3">space by last use in Afflatus</span>
      </div>
    </div>
  );
}

/** What needs a file, two at most and a count: presets and sets first (Delete asks for them), then families. */
export function NeedChips({ f, most = 2 }: { f: ModelFile; most?: number }) {
  const order = { preset: 0, set: 1, family: 2 } as const;
  const needs = [...f.needs].sort((a, b) => order[a.kind] - order[b.kind]);
  const tip = needs.map((n) => `${n.kind === "preset" ? "Preset" : n.kind === "set" ? "Model set" : "Family"}: ${n.name}`).join("\n");
  return (
    <span className="flex min-w-0 gap-1" data-tip-head="Needed by" data-tip={tip}>
      {needs.slice(0, most).map((n) => <Chip key={`${n.kind}:${n.id}`} size="xs" tone={n.kind === "family" ? "neutral" : "accent"} truncate>{n.kind === "set" ? `set · ${n.name}` : n.name}</Chip>)}
      {needs.length > most && <Chip size="xs">+{needs.length - most}</Chip>}
    </span>
  );
}

/** The first figure's words: "never used by Afflatus · since 1 Oct" while the records are under 90 days old. */
export const idleWords = (never: boolean, since: string | null, day: (iso: string) => string) =>
  never ? `never used by Afflatus${since ? ` · since ${day(since)}` : ""}` : "not used by Afflatus for 90 days";

const idleHelp = (never: boolean, since: string | null, day: (iso: string) => string) =>
  (never
    ? `Files no Afflatus job has loaded since ${since ? day(since) : "Afflatus began keeping each job's files"}, when Afflatus began keeping each job's files: "not used for 90 days" can be said once that is 90 days ago.`
    : `Files no Afflatus job has loaded for 90 days or more, the ones never used by Afflatus here that long among them${since ? ` (Afflatus keeps each job's files since ${day(since)})` : ""}.`)
  + " Renders made straight in ComfyUI are not seen, so check before deleting one you use there.";

/** For other parts of Settings: the files of this PC the first figure of Model files counts (see idleFiles). */
export function idleSummary(l: ModelLibrary | undefined, now = Date.now()): { bytes: number; files: number; never: boolean; since: string | null } | null {
  if (!l || l.readOnly || !l.since) return null;
  const idle = idleFiles(l.files.filter((f) => !f.removed), l.since, now);
  return { bytes: idle.files.reduce((n, f) => n + (f.size ?? 0), 0), files: idle.files.length, never: idle.never, since: l.since };
}


/** Where the Models line was closed, by the space not used then (bytes): it comes back only once that grew by RISE. */
const LINE_CLOSED = "afflatus.modelFilesLine";
const RISE = 100 * 2 ** 30;

/**
 * Settings › Models' one line, as Model files' first figure: the space never used by Afflatus since it began keeping
 * each job's files (under 90 days ago), else the space no Afflatus job has used for 90 days; and the way to Model files.
 * Closed, it comes back only once that space grew by about another 100 GB. An install that has kept no job's files has
 * no line.
 */
export function ModelFilesLine() {
  const lib = useModelFiles();
  const [closedAt, setClosedAt] = useState(() => Number(localStorage.getItem(LINE_CLOSED) ?? "NaN"));
  const idle = idleSummary(lib.data);
  if (!idle?.files || (Number.isFinite(closedAt) && idle.bytes < closedAt + RISE)) return null;
  const close = () => {
    localStorage.setItem(LINE_CLOSED, String(idle.bytes));
    setClosedAt(idle.bytes);
  };
  return (
    <div className="flex items-center gap-3 border-b border-line/60 px-[18px] py-2 text-body">
      <span className="grow"><b className="font-semibold text-attention-ink">{size(idle.bytes)}</b> {idleWords(idle.never, idle.since, (iso) => dayOf(iso))} · {plural(idle.files, "file")}</span>
      <Link href="/settings/model-files" className="shrink-0 text-accent hover:underline">Model files ›</Link>
      <CloseButton size={28} label="Close this line" onClose={close} />
    </div>
  );
}
