import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Film, FileDown, ImagePlus, Music, Workflow, X } from "lucide-react";
import { api, type Asset, type Embedded } from "./api";
import { fileLabel } from "./format";
import { GetFile } from "./GetFile";
import { useHandover, useOpenDraft } from "./store";
import { Button, cx } from "./ui";

type Kind = "image" | "video" | "audio" | "json" | "other";
type Zone = "library" | "settings" | "workflow" | "timeline";

/** What is being dragged over the window, told from the first file's type (its name cannot be read until it is dropped). */
function kindOf(e: DragEvent): Kind | null {
  const items = [...(e.dataTransfer?.items ?? [])].filter((i) => i.kind === "file");
  if (!items.length) return e.dataTransfer?.types.includes("Files") ? "other" : null;
  const type = items[0]!.type;
  return type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : type.startsWith("audio/") ? "audio" : /json/.test(type) ? "json" : "other";
}
const fileKind = (f: File): Kind =>
  f.type.startsWith("image/") ? "image" : f.type.startsWith("video/") || /\.(mp4|webm|mov|mkv)$/i.test(f.name) ? "video" : f.type.startsWith("audio/") || /\.(wav|mp3|flac|ogg|m4a)$/i.test(f.name) ? "audio" : /\.json$/i.test(f.name) || /json/.test(f.type) ? "json" : "other";

/**
 * A file dragged in from the computer, anywhere in the app: a tray comes up with what can be done with
 * it, and it is dropped on one of them. The tray sits at the bottom so that the page's own places to drop
 * (a picture slot in a form, the timeline) stay in reach.
 */
export function DropTray() {
  const [kind, setKind] = useState<Kind | null>(null);
  const [over, setOver] = useState<Zone | null>(null);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const [found, setFound] = useState<{ file: File; data: Embedded } | null>(null);
  const depth = useRef(0);
  const [path, go] = useLocation();
  const client = useQueryClient();
  const hand = useHandover((h) => h.set);
  const openDraft = useOpenDraft((s) => s.open);
  const timeline = /^\/timelines\/([^/]+)/.exec(path)?.[1] ?? null;

  useEffect(() => {
    const files = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes("Files"));
    const enter = (e: DragEvent) => {
      if (!files(e)) return;
      depth.current++;
      setKind(kindOf(e));
    };
    const leave = (e: DragEvent) => {
      if (!files(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setKind(null);
    };
    // a file let go of outside every place to drop must not make the browser open it
    const hold = (e: DragEvent) => files(e) && e.preventDefault();
    const end = (e: DragEvent) => {
      if (files(e)) e.preventDefault();
      depth.current = 0;
      setKind(null);
      setOver(null);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", hold);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", hold);
      window.removeEventListener("drop", end);
    };
  }, []);
  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(null), said.bad ? 9000 : 4000);
    return () => clearTimeout(t);
  }, [said]);

  const fail = (err: unknown) => setSaid({ text: (err as Error).message, bad: true });
  const media = (files: File[]) => files.filter((f) => ["image", "video", "audio"].includes(fileKind(f)));
  const bringIn = async (files: File[]) => {
    const added: Asset[] = [];
    for (const f of files) added.push(await api.upload(f));
    await client.invalidateQueries({ queryKey: ["assets"] });
    return added;
  };
  /** The workflow a file carries, as a file the import screen can read. */
  const workflowFile = (name: string, workflow: unknown) => new File([JSON.stringify(workflow)], `${name.replace(/\.[^.]+$/, "")}.json`, { type: "application/json" });

  const act = async (zone: Zone, files: File[]) => {
    const first = files[0];
    if (!first) return;
    try {
      if (zone === "library") {
        const good = media(files);
        if (!good.length) return setSaid({ text: "The library takes pictures, videos and sounds.", bad: true });
        setSaid({ text: good.length > 1 ? `Adding ${good.length} files…` : "Adding it…" });
        const added = await bringIn(good);
        // one file: shown large right away, with everything that can be done with it
        if (added.length === 1) hand({ show: added[0]!.id });
        go("/");
        setSaid({ text: added.length > 1 ? `${added.length} files are in your library.` : "It is in your library." });
      } else if (zone === "settings") {
        setSaid({ text: "Reading what it was made with…" });
        const data = await api.embedded(first);
        setSaid(null);
        setFound({ file: first, data });
      } else if (zone === "workflow") {
        if (fileKind(first) === "json") hand({ workflow: first });
        else {
          setSaid({ text: "Looking for a workflow in it…" });
          const data = await api.embedded(first);
          if (!data.workflow) return setSaid({ text: "This file carries no ComfyUI workflow. Pictures and videos saved by ComfyUI do; most sites remove it.", bad: true });
          hand({ workflow: workflowFile(first.name, data.workflow) });
          setSaid(null);
        }
        go("/workflows");
      } else if (zone === "timeline" && timeline) {
        const good = media(files);
        if (!good.length) return setSaid({ text: "A timeline takes pictures, videos and sounds.", bad: true });
        setSaid({ text: "Adding…" });
        for (const a of await bringIn(good)) {
          if (a.kind === "audio") await api.editTimeline(timeline, { music: { asset: a.id } });
          else await api.addClip(timeline, { asset: a.id, ...(a.kind === "image" ? { as: "still" as const } : {}) });
        }
        await client.invalidateQueries({ queryKey: ["timelines"] });
        setSaid({ text: "It is on the timeline." });
      }
    } catch (err) {
      fail(err);
    }
  };

  /** Fill a new form with what was read. The file is read again, so that a model fetched in the meantime is used. */
  const fillForm = async () => {
    if (!found) return;
    try {
      const fresh = (await api.embedded(found.file)).settings ?? found.data.settings;
      if (!fresh) return;
      const d = await api.createDraft({ recipe: fresh.recipe, forms: { [fresh.recipe]: fresh.input } });
      client.setQueryData(["drafts", d.id], d);
      void client.invalidateQueries({ queryKey: ["drafts"], exact: true });
      openDraft(d.id);
      setFound(null);
      go("/create");
    } catch (err) {
      fail(err);
    }
  };

  const zones: Array<{ id: Zone; icon: ReactNode; label: string; hint: string }> = [];
  if (kind && kind !== "json") {
    zones.push({
      id: "library", icon: <ImagePlus size={22} />, label: "Add to my library",
      hint: kind === "audio" ? "to use as a voice, a clip's sound or music" : kind === "video" ? "it opens with what can be done: continue it, take its sound, put it on a timeline" : "it opens with what can be done: change it, make a video from it, use it as a reference",
    });
  }
  if (timeline && kind && kind !== "json") {
    zones.push({
      id: "timeline", icon: kind === "audio" ? <Music size={22} /> : <Film size={22} />, label: kind === "audio" ? "Music of this timeline" : "Put it on this timeline",
      hint: kind === "audio" ? "it plays under every clip" : kind === "video" ? "at the end, as it is" : "at the end, held on screen. Drop it on a clip instead to make the clip open or end on it",
    });
  }
  if (kind === "image" || kind === "other") zones.push({ id: "settings", icon: <FileDown size={22} />, label: "Use its settings", hint: "the words, the model and the LoRAs it was made with fill a new form" });
  if (kind && kind !== "audio") {
    zones.push({
      id: "workflow", icon: <Workflow size={22} />, label: kind === "json" ? "Import this workflow" : "Import its workflow",
      hint: kind === "json" ? "it becomes something to create with" : "what ComfyUI saves carries its workflow: it becomes something to create with",
    });
  }

  const s = found?.data.settings;
  return (
    <>
      {kind && zones.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-14 z-[70] flex flex-col items-center gap-2">
          <span className="rounded-full bg-ground/90 px-3 py-1 text-xs text-ink-2">Drop it on what to do with it</span>
          <div className="pointer-events-auto flex gap-3 rounded-2xl border border-line-strong bg-panel/95 p-3 shadow-2xl">
            {zones.map((z) => (
              <div
                key={z.id}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                  setOver(z.id);
                }}
                onDragLeave={() => setOver((o) => (o === z.id ? null : o))}
                onDrop={(e) => {
                  e.preventDefault();
                  void act(z.id, [...e.dataTransfer.files]);
                }}
                className={cx("flex h-[132px] w-52 flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-3 text-center", over === z.id ? "border-accent bg-accent-wash" : "border-line-strong")}
              >
                <span className={over === z.id ? "text-accent" : "text-ink-2"}>{z.icon}</span>
                <span className="font-semibold">{z.label}</span>
                <span className="text-xs text-ink-2">{z.hint}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {said && !kind && (
        <div role="status" className={cx("fixed bottom-14 left-1/2 z-[70] max-w-xl -translate-x-1/2 rounded-xl border px-4 py-2.5 shadow-2xl", said.bad ? "border-warn bg-warn-wash text-warn-ink" : "border-line-strong bg-panel")}>{said.text}</div>
      )}
      {found && (
        <div role="dialog" aria-modal="true" aria-label="What it was made with" className="fixed inset-0 z-[60] flex items-center justify-center bg-ground/85 p-8" onClick={() => setFound(null)}>
          <div className="flex max-h-full w-full max-w-2xl flex-col rounded-2xl border border-line-strong bg-panel" onClick={(e) => e.stopPropagation()}>
            <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line pr-3 pl-5">
              <h2 className="text-base font-semibold">What {found.file.name} was made with</h2>
              <span className="grow" />
              <button type="button" aria-label="Close" onClick={() => setFound(null)} className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 hover:bg-hover"><X size={16} /></button>
            </header>
            <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-5">
              {!s && <div className="text-ink-2">{found.data.why}</div>}
              {s && (
                <>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-semibold text-ink-2">The words</span>
                    <div className="max-h-40 overflow-y-auto rounded-lg bg-raised px-3 py-2 whitespace-pre-wrap">{String(s.input.prompt ?? "") || "(none found)"}</div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-semibold text-ink-2">The model</span>
                    {s.model
                      ? <Line found={s.model.found} name={s.model.name} missing={s.missing.find((m) => m.folder === "checkpoints")} instead="The model picked in the form is used instead." />
                      : <span className="text-ink-2">It does not say which.</span>}
                  </div>
                  {s.loras.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs font-semibold text-ink-2">LoRAs</span>
                      {s.loras.map((l) => (
                        <Line key={l.name} found={l.found} name={`${l.name} · ${l.weight}`} missing={s.missing.find((m) => m.folder === "loras" && fileLabel(m.file) === l.name)} instead="It is left out." />
                      ))}
                    </div>
                  )}
                  <div className="text-xs text-ink-2">
                    {[
                      s.input.size ? `${(s.input.size as { width: number }).width} × ${(s.input.size as { height: number }).height}` : "",
                      s.input.steps ? `${s.input.steps} steps` : "", s.input.cfg ? `CFG ${s.input.cfg}` : "", s.input.sampler ? String(s.input.sampler) : "",
                      s.input.seed !== undefined ? `seed ${s.input.seed}` : "", s.input.hires ? "with a hi-res pass" : "",
                    ].filter(Boolean).join(" · ")}
                  </div>
                  {s.notes.map((n) => <div key={n} className="text-ink-2">{n}</div>)}
                  <div className="text-xs text-ink-3">This fills the SDXL form. If the picture was made with another kind of model, the result will differ.</div>
                </>
              )}
            </div>
            <footer className="flex shrink-0 items-center gap-2 border-t border-line px-5 py-3">
              {found.data.workflow ? (
                <Button onClick={() => { hand({ workflow: workflowFile(found.file.name, found.data.workflow) }); setFound(null); go("/workflows"); }}>Import its workflow instead</Button>
              ) : null}
              <span className="grow" />
              <Button onClick={() => setFound(null)}>Close</Button>
              {s && <Button tone="primary" onClick={() => void fillForm()}>Open it in Create</Button>}
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

/** One thing the picture was made with: there on this ComfyUI, or not, with how to get it. */
function Line({ found, name, missing, instead }: { found: boolean; name: string; missing?: { file: string; folder: string; civitai?: number }; instead: string }) {
  return (
    <div className={cx("flex flex-col rounded-lg border px-3 py-2", found ? "border-line" : "border-warn/50 bg-warn-wash text-warn-ink")}>
      <span><span className="font-semibold break-all">{name}</span> {found ? <span className="text-good">· on your ComfyUI</span> : <>· not on your ComfyUI. {instead}</>}</span>
      {!found && missing && <GetFile file={missing.file} folder={missing.folder} civitai={missing.civitai} />}
    </div>
  );
}
