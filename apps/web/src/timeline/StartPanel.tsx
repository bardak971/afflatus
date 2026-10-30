import { useState } from "react";
import { ImagePlus, Plus } from "lucide-react";
import { Select } from "../Select";
import { AutoText, Button } from "../ui";

/** The panel of an empty timeline: start from an image, describe a scene for the designer to plan, or add the first clip by hand. */
export function StartPanel({ busy, planning, onPickImage, onPlan, onNewClip }: {
  /** A clip is being added. */
  busy: boolean;
  /** The designer is planning the clips. */
  planning: boolean;
  onPickImage(): void;
  /** A scene in a few words and how many clips to make of it. */
  onPlan(idea: string, clips: number): void;
  onNewClip(): void;
}) {
  const [idea, setIdea] = useState("");
  const [planned, setPlanned] = useState(4);
  return (
    <>
      <span className="font-semibold text-ink">Start from an image</span>
      <span>It becomes the first frame of your video.</span>
      <span><Button onClick={onPickImage} disabled={busy}><ImagePlus size={15} /> Choose an image</Button></span>
      <span className="font-semibold text-ink">Or describe a scene</span>
      <span>Write what should happen. The designer splits it into clips you can change before anything is rendered.</span>
      <AutoText rows={3} aria-label="Scene" value={idea} placeholder="A woman has coffee on a terrace at sunset, walks to the railing and waves at a boat." onChange={(e) => setIdea(e.target.value)} className="w-full rounded-lg border border-line bg-raised px-3 py-2.5 text-ink placeholder:text-ink-3" />
      <span className="flex items-center gap-2">
        <span className="w-28"><Select size="sm" label="How many clips" value={String(planned)} onChange={(v) => setPlanned(Number(v))} options={[2, 3, 4, 5, 6, 8].map((n) => ({ value: String(n), label: `${n} clips` }))} /></span>
        <Button tone="primary" onClick={() => onPlan(idea, planned)} disabled={!idea.trim() || planning}>{planning ? "Planning…" : "Plan the clips"}</Button>
      </span>
      <span className="font-semibold text-ink">Or write it yourself</span>
      <span><Button onClick={onNewClip} disabled={busy}><Plus size={15} strokeWidth={2.6} /> Add the first clip</Button></span>
    </>
  );
}
