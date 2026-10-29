import { useQueryClient } from "@tanstack/react-query";
import { USUAL_FOLDERS, isModelFile } from "@afflatus/core";
import { useRef, useState, type DragEvent } from "react";
import { api, type ModelLibrary } from "../../api";
import { plural, size } from "../../format";
import { queryKeys } from "../../queryKeys";
import { Button, Chip, cx, Help, Spinner } from "../../ui";

/** A file dropped onto Model files, on its way into its folder. */
interface Adding {
  key: string;
  file: File;
  /** Its folder: read from its header, else picked on its line. */
  folder: string | null;
  state: "reading" | "ask" | "sending" | "done" | "failed";
  why?: string;
}

/** The biggest header read in the page to tell a file's kind: a safetensors header is small, one that says more is not one. */
const HEADER_MOST = 8 * 2 ** 20;

/** A .safetensors file's header (its tensors' names and shapes), read from its first bytes; null when it has none to read. */
async function headerOf(file: File): Promise<Record<string, unknown> | null> {
  if (!/\.safetensors$/i.test(file.name) || file.size < 8) return null;
  const n = Number(new DataView(await file.slice(0, 8).arrayBuffer()).getBigUint64(0, true));
  if (!(n > 0 && n <= HEADER_MOST && n + 8 <= file.size)) return null;
  try {
    return JSON.parse(await file.slice(8, 8 + n).text()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Model files dropped onto the tab: each one's folder read from its header (or asked on its line), then sent into it. */
export function useDropFiles(lib: ModelLibrary | undefined) {
  const client = useQueryClient();
  const [over, setOver] = useState(false);
  const [adding, setAdding] = useState<Adding[]>([]);
  const depth = useRef(0);
  const may = Boolean(lib && !lib.readOnly && !lib.noFolder);
  const change = (key: string, patch: Partial<Adding>) => setAdding((a) => a.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const send = async (a: Adding, folder: string) => {
    change(a.key, { folder, state: "sending" });
    try {
      await api.addModelFile(a.file, folder);
      change(a.key, { state: "done" });
      void client.invalidateQueries({ queryKey: queryKeys.modelInfo.all() });
    } catch (err) {
      change(a.key, { state: "failed", why: (err as Error).message });
    }
  };
  const take = async (files: File[]) => {
    const fresh = files.map((file) => ({ key: `${file.name}:${file.size}:${Math.random()}`, file, folder: null, state: isModelFile(file.name) ? "reading" : "failed", why: isModelFile(file.name) ? undefined : "not a model file" }) as Adding);
    setAdding((a) => [...a.filter((x) => x.state !== "done"), ...fresh]);
    for (const a of fresh.filter((x) => x.state === "reading")) {
      const folder = await api.modelFileKind(a.file.name, await headerOf(a.file).catch(() => null)).then((r) => r.folder, () => null);
      if (folder) void send(a, folder);
      else change(a.key, { state: "ask" });
    }
  };
  const has = (e: DragEvent) => may && [...e.dataTransfer.types].includes("Files");
  return {
    over, adding, send, clear: () => setAdding((a) => a.filter((x) => x.state === "sending" || x.state === "reading")),
    zone: {
      onDragEnter: (e: DragEvent) => { if (!has(e)) return; e.preventDefault(); depth.current++; setOver(true); },
      onDragOver: (e: DragEvent) => { if (has(e)) e.preventDefault(); },
      onDragLeave: (e: DragEvent) => { if (!has(e)) return; depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); },
      onDrop: (e: DragEvent) => {
        if (!has(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        void take([...e.dataTransfer.files]);
      },
    },
  };
}

/** The files dropped, one line each: its folder (picked where the header did not tell), how it goes. */
export function AddingStrip({ drop }: { drop: ReturnType<typeof useDropFiles> }) {
  if (!drop.adding.length) return null;
  const done = drop.adding.filter((a) => a.state === "done");
  return (
    <div className="flex flex-col gap-1.5 border-b border-line px-[18px] py-2.5">
      <span className="flex items-center gap-2 text-body">
        <b>Adding {plural(drop.adding.length, "file")}</b>
        {done.length > 0 && <span className="text-ink-2">{done.length} in place</span>}
        <Help text="Each dropped file goes into its kind's folder, the first ComfyUI reads for it: read from its header (a LoRA, a checkpoint, a diffusion model, a VAE, a text encoder…), else picked on its line. A file of the same name already there is never replaced." />
        <span className="grow" />
        <Button size="sm" onClick={drop.clear}>Clear the finished</Button>
      </span>
      {drop.adding.map((a) => (
        <span key={a.key} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,auto)] items-center gap-3 text-body">
          <span className="truncate font-mono text-xs">{a.file.name} <span className="text-ink-3">{size(a.file.size)}</span></span>
          <span className="flex items-center gap-1.5">
            {a.state === "ask"
              ? <>
                <span className="text-xs text-ink-2">Its kind?</span>
                {USUAL_FOLDERS.filter((f) => f !== "embeddings").map((f) => <Chip key={f} size="xs" onClick={() => void drop.send(a, f)}>{f}</Chip>)}
              </>
              : a.folder && <span className="font-mono text-xs text-ink-2">→ {a.folder}</span>}
          </span>
          <span className={cx("flex items-center gap-1.5 text-xs", a.state === "failed" ? "text-warn-ink" : a.state === "done" ? "text-good" : "text-ink-2")}>
            {(a.state === "reading" || a.state === "sending") && <Spinner />}
            {a.state === "reading" ? "reading its header" : a.state === "sending" ? "copying" : a.state === "done" ? "in place" : a.state === "failed" ? a.why : ""}
          </span>
        </span>
      ))}
    </div>
  );
}
