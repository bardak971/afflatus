import { useQueryClient } from "@tanstack/react-query";
import { Trash2, Undo2 } from "lucide-react";
import { itemsWord } from "../../assetCache";
import { emptyAll, restoreAll } from "../../binActions";
import { useStorage } from "../../data";
import { size } from "../../format";
import { Button, Help } from "../../ui";

/**
 * The bin's own line over its grid: that it is the bin, what it holds, how long things stay, and what is done with all
 * of it (Put all back, Empty the bin). The bin looked like any folder before, and the way out of it or through it was in
 * Settings. Nothing when it is empty: the grid says so.
 */
export function BinStrip() {
  const client = useQueryClient();
  const bin = useStorage().data?.bin;
  if (!bin?.count) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-raised px-3 py-2">
      <Trash2 size={15} className="shrink-0 text-ink-2" />
      <span className="font-semibold whitespace-nowrap">Bin</span>
      <span className="text-sm whitespace-nowrap text-ink-2">{itemsWord(bin.count)} · {size(bin.bytes)}</span>
      <span className="flex items-center gap-1 text-sm text-ink-2">
        each is erased a week after it was binned
        <Help text="Put back returns an item to where it was, unkept, with a new day before it goes to the bin again. What a timeline, a person or a queued job still uses is never erased." />
      </span>
      <span className="ml-auto flex items-center gap-1.5">
        <Button size="sm" onClick={() => void restoreAll(client)}><Undo2 size={13} /> Put all back</Button>
        <Button size="sm" onClick={() => void emptyAll(client)}><Trash2 size={13} /> Empty the bin…</Button>
      </span>
    </div>
  );
}
