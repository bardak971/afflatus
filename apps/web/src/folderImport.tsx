import type { QueryClient } from "@tanstack/react-query";
import { FolderUp, X } from "lucide-react";
import { create } from "zustand";
import { api, type Folder } from "./api";
import { Bar } from "./ui";

/**
 * Bringing a whole folder in from the computer: every picture, video and sound in it is uploaded, and
 * its sub-folders are made again in the library. It is a copy: what changes in the folder on the
 * computer afterwards does not follow. It goes on while other screens are open; a line at the bottom
 * says how far it is.
 */

interface Run {
  name: string;
  done: number;
  total: number;
  failed: number;
  /** Files that are no picture, video or sound: left where they are. */
  skipped: number;
  over: boolean;
}

export const useFolderImport = create<{ run: Run | null; start(files: File[], into: string | null, client: QueryClient): Promise<void>; dismiss(): void }>((set, get) => ({
  run: null,
  dismiss: () => set({ run: null }),
  async start(files, into, client) {
    if (get().run && !get().run!.over) return;
    const media = files.filter((f) => /^(image|video|audio)\//.test(f.type));
    const pathOf = (f: File) => (f.webkitRelativePath || f.name).split("/").slice(0, -1);
    const name = pathOf(files[0] ?? new File([], ""))[0] ?? "a folder";
    set({ run: { name, done: 0, total: media.length, failed: 0, skipped: files.length - media.length, over: media.length === 0 } });
    if (!media.length) return;

    // the folders it needs, made once each: one that is there already under the same parent is used again
    const known: Folder[] = (await api.folders()).items;
    const made = new Map<string, Promise<string>>();
    const folderFor = (parts: string[]): Promise<string | null> => {
      if (!parts.length) return Promise.resolve(into);
      const key = parts.join("/");
      if (!made.has(key)) {
        made.set(key, (async () => {
          const parent = await folderFor(parts.slice(0, -1));
          const leaf = parts.at(-1)!.slice(0, 120);
          const there = known.find((f) => f.parentId === parent && f.name === leaf);
          return there ? there.id : (await api.createFolder(leaf, parent)).id;
        })());
      }
      return made.get(key)!;
    };

    const left = [...media];
    const step = (patch: Partial<Run>) => set((s) => (s.run ? { run: { ...s.run, ...patch } } : s));
    // a few at a time: the server reads each file to make its small picture
    await Promise.all(Array.from({ length: 3 }, async () => {
      for (let file = left.shift(); file; file = left.shift()) {
        try {
          const folder = await folderFor(pathOf(file));
          await api.upload(file, { folder: folder ?? undefined });
          step({ done: get().run!.done + 1 });
        } catch {
          step({ done: get().run!.done + 1, failed: get().run!.failed + 1 });
        }
        if (get().run!.done % 8 === 0) void client.invalidateQueries({ queryKey: ["assets"] });
      }
    }));
    step({ over: true });
    void client.invalidateQueries({ queryKey: ["assets"] });
  },
}));

/** How far a folder that is being brought in is, on every screen. */
export function FolderImportNote() {
  const run = useFolderImport((s) => s.run);
  const dismiss = useFolderImport((s) => s.dismiss);
  if (!run) return null;
  return (
    <div role="status" className="fixed bottom-14 left-24 z-[60] flex w-80 flex-col gap-1.5 rounded-xl border border-line-strong bg-panel px-3.5 py-2.5 shadow-2xl shadow-shade/60">
      <div className="flex items-center gap-2">
        <FolderUp size={14} className="shrink-0 text-ink-2" />
        <span className="min-w-0 grow truncate font-semibold">{run.over ? `"${run.name}" is in your library` : `Bringing in "${run.name}"`}</span>
        {run.over && <button type="button" aria-label="Close" onClick={dismiss} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-hover"><X size={13} /></button>}
      </div>
      {!run.over && <Bar value={run.total ? (run.done / run.total) * 100 : 0} />}
      <span className="text-xs text-ink-2">
        {run.total === 0 ? "It holds no picture, video or sound." : `${run.done} of ${run.total}`}
        {run.failed > 0 && <span className="text-warn-ink"> · {run.failed} could not be read</span>}
        {run.skipped > 0 && ` · ${run.skipped} other file${run.skipped === 1 ? "" : "s"} left out`}
      </span>
    </div>
  );
}
