import type { QueryClient } from "@tanstack/react-query";
import { FolderUp, X } from "lucide-react";
import { create } from "zustand";
import { api, type Folder } from "./api";
import { projectForNew } from "./project";
import { Bar } from "./ui";
import { queryKeys } from "./queryKeys";
import { plural } from "./format";

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
  /** What stopped it before it began (the folders could not be read). */
  error?: string;
}

/** The folders a file sits in under the folder that was picked, the picked one first. */
export const pathOf = (f: { webkitRelativePath?: string; name: string }) => (f.webkitRelativePath || f.name).split("/").slice(0, -1);

/**
 * The folder of the library a file's folders lead to, made when it is not there yet: each one once (the
 * same promise for every file that needs it), one already there under the same parent used again.
 */
export function folderMaker(into: string | null, known: Array<Pick<Folder, "id" | "parentId" | "name">>, make: (name: string, parent: string | null) => Promise<string>) {
  const made = new Map<string, Promise<string>>();
  const folderFor = (parts: string[]): Promise<string | null> => {
    if (!parts.length) return Promise.resolve(into);
    const key = parts.join("/");
    if (!made.has(key)) {
      made.set(key, (async () => {
        const parent = await folderFor(parts.slice(0, -1));
        const leaf = parts.at(-1)!.slice(0, 120);
        const there = known.find((f) => f.parentId === parent && f.name === leaf);
        return there ? there.id : make(leaf, parent);
      })());
    }
    return made.get(key)!;
  };
  return folderFor;
}

/** What a second import is told while one runs: one at a time, so that the note says how far the one under way is. */
export const IMPORT_UNDER_WAY = "An import is under way: wait for it to end";

/**
 * The library's lists follow by themselves while it runs: every upload is a "library" event, and live.ts
 * reads the lists again at most once a second. The QueryClient is kept for the folders made here.
 * `inside`: `into` is the picked folder itself, already made (the Inbox's), so each file's path is read
 * under it, without the picked folder's own name. `start` is false when it was refused (`busy`: another
 * import runs), for the caller to say so.
 */
export const useFolderImport = create<{
  run: Run | null;
  busy(): boolean;
  start(files: File[], into: string | null, client: QueryClient, inside?: boolean): Promise<boolean>;
  dismiss(): void;
}>((set, get) => ({
  run: null,
  busy: () => Boolean(get().run && !get().run!.over),
  dismiss: () => set({ run: null }),
  async start(files, into, client, inside = false) {
    if (get().busy()) return false;
    const media = files.filter((f) => /^(image|video|audio)\//.test(f.type));
    const name = pathOf(files[0] ?? new File([], ""))[0] ?? "a folder";
    set({ run: { name, done: 0, total: media.length, failed: 0, skipped: files.length - media.length, over: media.length === 0 } });
    if (!media.length) return true;
    const step = (patch: Partial<Run>) => set((s) => (s.run ? { run: { ...s.run, ...patch } } : s));
    try {
      const folderFor = folderMaker(into, (await api.folders()).items, async (leaf, parent) => (await api.createFolder(leaf, parent, parent ? undefined : projectForNew())).id);
      const left = [...media];
      // a few at a time: the server reads each file to make its small picture
      await Promise.all(Array.from({ length: 3 }, async () => {
        for (let file = left.shift(); file; file = left.shift()) {
          try {
            const folder = await folderFor(inside ? pathOf(file).slice(1) : pathOf(file));
            await api.upload(file, { folder: folder ?? undefined, project: projectForNew() });
            step({ done: get().run!.done + 1 });
          } catch {
            step({ done: get().run!.done + 1, failed: get().run!.failed + 1 });
          }
        }
      }));
    } catch (err) {
      step({ error: (err as Error).message });
    } finally {
      // over whatever happened: the note can be closed, and the next import is not refused
      step({ over: true });
      void client.invalidateQueries({ queryKey: queryKeys.folders() });
    }
    return true;
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
        <span className="min-w-0 grow truncate font-semibold">{run.error ? `"${run.name}" could not be imported` : run.over ? `"${run.name}" is in your library` : `Importing "${run.name}"`}</span>
        {run.over && <button type="button" aria-label="Close" onClick={dismiss} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-hover"><X size={13} /></button>}
      </div>
      {!run.over && <Bar value={run.total ? (run.done / run.total) * 100 : 0} />}
      <span className="text-xs text-ink-2">
        {run.total === 0 ? "It holds no image, video or audio file." : `${run.done} of ${run.total}`}
        {run.failed > 0 && <span className="text-warn-ink"> · {run.failed} failed</span>}
        {run.skipped > 0 && ` · ${plural(run.skipped, "other file")} skipped`}
      </span>
      {run.error && <span className="text-xs text-warn-ink">{run.error}</span>}
    </div>
  );
}
