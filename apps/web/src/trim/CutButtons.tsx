import { Copy, Scissors, Split } from "lucide-react";
import { Button } from "../ui";

/**
 * What Trim does with a range, for a video and for a sound alike: copied to the library (the file stays), split in three
 * or the range removed (the file goes to the bin). Off while busy, or while the range is the whole file.
 */
export function CutButtons({ what, busy, whole, onCopy, onSplit, onRemove }: {
  /** "video" or "sound": said in the tips. */
  what: string;
  busy: boolean;
  whole: boolean;
  onCopy(): void;
  onSplit(): void;
  onRemove(): void;
}) {
  const nothing = `The whole ${what}: there is nothing to cut.`;
  const off = busy || whole;
  return (
    <div role="group" aria-label="Cut" className="flex items-center gap-1">
      {/* the main action only when it can act: off, it reads as off, not as a faded call to action */}
      <Button size="sm" tone={off ? "plain" : "primary"} disabled={off} data-tip={whole ? nothing : `The range as a new ${what} in your library; this one stays.`} onClick={onCopy}><Copy size={13} /> Copy to library</Button>
      <Button size="sm" disabled={off} data-tip={whole ? nothing : `Three ${what}s: before the range, the range, after it. This one goes to the bin.`} onClick={onSplit}><Split size={13} /> Split</Button>
      <Button size="sm" disabled={off} data-tip={whole ? nothing : `One ${what} without the range. This one goes to the bin.`} onClick={onRemove}><Scissors size={13} /> Remove range</Button>
    </div>
  );
}
