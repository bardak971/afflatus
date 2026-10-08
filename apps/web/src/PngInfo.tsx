import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { X } from "lucide-react";
import { api, type Embedded } from "./api";
import { useRecipes } from "./data";
import { Dialog } from "./Dialog";
import { useOpenNewDraft } from "./draft";
import { fileLabel, recipeLabel } from "./format";
import { GetFile } from "./GetFile";
import { Select } from "./Select";
import { useHandover } from "./store";
import { Button, cx, ErrorNote } from "./ui";

import { workflowFile } from "./dropZones";

/**
 * What a picture says about how it was made (A1111's "PNG info"): its prompt, its checkpoint and LoRAs
 * with whether this ComfyUI has them and how to get the ones it lacks, its settings; and which form they
 * are sent to. The same for a file being dropped on the app and for a picture already in the library:
 * `read` fetches it either way, for the form asked for.
 */
export function PngInfo({ name, read, first, onClose, onSent }: {
  name: string;
  read(recipe?: string): Promise<Embedded>;
  /** What was already read, when the caller had to read it to know whether to open this. */
  first?: Embedded;
  onClose(): void;
  /** A form was filled with what was read: what this was opened over can step aside. */
  onSent?(): void;
}) {
  const [data, setData] = useState<Embedded | null>(first ?? null);
  const [failed, setFailed] = useState<string | null>(null);
  const recipes = useRecipes();
  const [, go] = useLocation();
  const hand = useHandover((h) => h.set);
  const openNew = useOpenNewDraft();
  const load = (recipe?: string) => read(recipe).then(setData, (err: Error) => setFailed(err.message));
  useEffect(() => {
    if (!first) void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const nameOf = (id: string) => {
    const r = recipes.data?.recipes.find((x) => x.id === id);
    return r ? recipeLabel(recipes.data?.families.find((f) => f.id === r.family)?.name, r.title) : id;
  };
  /** Fill a new form with what was read. It is read again, so that a model fetched in the meantime is used. */
  const send = async () => {
    try {
      const fresh = (await read(data?.settings?.recipe)).settings ?? data?.settings;
      if (!fresh) return;
      const d = await api.createDraft({ recipe: fresh.recipe, forms: { [fresh.recipe]: fresh.input } });
      onClose();
      onSent?.();
      openNew(d);
    } catch (err) {
      setFailed((err as Error).message);
    }
  };

  const s = data?.settings;
  return (
    <Dialog label="PNG info" onClose={onClose} z="z-[80]" className="flex max-h-full w-full max-w-2xl flex-col rounded-2xl border border-line-strong bg-panel">
        <header className="flex shrink-0 items-center gap-3 border-b border-line py-3 pr-3 pl-5">
          <div className="flex min-w-0 grow flex-col">
            <h2 className="text-base font-semibold">PNG info</h2>
            <span className="truncate text-xs text-ink-2" data-tip={name}>{name}</span>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 hover:bg-hover"><X size={16} /></button>
        </header>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-5">
          {failed && <ErrorNote>{failed}</ErrorNote>}
          {!data && !failed && <div className="text-ink-2">Reading metadata…</div>}
          {data && !s && <div className="text-ink-2">{data.why}</div>}
          {s && (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-ink-2">Prompt</span>
                <div className="max-h-40 overflow-y-auto rounded-lg bg-raised px-3 py-2 whitespace-pre-wrap">{String(s.input.prompt ?? "") || "(none found)"}</div>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-ink-2">Checkpoint</span>
                {s.model
                  ? <Line found={s.model.found} name={s.model.name} missing={s.missing.find((m) => m.folder === "checkpoints")} instead="The checkpoint selected in the form is used instead." />
                  : <span className="text-ink-2">Not in the metadata.</span>}
              </div>
              {s.loras.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold text-ink-2">LoRAs</span>
                  {s.loras.map((l) => (
                    <Line key={l.name} found={l.found} name={`${l.name} · ${l.weight}`} missing={s.missing.find((m) => m.folder === "loras" && fileLabel(m.file) === l.name)} instead="It is skipped." />
                  ))}
                </div>
              )}
              {s.notes.map((n) => <div key={n} className="text-ink-2">{n}</div>)}
              <div className="flex flex-col gap-1.5 border-t border-line pt-3">
                <span className="text-xs font-semibold text-ink-2">Send to</span>
                <Select
                  label="Target form"
                  value={s.recipe}
                  onChange={(id) => void load(id)}
                  options={s.targets.map((t) => ({ value: t.id, label: nameOf(t.id), note: t.why }))}
                />
                <span className="text-xs text-ink-3">
                  {s.targets[0]?.why && s.targets[0].id === s.recipe ? `Picked because ${s.targets[0].why}.` : "Parameters only mean the same thing with the model they were made for."}
                  {" "}Parameters sent: {[
                    s.input.size ? `${(s.input.size as { width: number }).width} × ${(s.input.size as { height: number }).height}` : "",
                    ...Object.entries(s.input).filter(([k, v]) => typeof v === "number" && k !== "seed").map(([k, v]) => `${k.replace(/^ctl_[0-9_]+?_(?=[a-z])/, "")} ${v}`),
                    s.input.seed !== undefined ? `seed ${s.input.seed}` : "",
                  ].filter(Boolean).join(" · ") || "the prompt"}.
                </span>
              </div>
            </>
          )}
        </div>
        <footer className="flex shrink-0 items-center gap-2 border-t border-line px-5 py-3">
          {data?.workflow ? (
            <Button onClick={() => { hand({ workflow: workflowFile(name, data.workflow) }); onClose(); go("/workflows"); }}>Import embedded workflow</Button>
          ) : null}
          <span className="grow" />
          <Button onClick={onClose}>Close</Button>
          {s && <Button tone="primary" onClick={() => void send()}>Send to form</Button>}
        </footer>
    </Dialog>
  );
}

/** One thing the picture was made with: there on this ComfyUI, or not, with how to get it. */
function Line({ found, name, missing, instead }: { found: boolean; name: string; missing?: { file: string; folder: string; civitai?: number }; instead: string }) {
  return (
    <div className={cx("flex flex-col rounded-lg border px-3 py-2", found ? "border-line" : "border-warn/50 bg-warn-wash text-warn-ink")}>
      <span><span className="font-semibold break-all">{name}</span> {found ? <span className="text-good">· installed</span> : <>· not installed on your ComfyUI. {instead}</>}</span>
      {!found && missing && <GetFile file={missing.file} folder={missing.folder} civitai={missing.civitai} />}
    </div>
  );
}
