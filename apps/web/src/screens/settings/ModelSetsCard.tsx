import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { fileKey } from "@afflatus/core";
import { api, type ModelSet, type PresetFile, type SetFile } from "../../api";
import { useSettings } from "../../data";
import { gb, plural, size } from "../../format";
import { machineLabel } from "../../machines";
import { openFindModels } from "../../findModels/store";
import { ModelSearch, ViaChip } from "../../modelFilesUi";
import { queryKeys } from "../../queryKeys";
import { Select } from "../../Select";
import { useSayFailed } from "../../sayFailed";
import { Button, ButtonLink, Chip, cx, fieldClass, Help, TwoStep } from "../../ui";
import { Block, Card } from "./Rows";

const WHY_SETS = "A Model set is a named list of model files, nothing else: no form, no values (presets stay the start of a form in Studio). Pick one in Deploy a GPU, and the pod gets its files after what your jobs need; or get its missing files on any of your machines here. A set holds presets by reference: a preset moved to a new version moves the set. Save one as a file to share it: it holds the names, sizes and where each comes from, never the files.";
type Body = { name: string; presets: string[]; files: PresetFile[]; off: string[] };
const bodyOf = (s: ModelSet) => ({ name: s.name, presets: s.presets.map((p) => p.id), files: s.files, off: s.off });

/** Settings › Models' second column: the Model sets, each opened in place to see and change its files. */
export function ModelSetsCard() {
  const client = useQueryClient();
  const sets = useQuery({ queryKey: queryKeys.modelSets.all(), queryFn: ({ signal }) => api.modelSets({ signal }) });
  const [open, setOpen] = useState<string | null>(null);
  const sayFailed = useSayFailed({ href: "/settings/models", go: "Open Settings › Models" });
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.modelSets.all() });
  const make = useMutation({ mutationFn: () => api.saveModelSet(null, { name: "New set", presets: [], files: [], off: [] }), onSuccess: (s) => { void refresh(); setOpen(s.id); }, onError: sayFailed("The set was not made") });
  const file = useRef<HTMLInputElement>(null);
  const bring = useMutation({ mutationFn: async (f: File) => api.importModelSet(JSON.parse(await f.text()) as unknown), onSuccess: (s) => { void refresh(); setOpen(s.id); }, onError: sayFailed("The set was not brought in") });
  const items = sets.data?.items ?? [];
  return (
    <Card setting="models.sets" title={<span className="flex items-center gap-1.5">Model sets <Help title="Model sets" text={WHY_SETS} /></span>} status={
      <span className="flex items-center gap-2">
        <span className="text-xs text-ink-3">for a pod, a new PC, a friend</span>
        <Button size="sm" onClick={() => file.current?.click()}>Import</Button>
        <Button size="sm" tone="primary" onClick={() => make.mutate()} disabled={make.isPending}><Plus size={13} /> New set</Button>
        <input ref={file} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) bring.mutate(f); e.target.value = ""; }} />
      </span>
    }>
      {sets.isSuccess && !items.length && <Block><span className="text-xs text-ink-3">None yet. A set is made here, from Deploy a GPU's ticks (Save these as a set), or brought in from a file.</span></Block>}
      {items.map((s) => (
        <div key={s.id} className="flex flex-col">
          <button type="button" onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id} className="flex items-center gap-2.5 px-[18px] py-3 text-left text-[13px] hover:bg-hover">
            {open === s.id ? <ChevronDown size={14} className="text-ink-3" /> : <ChevronRight size={14} className="text-ink-3" />}
            <span className="font-semibold">{s.name}</span>
            <span className="text-ink-3">{[s.presets.length ? plural(s.presets.length, "preset") : "", plural(s.count, "file"), s.bytes ? gb(s.bytes) : ""].filter(Boolean).join(" · ")}</span>
            {s.presets.some((p) => p.gone) && <Chip tone="warn" className="h-5 text-[11px]">a preset is gone</Chip>}
          </button>
          {open === s.id && <SetEditor set={s} onChanged={refresh} onGone={() => { setOpen(null); void refresh(); }} />}
        </div>
      ))}
    </Card>
  );
}

/** One set opened: its name, its presets' files and its own, where each is, what to add, and what to do with it. */
function SetEditor({ set, onChanged, onGone }: { set: ModelSet; onChanged(): void; onGone(): void }) {
  const client = useQueryClient();
  const settings = useSettings();
  const machines = settings.data?.machines ?? [];
  const files = useQuery({ queryKey: queryKeys.modelSets.files(set.id), queryFn: ({ signal }) => api.modelSetFiles(set.id, { signal }) });
  const sayFailed = useSayFailed({ href: "/settings/models", go: "Open Settings › Models" });
  // each change is made on the set as it stands after the ones before (not as the page last read it), and sent after them:
  // two quick changes never undo each other
  const latest = useRef<Body>(bodyOf(set));
  const saving = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!saving.current) latest.current = bodyOf(set);
  }, [set]);
  const change = (next: (b: Body) => Body) => {
    const body = (latest.current = next(latest.current));
    saving.current++;
    queue.current = queue.current
      .then(() => api.saveModelSet(set.id, body))
      .then(() => {
        onChanged();
        void client.invalidateQueries({ queryKey: queryKeys.modelSets.files(set.id) });
      }, sayFailed("The set was not saved"))
      .finally(() => void saving.current--);
  };
  const [name, setName] = useState(set.name);
  const [machine, setMachine] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const get = useMutation({
    mutationFn: (accept: boolean) => api.getModelSetFiles(set.id, { ...(machine ? { machine } : {}), ...(accept ? { accept } : {}) }),
    onSuccess: (r) => { setAsked(null); void client.invalidateQueries({ queryKey: queryKeys.modelSets.files(set.id) }); setGot(`${plural(r.sent, "file")} on the way${r.skipped ? ` · ${plural(r.skipped, "file")} with no source, not fetched` : ""}${r.failed.length ? ` · ${plural(r.failed.length, "file")} refused: ${r.failed[0]!.error}` : ""}`); },
    // a preset's licence not accepted yet: said, and asked
    onError: (err: Error) => (/accept it first/.test(err.message) ? setAsked(err.message) : sayFailed("The missing files were not fetched")(err)),
  });
  const [got, setGot] = useState("");
  const duplicate = useMutation({ mutationFn: () => api.duplicateModelSet(set.id), onSuccess: onChanged, onError: sayFailed("The set was not duplicated") });
  const remove = useMutation({ mutationFn: () => api.deleteModelSet(set.id), onSuccess: onGone, onError: sayFailed("The set was not deleted") });
  const items = files.data?.items ?? [];
  const groups = [...set.presets.map((p) => ({ title: p.name, sub: p.gone ? "preset · gone" : p.licence ? `preset · ${p.licence.name}${p.accepted ? "" : " (not accepted yet)"}` : "preset", id: p.id, files: items.filter((f) => f.preset?.id === p.id) })), { title: "Files", sub: "LoRAs, upscalers, any model file", id: "", files: items.filter((f) => !f.preset) }];
  const toggle = (f: SetFile) => {
    if (f.preset) return change((b) => ({ ...b, off: f.off ? b.off.filter((k) => k !== fileKey(f)) : [...b.off, fileKey(f)] }));
    change((b) => ({ ...b, files: b.files.filter((x) => fileKey(x) !== fileKey(f)) }));
  };
  const add = (over: { presets?: string[]; files?: PresetFile[] }) =>
    change((b) => ({ ...b, presets: [...new Set([...b.presets, ...(over.presets ?? [])])], files: [...b.files, ...(over.files ?? []).filter((f) => !b.files.some((x) => fileKey(x) === fileKey(f)))] }));
  return (
    <div className="flex flex-col gap-3 bg-raised/40 px-[18px] pt-1 pb-4 pl-[42px]">
      <span className="flex items-center gap-2">
        <input aria-label="The set's name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name.trim() !== latest.current.name && change((b) => ({ ...b, name: name.trim() }))} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} className={cx(fieldClass, "h-8 w-64 px-2.5 text-[13px] font-semibold")} />
        <span className="grow" />
        <ButtonLink size="sm" href={`/api/model-sets/${encodeURIComponent(set.id)}/export`} download>Save as a file</ButtonLink>
        <Button size="sm" onClick={() => duplicate.mutate()} disabled={duplicate.isPending}>Duplicate</Button>
        <TwoStep label="Delete" title={`Delete ${set.name}?`} yes="Delete" note="the set only: no file is deleted" onYes={() => remove.mutate()} />
      </span>
      {files.isPending && <span className="text-xs text-ink-3">Asking your machines what they have…</span>}
      {groups.filter((g) => g.id === "" || set.presets.some((p) => p.id === g.id)).map((g) => (
        <div key={g.id || "own"} className="flex flex-col gap-1">
          <span className="text-[12.5px] font-semibold">{g.title}<span className="font-normal text-ink-3"> · {g.sub}</span>
            {g.id && <button type="button" onClick={() => change((b) => ({ ...b, presets: b.presets.filter((id) => id !== g.id) }))} className="ml-2 text-xs font-normal text-ink-3 hover:text-ink">take it out</button>}
          </span>
          {g.files.map((f) => (
            <div key={fileKey(f)} className={cx("grid grid-cols-[minmax(0,1fr)_64px_minmax(0,180px)_64px_20px] items-center gap-3 text-[12.5px]", f.off && "opacity-50")}>
              <span className="min-w-0 truncate">{f.file}<span className="text-ink-3"> · {f.folder}</span></span>
              <ViaChip via={f.via} />
              <span className="min-w-0 truncate text-xs text-ink-3">{machines.filter((m) => m.id in f.on).map((m) => `${machineLabel(m)} ${f.on[m.id] ? "✓" : "–"}`).join(" · ")}</span>
              <span className="text-right font-mono text-xs text-ink-3">{f.size ? size(f.size) : "–"}</span>
              <button type="button" aria-label={f.preset ? (f.off ? `Put ${f.file} back in the set` : `Leave ${f.file} out of the set`) : `Take ${f.file} out`} data-tip={f.preset ? (f.off ? "Put it back in the set" : "Leave it out of the set (the preset keeps it)") : "Take it out of the set"} onClick={() => toggle(f)} className="grid size-5 place-items-center rounded text-ink-3 hover:bg-hover hover:text-ink">{f.off ? <Plus size={12} /> : <X size={12} />}</button>
            </div>
          ))}
          {!g.files.length && files.isSuccess && <span className="text-xs text-ink-3">{g.id ? "Its files are in another part of the set, or it names none." : "None: add one below."}</span>}
        </div>
      ))}
      <span className="flex items-center gap-2">
        <span className="min-w-0 grow"><ModelSearch presetNote="its files follow it" onPick={(p) => (p.kind === "preset" ? add({ presets: [p.hit.id] }) : add({ files: (p.kind === "file" ? [p.hit] : p.hit.files).map(({ via: _via, ...f }) => f) }))} /></span>
        <Button size="sm" onClick={() => openFindModels({ what: latest.current.name, action: "Add to the set", add: (picked) => add({ files: picked.map(({ via: _via, from: _from, size: s, ...f }) => ({ ...f, ...(s ? { size: s } : {}) })) }) })}>Find more…</Button>
      </span>
      <span className="flex flex-wrap items-center gap-2 text-xs">
        <Button size="sm" onClick={() => get.mutate(false)} disabled={get.isPending}>Get the missing</Button>
        {machines.length > 1 && (
          <span className="flex items-center gap-1.5 text-ink-3">on
            <span className="w-[160px]"><Select size="sm" label="On which machine" value={machine || machines[0]!.id} onChange={(id) => setMachine(id === machines[0]!.id ? "" : id)} options={machines.map((m) => ({ value: m.id, label: machineLabel(m) }))} /></span>
          </span>
        )}
        {got && <span className="text-ink-2">{got}</span>}
      </span>
      {asked && (
        <span className="flex flex-wrap items-center gap-2 text-xs text-warn-ink">
          {asked}
          <Button size="sm" onClick={() => get.mutate(true)}>Accept and get them</Button>
        </span>
      )}
    </div>
  );
}
