import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Search, X } from "lucide-react";
import { api, type DeployAsk, type DeployFile, type DeployModels as View, type FileVia, type MeasuredRange, type PresetFile } from "./api";
import { est, gb, plural, size, usd } from "./format";
import { useDebounced } from "./hooks";
import { queryKeys } from "./queryKeys";
import { Select } from "./Select";
import { Button, Checkbox, Chip, cx, fieldClass, Help } from "./ui";

const VIA_SAID: Record<FileVia, string> = { hf: "HF", civitai: "Civitai", url: "web", upload: "this PC" };
const WHY_MODELS = "What the pod gets once it is up, straight from Hugging Face or Civitai (a file no site is known for is sent from this PC). Your waiting jobs' files come first, in the order the queue needs them: a job starts as soon as its own files are there. A job whose file you untick stays home. Fetching is billed GPU time: the time and price are measured on your own deploys (the speeds of each source), or not said. A file fetched never keeps the pod: with nothing to render it goes idle and ends on time.";
const keyOf = (f: { folder: string; file: string }) => `${f.folder}|${f.file.toLowerCase()}`;

/** What the Models part asks the deploy to bring: the files ticked, the job files left out, the licences accepted, and whether it may go. */
export interface ModelsPicked {
  files: PresetFile[];
  leaveOut: Array<{ file: string; folder: string }>;
  accept: string[];
  /** Every licence of the ticked files accepted. */
  ready: boolean;
  /** Bytes ticked, as far as known: the disk proposed. */
  bytes: number;
}

/** A file's line: its box, its name, what it is for, where it comes from, its size. */
function FileRow({ f, on, onChange, note, dim, disabled }: { f: DeployFile; on: boolean; onChange?(on: boolean): void; note?: string; dim?: boolean; disabled?: boolean }) {
  return (
    <div className={cx("grid grid-cols-[minmax(0,1fr)_auto_64px] items-center gap-3 py-1 text-[13px]", dim && "opacity-55")}>
      <Checkbox checked={on} disabled={disabled || !onChange} onChange={(v) => onChange?.(v)} className="min-w-0">
        <span className="min-w-0 truncate">{f.file}<span className="text-ink-3"> · {f.folder}{note ? ` · ${note}` : ""}</span></span>
      </Checkbox>
      {f.via ? <Chip tone={f.via === "upload" ? "warn" : "neutral"} className="h-5 px-2 text-[11px]">{VIA_SAID[f.via]}</Chip> : <Chip tone="warn" className="h-5 px-2 text-[11px]">no source</Chip>}
      <span className="text-right font-mono text-xs text-ink-3">{f.size ? size(f.size) : "–"}</span>
    </div>
  );
}

/** How long these files take, slowest to fastest (ms), at the speeds measured; null when a source of them was never measured. */
function timeOf(files: DeployFile[], speeds: View["speeds"]): { fast: number; slow: number } | null {
  let fast = 0;
  let slow = 0;
  for (const f of files) {
    if (!f.size || !f.via) continue;
    const r: MeasuredRange | null = speeds[f.via];
    if (!r) return null;
    fast += (f.size / r.high) * 1000;
    slow += (f.size / r.low) * 1000;
  }
  return { fast, slow };
}

/**
 * Deploy a GPU's Models: the waiting jobs' files (ticked), a Model set's, and any file found by words; what that comes to,
 * and what it takes and costs before the first render, from what earlier deploys measured.
 */
export function DeployModels({ want, set, rate, onPicked }: { want: DeployAsk; set(change: Partial<DeployAsk>): void; rate: number | null; onPicked(p: ModelsPicked): void }) {
  const view = useQuery({ queryKey: queryKeys.deployModels(want.cloud, want.set), queryFn: ({ signal }) => api.deployModels(want.cloud, want.set, { signal }), staleTime: 15_000, retry: false });
  const sets = useQuery({ queryKey: queryKeys.modelSets.all(), queryFn: ({ signal }) => api.modelSets({ signal }), staleTime: 30_000 });
  const [jobOff, setJobOff] = useState<Set<string>>(() => new Set());
  const [setOff, setSetOff] = useState<Set<string> | null>(null);
  const [added, setAdded] = useState<DeployFile[]>([]);
  const [accept, setAccept] = useState<Set<string>>(() => new Set());
  const [q, setQ] = useState("");
  const searched = useDebounced(q.trim(), 250, true, "");
  const found = useQuery({ queryKey: queryKeys.modelSets.search(searched), queryFn: ({ signal }) => api.searchModelSets(searched, { signal }), enabled: searched.length > 1, staleTime: 30_000 });
  const v = view.data;
  // a set picked anew: its own ticks (a preset's file left out of the set starts unticked)
  useEffect(() => setSetOff(null), [want.set]);
  const setOffNow = setOff ?? new Set((v?.set ?? []).filter((f) => f.off).map(keyOf));
  const jobKeys = new Set((v?.jobs.files ?? []).map(keyOf));

  const picked = useMemo(() => {
    const jobs = (v?.jobs.files ?? []).filter((f) => f.via && !jobOff.has(keyOf(f)));
    const fromSet = (v?.set ?? []).filter((f) => f.via && !jobKeys.has(keyOf(f)) && !setOffNow.has(keyOf(f)));
    const all = [...jobs, ...fromSet, ...added.filter((f) => !jobKeys.has(keyOf(f)))];
    return { jobs, fromSet, all };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, jobOff, setOff, added]);
  const bytes = picked.all.reduce((n, f) => n + (f.size ?? 0), 0);
  const uploadBytes = picked.all.filter((f) => f.via === "upload").reduce((n, f) => n + (f.size ?? 0), 0);
  const unknownSizes = picked.all.filter((f) => !f.size).length;
  const licences = (v?.licences ?? []).filter((l) => picked.fromSet.some((f) => (v?.set ?? []).find((s) => keyOf(s) === keyOf(f))?.preset?.id === l.id));
  const ready = licences.every((l) => accept.has(l.id));

  useEffect(() => {
    onPicked({
      files: picked.all.map(({ file, folder, url, civitai, size: s }) => ({ file, folder, ...(url ? { url } : {}), ...(civitai ? { civitai } : {}), ...(s ? { size: s } : {}) })),
      leaveOut: (v?.jobs.files ?? []).filter((f) => jobOff.has(keyOf(f)) || !f.via).map(({ file, folder }) => ({ file, folder })),
      accept: [...accept],
      ready,
      bytes,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, accept, ready, bytes]);

  const time = v ? timeOf(picked.all, v.speeds) : null;
  const firstFiles = picked.jobs.filter((f) => f.first);
  const first = v ? timeOf(firstFiles, v.speeds) : null;
  const toggleJob = (f: DeployFile, on: boolean) => setJobOff((s) => { const n = new Set(s); if (on) n.delete(keyOf(f)); else n.add(keyOf(f)); return n; });
  const toggleSet = (f: DeployFile, on: boolean) => setSetOff(() => { const n = new Set(setOffNow); if (on) n.delete(keyOf(f)); else n.add(keyOf(f)); return n; });
  const add = (files: DeployFile[]) => setAdded((a) => [...a, ...files.filter((f) => !a.some((x) => keyOf(x) === keyOf(f)))]);

  return (
    <section className="flex flex-col gap-2">
      <span className="flex items-center gap-2 text-xs font-semibold text-ink-2">Models <Help text={WHY_MODELS} /></span>
      {view.isPending && <span className="text-xs text-ink-3">Reading your waiting jobs…</span>}
      {v && (
        <div className="flex flex-col gap-3 rounded-xl border border-line p-3">
          <div className="flex flex-col">
            <span className="flex items-center gap-2 pb-1 text-[13px] font-semibold">
              Your waiting jobs<span className="font-normal text-ink-3">{v.jobs.count ? ` · ${plural(v.jobs.count, "job")} · fetched first, in queue order` : " · none waiting"}</span>
            </span>
            {v.jobs.files.map((f) => (
              <FileRow key={keyOf(f)} f={f} on={Boolean(f.via) && !jobOff.has(keyOf(f))} disabled={!f.via} onChange={(on) => toggleJob(f, on)} note={plural(f.jobs, "job")} />
            ))}
            {v.jobs.files.some((f) => !f.via) && <span className="pt-1 text-xs text-warn-ink">A file with no source known and no copy on this PC cannot reach the pod: its jobs stay home.</span>}
            {v.jobs.files.length > 0 && <span className="pt-1 text-xs text-ink-3">Untick a file: its jobs stay home.</span>}
          </div>

          <div className="flex flex-col">
            <span className="flex items-center gap-2 pb-1 text-[13px] font-semibold">
              Model set
              <span className="w-[200px] font-normal">
                <Select size="sm" label="Model set" value={want.set || "none"} onChange={(id) => set({ set: id === "none" ? "" : id })} options={[{ value: "none", label: "None" }, ...(sets.data?.items ?? []).map((s) => ({ value: s.id, label: s.name, note: `${plural(s.count, "file")} · ${gb(s.bytes)}` }))]} />
              </span>
              <Link href="/settings/models" className="text-xs font-normal text-ink-3 underline-offset-2 hover:text-ink hover:underline">edit sets in Settings › Models</Link>
            </span>
            {(v.set ?? []).map((f) => {
              const above = jobKeys.has(keyOf(f));
              return <FileRow key={keyOf(f)} f={f} on={!above && Boolean(f.via) && !setOffNow.has(keyOf(f))} dim={above} disabled={above || !f.via} onChange={(on) => toggleSet(f, on)} note={above ? "above already" : f.preset ? `from ${f.preset.name}` : undefined} />;
            })}
            {licences.map((l) => (
              <Checkbox key={l.id} checked={accept.has(l.id)} onChange={(on) => setAccept((s) => { const n = new Set(s); if (on) n.add(l.id); else n.delete(l.id); return n; })} className="pt-1 text-xs">
                <span>I accept the {l.licence} for {l.name}'s files</span>
              </Checkbox>
            ))}
          </div>

          <div className="flex flex-col gap-1">
            {added.map((f) => (
              <div key={keyOf(f)} className="flex items-center gap-2">
                <span className="min-w-0 grow"><FileRow f={f} on /></span>
                <button type="button" aria-label={`Take ${f.file} off`} onClick={() => setAdded((a) => a.filter((x) => keyOf(x) !== keyOf(f)))} className="grid size-6 place-items-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"><X size={12} /></button>
              </div>
            ))}
            <label className={cx(fieldClass, "flex h-8 items-center gap-2 px-2.5 text-[13px]")}>
              <Search size={13} className="shrink-0 text-ink-3" />
              <input aria-label="Add a preset, a family or any file" placeholder="Add a preset, a family or any file" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-0 grow bg-transparent outline-none placeholder:text-ink-3" />
            </label>
            {found.data && searched.length > 1 && (
              <div className="flex max-h-[180px] flex-col overflow-y-auto rounded-lg border border-line text-[13px]">
                {found.data.presets.map((p) => (
                  <button key={p.id} type="button" onClick={() => { add(p.files.map((f) => ({ ...f, via: f.url ? (/huggingface|hf\.co/.test(f.url) ? "hf" : "url") : f.civitai ? "civitai" : null, size: f.size ?? null }))); setQ(""); }} className="flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-hover">
                    <span className="min-w-0 grow truncate">{p.name}<span className="text-ink-3"> · preset · {plural(p.files.length, "file")}</span></span>
                    {p.bytes > 0 && <span className="font-mono text-xs text-ink-3">{gb(p.bytes)}</span>}
                  </button>
                ))}
                {found.data.families.map((fam) => (
                  <button key={fam.id} type="button" onClick={() => { add(fam.files.map((f) => ({ ...f, via: /huggingface|hf\.co/.test(f.url) ? "hf" : "url", size: null }))); setQ(""); }} className="flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-hover">
                    <span className="min-w-0 grow truncate">{fam.name}<span className="text-ink-3"> · family · its usual files</span></span>
                  </button>
                ))}
                {found.data.files.map((f) => (
                  <button key={keyOf(f)} type="button" onClick={() => { add([{ ...f, via: "upload", size: f.size ?? null }]); setQ(""); }} className="flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-hover">
                    <span className="min-w-0 grow truncate">{f.file}<span className="text-ink-3"> · {f.folder} · on this PC</span></span>
                    {f.size && <span className="font-mono text-xs text-ink-3">{size(f.size)}</span>}
                  </button>
                ))}
                {!found.data.presets.length && !found.data.families.length && !found.data.files.length && <span className="px-2.5 py-1.5 text-ink-3">Nothing matches “{searched}”.</span>}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-0.5 border-t border-line pt-2 text-xs text-ink-2">
            <span>
              <b className="font-mono text-ink">{gb(bytes)}</b> to fetch
              {uploadBytes > 0 && ` · ${size(uploadBytes)} from this PC`}
              {unknownSizes > 0 && ` · ${plural(unknownSizes, "file")} of a size not known yet`}
              {" · "}
              {time && rate !== null
                ? <>{est(time.fast)}–{est(time.slow).replace(/^~/, "")} · <b className="text-ink">{usd((time.fast / 3_600_000) * rate, true)}–{usd((time.slow / 3_600_000) * rate, true)}</b> at {usd(rate)}/h</>
                : "time and price not known yet: measured from your first deploy"}
            </span>
            {v.boot && first && rate !== null && firstFiles.length > 0 && (
              <span>Before your first render: up in {est(v.boot.high)}, then its {gb(firstFiles.reduce((n, f) => n + (f.size ?? 0), 0))} · <b className="text-ink">{est(v.boot.high + first.slow)} · ~{usd(((v.boot.high + first.slow) / 3_600_000) * rate, true)}</b></span>
            )}
            {!ready && <span className="text-warn-ink">Accept the licence above to deploy with that set's files.</span>}
          </div>
        </div>
      )}
      {view.isError && <span className="text-xs text-warn-ink">{view.error.message}</span>}
    </section>
  );
}

/** "Save these as a set…": the files ticked, named in place. */
export function SaveAsSet({ files }: { files: PresetFile[] }) {
  const [name, setName] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  if (!files.length) return null;
  if (saved) return <span className="self-start text-xs text-good">Saved as “{saved}”</span>;
  if (name === null) return <Button size="sm" tone="quiet" onClick={() => setName("")} className="self-start">Save these as a set…</Button>;
  return (
    <form className="flex items-center gap-2 self-start" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void api.saveModelSet(null, { name: name.trim(), presets: [], files, off: [] }).then(() => setSaved(name.trim())); }}>
      <input autoFocus aria-label="The set's name" placeholder="Name of the set" value={name} onChange={(e) => setName(e.target.value)} className={cx(fieldClass, "h-7 w-40 px-2 text-xs")} />
      <Button size="sm" type="submit" disabled={!name.trim()}>Save</Button>
    </form>
  );
}
