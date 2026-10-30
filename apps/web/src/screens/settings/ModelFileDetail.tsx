import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, thumbUrl, type ModelFile, type ModelLibrary } from "../../api";
import { dayOf, plural, size, when } from "../../format";
import { useCopied } from "../../hooks";
import { queryKeys } from "../../queryKeys";
import { Thumb } from "../../Thumb";
import { Button, Chip, cx, Help } from "../../ui";
import { ALSO_HELP, lastSaid, nameOf, placeOfId } from "./modelFilesView";

/**
 * A model file's picture: its Civitai cover when it has one, "HF" for a Hugging Face file (the site has no pictures for its
 * files), else its first letter. `small`: the table's.
 */
export function Picture({ f, small }: { f: ModelFile; small?: boolean }) {
  const [broken, setBroken] = useState(false);
  const box = small ? "size-9 rounded-lg" : "aspect-[4/5] w-full rounded-card";
  if (f.picture && !broken) return <img src={f.picture} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} className={cx(box, "bg-raised object-cover")} />;
  const tip = f.match === "pending" ? "Not hashed yet: its Civitai or Hugging Face match comes once it is" : f.match === "hf" ? "Hugging Face has no picture for its files" : f.match === "none" ? "No match on Civitai or Hugging Face: trained or merged here, or renamed and re-saved" : undefined;
  return (
    <span data-tip={tip} className={cx(box, "grid place-items-center bg-raised font-mono text-ink-3", small ? "text-sm" : "text-5xl", f.match === "pending" && "m-skeleton")}>
      {f.match === "hf" ? "HF" : (f.file.split("/").pop() ?? "?").slice(0, 1).toUpperCase()}
    </span>
  );
}

/** The last six months of a file's uses, as small bars. */
function Spark({ months }: { months: Record<string, number> }) {
  const now = new Date();
  const keys = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
    return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: d.toLocaleDateString("en-GB", { month: "short" }) };
  });
  const most = Math.max(1, ...keys.map((k) => months[k.key] ?? 0));
  return (
    <span className="ml-3 inline-flex h-[22px] items-end gap-[3px]" data-tip={keys.map((k) => `${k.label}: ${months[k.key] ?? 0}`).join(" · ")}>
      {keys.map((k) => <i key={k.key} className={cx("w-2 rounded-sm", months[k.key] ? "bg-accent" : "bg-line")} style={{ height: `${Math.max(2, ((months[k.key] ?? 0) / most) * 22)}px` }} />)}
    </span>
  );
}

/** A file's detail, open under its row: what it is, where, its use by Afflatus, what was made with it, what needs it. */
export function ModelFileDetail({ f, lib, onDelete, onPutBack }: { f: ModelFile; lib: ModelLibrary; onDelete(): void; onPutBack(): void }) {
  const now = Date.now();
  const day = (iso: string) => dayOf(iso, now);
  const ls = lastSaid(f, lib.since, day, (iso) => when(iso, now));
  const takes = useQuery({ queryKey: queryKeys.modelInfo.takes(f.id), queryFn: ({ signal }) => api.modelFileTakes(f, lib.readOnly ? lib.machine : undefined, { signal }), enabled: f.takes > 0 && !f.removed });
  const { copied, copy } = useCopied();
  const copies = f.copies.map(placeOfId);
  return (
    <div className="grid grid-cols-[180px_minmax(0,1.1fr)_minmax(0,1fr)] gap-6 border-t border-line bg-raised/50 px-[18px] py-4 @max-[1000px]:grid-cols-[120px_minmax(0,1fr)]">
      <div className="flex flex-col gap-1.5">
        <Picture f={f} />
        {f.picture && <span className="text-xs text-ink-3">Civitai's cover picture</span>}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] content-start gap-x-4 gap-y-2 text-body">
        <div className="col-span-2 text-title font-bold">{nameOf(f)}{f.version && f.name && <small className="ml-2 font-normal text-ink-3">{f.version}</small>}</div>
        <dt className="text-ink-3">Kind · base</dt><dd>{f.kind} · {f.base ?? "unknown"}</dd>
        <dt className="text-ink-3">Online</dt>
        <dd>{f.link ? <a className="text-accent hover:underline" href={f.link.url} target="_blank" rel="noreferrer">{f.link.site} · {f.name ?? nameOf(f)} ↗</a> : <span className="text-ink-3">{f.match === "pending" ? "known once hashed" : "no match on Civitai or Hugging Face"}</span>}</dd>
        <dt className="text-ink-3">File</dt>
        <dd className="flex min-w-0 items-center gap-2"><span className="truncate font-mono text-xs">{f.folder}/{f.file}</span>{f.path && <><Help title="Full path" text={f.path} /><button type="button" className="text-xs text-accent hover:underline" onClick={() => copy(f.path!)}>{copied ? "Copied" : "Copy path"}</button></>}</dd>
        <dt className="text-ink-3">Size</dt><dd className="font-mono text-xs">{f.size === null ? "—" : size(f.size)}</dd>
        <dt className="text-ink-3">Here since</dt><dd>{f.mtime ? <>{day(new Date(f.mtime).toISOString())} <span className="text-ink-3">(file date)</span></> : "—"}</dd>
        <dt className="text-ink-3">Uses by Afflatus</dt>
        <dd className="flex items-center">{f.uses ? `${f.approx ? "≈" : ""}${plural(f.uses, "job")} · last ${ls.text}` : <span className="text-attention-ink" data-tip={ls.tip}>{ls.text}</span>}<Spark months={f.months} /></dd>
        {f.sha256 && <><dt className="text-ink-3">sha256</dt><dd className="truncate font-mono text-xs text-ink-3" data-tip={f.sha256}>{f.sha256.slice(0, 16)}…</dd></>}
        {f.also.length > 0 && <><dt className="text-ink-3">Also seen as</dt><dd className="flex flex-col gap-0.5">{f.also.map((a) => <span key={`${a.folder}/${a.file}`} className="truncate font-mono text-xs">{a.folder}/{a.file}</span>)}<span className="flex items-center text-xs text-ink-3">the same file on disk, not a copy<Help text={ALSO_HELP} /></span></dd></>}
        {copies.length > 0 && <><dt className="text-ink-3">{f.removed ? "Copies still here" : "Copies"}</dt><dd className="flex flex-col gap-0.5">{copies.map((c) => <span key={c} className="truncate font-mono text-xs">{c}</span>)}</dd></>}
      </dl>
      <div className="flex flex-col gap-4 @max-[1000px]:col-span-2">
        <section className="flex flex-col gap-2">
          <h5 className="flex items-center gap-2"><span className="text-meta font-bold tracking-label text-ink-3 uppercase">Made with it</span>{f.takes > 0 && <span className="text-xs text-ink-3">{plural(f.takes, "take")}</span>}</h5>
          {takes.data?.items.length
            ? <div className="grid grid-cols-4 gap-1.5">{takes.data.items.map((a) => <Thumb key={a.id} src={thumbUrl(a.id)} alt="" className="aspect-square w-full rounded-lg bg-raised object-cover" />)}</div>
            : <span className="text-body text-ink-3">{f.takes ? "…" : `Nothing in the library was made with it${f.last ? "" : lib.since ? ` since ${day(lib.since)}` : ""}.`}</span>}
        </section>
        <section className="flex flex-col gap-1.5">
          <h5 className="text-meta font-bold tracking-label text-ink-3 uppercase">Needed by</h5>
          {f.needs.length
            ? f.needs.map((n) => (
              <span key={`${n.kind}:${n.id}`} className="flex items-center gap-2 text-body">
                <Chip size="xs" tone={n.kind === "family" ? "neutral" : "accent"}>{n.kind === "preset" ? "preset" : n.kind === "set" ? "model set" : "family"}</Chip>
                <span>{n.name}</span>
                {n.kind === "family" && <span className="text-xs text-ink-3">its file here</span>}
              </span>
            ))
            : <span className="text-body text-ink-3">No preset, model set or family uses it.</span>}
        </section>
      </div>
      {!lib.readOnly && (
        <div className="col-span-3 flex justify-end gap-2 @max-[1000px]:col-span-2">
          {f.removed ? <Button size="sm" onClick={onPutBack}>Put back</Button> : <Button size="sm" tone="danger" onClick={onDelete}>Delete…</Button>}
        </div>
      )}
    </div>
  );
}
