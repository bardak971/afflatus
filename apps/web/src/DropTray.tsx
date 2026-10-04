import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Film, FileDown, ImagePlus, Music, Workflow } from "lucide-react";
import { api, type Asset, type Embedded } from "./api";
import { PngInfo, workflowFile } from "./PngInfo";
import { useHandover } from "./store";
import { projectForNew } from "./project";
import { openFolderId } from "./screens/Studio";
import { cx } from "./ui";

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
    // into the folder that is open in the library, else the current project's root folder
    for (const f of files) added.push(await api.upload(f, { folder: openFolderId() ?? undefined, project: projectForNew() }));
    await client.invalidateQueries({ queryKey: ["assets"] });
    return added;
  };

  const act = async (zone: Zone, files: File[]) => {
    const first = files[0];
    if (!first) return;
    try {
      if (zone === "library") {
        const good = media(files);
        if (!good.length) return setSaid({ text: "The library takes images, videos and audio files.", bad: true });
        setSaid({ text: good.length > 1 ? `Importing ${good.length} files…` : "Importing…" });
        const added = await bringIn(good);
        // one file: shown large right away, with everything that can be done with it
        if (added.length === 1) hand({ show: added[0]!.id });
        go("/");
        setSaid({ text: added.length > 1 ? `${added.length} files imported into your library.` : "Imported into your library." });
      } else if (zone === "settings") {
        setSaid({ text: "Reading generation parameters…" });
        const data = await api.embedded(first);
        setSaid(null);
        setFound({ file: first, data });
      } else if (zone === "workflow") {
        if (fileKind(first) === "json") hand({ workflow: first });
        else {
          setSaid({ text: "Looking for an embedded workflow…" });
          const data = await api.embedded(first);
          if (!data.workflow) return setSaid({ text: "This file carries no ComfyUI workflow. Images and videos saved by ComfyUI do; most sites strip it.", bad: true });
          hand({ workflow: workflowFile(first.name, data.workflow) });
          setSaid(null);
        }
        go("/workflows");
      } else if (zone === "timeline" && timeline) {
        const good = media(files);
        if (!good.length) return setSaid({ text: "A timeline takes images, videos and audio files.", bad: true });
        setSaid({ text: "Adding…" });
        for (const a of await bringIn(good)) {
          if (a.kind === "audio") await api.editTimeline(timeline, { music: { asset: a.id } });
          else await api.addClip(timeline, { asset: a.id, ...(a.kind === "image" ? { as: "still" as const } : {}) });
        }
        await client.invalidateQueries({ queryKey: ["timelines"] });
        setSaid({ text: "Added to the timeline." });
      }
    } catch (err) {
      fail(err);
    }
  };

  const zones: Array<{ id: Zone; icon: ReactNode; label: string; hint: string }> = [];
  if (kind && kind !== "json") {
    zones.push({
      id: "library", icon: <ImagePlus size={22} />, label: "Import to library",
      hint: kind === "audio" ? "to use as a voice sample, a clip's audio or music" : kind === "video" ? "it opens in the viewer: extend it, extract its audio, add it to a timeline" : "it opens in the viewer: img2img, inpaint, i2v, use as a reference image",
    });
  }
  if (timeline && kind && kind !== "json") {
    zones.push({
      id: "timeline", icon: kind === "audio" ? <Music size={22} /> : <Film size={22} />, label: kind === "audio" ? "Music track of this timeline" : "Add to this timeline",
      hint: kind === "audio" ? "it plays under every clip" : kind === "video" ? "at the end, as it is" : "at the end, as a still. Drop it on a clip instead to make it the clip's first or last frame",
    });
  }
  if (kind === "image" || kind === "other") zones.push({ id: "settings", icon: <FileDown size={22} />, label: "PNG info", hint: "its generation parameters (prompt, checkpoint, LoRAs, sampling settings) fill a new form" });
  if (kind && kind !== "audio") {
    zones.push({
      id: "workflow", icon: <Workflow size={22} />, label: kind === "json" ? "Import this workflow" : "Import embedded workflow",
      hint: kind === "json" ? "it is added to your workflows, to generate with" : "files saved by ComfyUI carry their workflow: it is added to your workflows, to generate with",
    });
  }

  return (
    <>
      {kind && zones.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-14 z-[70] flex flex-col items-center gap-2">
          <span className="rounded-full bg-ground/90 px-3 py-1 text-xs text-ink-2">Drop on an action</span>
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
      {found && <PngInfo name={found.file.name} first={found.data} read={(recipe) => api.embedded(found.file, recipe)} onClose={() => setFound(null)} />}
    </>
  );
}
