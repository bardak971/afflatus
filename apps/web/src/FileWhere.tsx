import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Copy, FolderOpen } from "lucide-react";
import { api } from "./api";
import { useCopied } from "./hooks";
import { queryKeys } from "./queryKeys";
import { useSayFailed } from "./sayFailed";
import { cx, IconButton } from "./ui";

/** A path that wraps after its separators, at a folder, rather than in the middle of a name. */
const wrapped = (path: string) => path.split(/(?<=[\\/])/).flatMap((part, i) => (i ? [<wbr key={i} />, part] : [part]));

/** One place of a file: its path, and Show in folder (this computer) or Copy. */
function PlaceLine({ text, onShow, busy }: { text: string; onShow?: () => void; busy?: boolean }) {
  const { copied, copy } = useCopied();
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="min-w-0 font-mono text-meta wrap-anywhere text-ink-3">{wrapped(text)}</span>
      {onShow
        ? <IconButton size={24} label="Show in folder" disabled={busy} onClick={onShow}><FolderOpen size={13} /></IconButton>
        : <IconButton size={24} label={copied ? "Copied" : "Copy path"} onClick={() => copy(text)}>{copied ? <Check size={13} /> : <Copy size={13} />}</IconButton>}
    </span>
  );
}

/**
 * Where a model file is on disk (card #64), under its name: each whole path it is at (a copy in an A1111 folder of
 * extra_model_paths.yaml, or under a folder's older name, shows as a line more), with Show in folder when this page is open
 * on the computer Afflatus and ComfyUI run on, else Copy. A ComfyUI on another machine says no path: its folder and name
 * are copied then. The page never sends a path: Show in folder names the file and which of its places, the server finds it.
 * Find models › Yours, Settings › Models' files and a finished download's line all show it.
 */
export function FileWhere({ folder, file, machine, className }: { folder: string; file: string; machine?: string; className?: string }) {
  const where = useQuery({
    queryKey: queryKeys.modelFileWhere(folder, file, machine),
    queryFn: ({ signal }) => api.modelFileWhere({ folder, file, ...(machine ? { machine } : {}) }, { signal }),
    staleTime: 60_000,
  });
  const failed = useSayFailed({ id: "show-in-folder" });
  const show = useMutation({ mutationFn: (at: number) => api.revealModelFile({ folder, file, at, ...(machine ? { machine } : {}) }), onError: failed("Could not show it in its folder") });
  const d = where.data;
  if (!d) return null;
  return (
    <span className={cx("flex min-w-0 flex-col", className)}>
      {d.places.length
        ? d.places.map((p, i) => <PlaceLine key={p.path} text={p.path} busy={show.isPending} onShow={d.reveal ? () => show.mutate(i) : undefined} />)
        : <PlaceLine text={`${folder}/${file}`} />}
    </span>
  );
}
