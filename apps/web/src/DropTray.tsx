import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Film, FileDown, ImagePlus, Music, Workflow } from "lucide-react";
import { api, type Asset, type Embedded } from "./api";
import { fileKind, kindOfType, workflowFile, zonesFor, type Kind, type Zone } from "./dropZones";
import { openFolderId, useHandover } from "./store";
import { projectForNew } from "./project";
import { cx } from "./ui";

// PNG info opens the first time a file is dropped on it
const PngInfo = lazy(() => import("./PngInfo").then((m) => ({ default: m.PngInfo })));

/** What is being dragged over the window, told from the first file's type (its name cannot be read until it is dropped). */
const kindOf = (e: DragEvent): Kind | null =>
  kindOfType([...(e.dataTransfer?.items ?? [])].find((i) => i.kind === "file")?.type, Boolean(e.dataTransfer?.types.includes("Files")));
const ICONS: Record<Zone, ReactNode> = { library: <ImagePlus size={22} />, timeline: <Film size={22} />, settings: <FileDown size={22} />, workflow: <Workflow size={22} /> };

/**
 * A file dragged in from the computer, anywhere in the app: a tray comes up with what can be done with
 * it, and it is dropped on one of them. The tray sits at the bottom so that the page's own places to drop
 * (a picture slot in a form, the timeline) stay in reach.
 */
export function DropTray() {
  const [kind, setKind] = useState<Kind | null>(null);
  const [over, setOver] = useState<Zone | null>(null);
  // `busy`: work under way, it stays up until it is done
  const [said, setSaid] = useState<{ text: string; bad?: boolean; busy?: boolean } | null>(null);
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
    if (!said || said.busy) return;
    const t = setTimeout(() => setSaid(null), said.bad ? 9000 : 4000);
    return () => clearTimeout(t);
  }, [said]);

  const fail = (err: unknown) => setSaid({ text: (err as Error).message, bad: true });
  const media = (files: File[]) => files.filter((f) => ["image", "video", "audio"].includes(fileKind(f)));
  /** Each file in turn, one that fails does not stop the others; `verb` says the progress ("Importing 3 of 10…"). */
  const bringIn = async (files: File[], verb: string) => {
    const added: Asset[] = [];
    const failed: string[] = [];
    // into the folder that is open in the library, else the current project's root folder
    // the server says each with a "library" event: the lists follow by themselves
    for (const [i, f] of files.entries()) {
      if (files.length > 1) setSaid({ text: `${verb} ${i + 1} of ${files.length}…`, busy: true });
      try {
        added.push(await api.upload(f, { folder: openFolderId() ?? undefined, project: projectForNew() }));
      } catch (err) {
        failed.push(`${f.name}: ${(err as Error).message}`);
      }
    }
    return { added, failed };
  };
  /** "8 of 10 imported, 2 failed" and the first failure (one file: its failure alone), else `done`. */
  const outcome = (n: number, ok: number, failed: string[], verb: string, done: string) => {
    if (!failed.length) return setSaid({ text: done });
    const more = failed.length > 1 ? ` (and ${failed.length - 1} more)` : "";
    setSaid({ text: n > 1 ? `${ok} of ${n} ${verb}, ${failed.length} failed · ${failed[0]}${more}` : failed[0]!, bad: true });
  };

  const act = async (zone: Zone, files: File[]) => {
    const first = files[0];
    if (!first) return;
    try {
      if (zone === "library") {
        const good = media(files);
        if (!good.length) return setSaid({ text: "The library takes images, videos and audio files.", bad: true });
        setSaid({ text: "Importing…", busy: true });
        const { added, failed } = await bringIn(good, "Importing");
        // one file: shown large right away, with everything that can be done with it
        if (added.length === 1) hand({ show: added[0]!.id });
        if (added.length) go("/");
        outcome(good.length, added.length, failed, "imported", added.length > 1 ? `${added.length} files imported into your library.` : "Imported into your library.");
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
        setSaid({ text: "Adding…", busy: true });
        const { added, failed } = await bringIn(good, "Adding");
        let ok = 0;
        for (const a of added) {
          try {
            if (a.kind === "audio") await api.editTimeline(timeline, { music: { asset: a.id } });
            else await api.addClip(timeline, { asset: a.id, ...(a.kind === "image" ? { as: "still" as const } : {}) });
            ok++;
          } catch (err) {
            failed.push(`${a.name || a.id}: ${(err as Error).message}`);
          }
        }
        await client.invalidateQueries({ queryKey: ["timelines"] });
        outcome(good.length, ok, failed, "added", "Added to the timeline.");
      }
    } catch (err) {
      fail(err);
    }
  };

  const zones = zonesFor(kind, Boolean(timeline)).map((z) => ({ ...z, icon: z.id === "timeline" && kind === "audio" ? <Music size={22} /> : ICONS[z.id] }));

  return (
    <>
      {kind && zones.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-14 z-[70] flex flex-col items-center gap-2">
          <span className="rounded-full bg-ground/90 px-3 py-1 text-xs text-ink-2">Drop on an action</span>
          <div className="pointer-events-auto flex gap-3 rounded-2xl border border-line-strong bg-panel/95 p-3 shadow-2xl">
            {zones.map((z) => (
              <div
                key={z.id}
                // the rest of what it does, for screen readers: the tray only shows mid-drag, when no tip can come up
                aria-description={z.detail}
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
                className={cx("flex h-[112px] w-48 flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-3 text-center", over === z.id ? "border-accent bg-accent-wash" : "border-line-strong")}
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
      {found && <Suspense fallback={null}><PngInfo name={found.file.name} first={found.data} read={(recipe) => api.embedded(found.file, recipe)} onClose={() => setFound(null)} /></Suspense>}
    </>
  );
}
