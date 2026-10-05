import type { Timeline, TimelinePatch } from "../api";
import { Dialog } from "../Dialog";
import { LookBar } from "../LookBar";
import { AutoText, Button } from "../ui";

/** Cast and places: who is in the video, where it happens and how it looks, for every clip that has no cast of its own. */
export function CastDialog({ timeline: t, mood, onMood: setMood, onEdit, onClose }: {
  timeline: Timeline;
  /** The mood being typed; null while the box shows the timeline's. */
  mood: string | null;
  onMood(mood: string | null): void;
  onEdit(patch: TimelinePatch): void;
  onClose(): void;
}) {
  return (
    <Dialog label="Cast and places" onClose={onClose} className="flex w-full max-w-lg flex-col gap-3.5 rounded-2xl border border-line-strong bg-panel p-5">
        <span className="text-base font-semibold">Cast and places</span>
        <span className="text-ink-2">Who is in the video, where it happens and how it looks. Set once here, used by every clip, unless a clip is given its own. It counts from the next take of each clip.</span>
        <LookBar title="In this video" look={t.look} onChange={(look) => onEdit({ look })} />
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold">Look and mood</span>
          <AutoText
            rows={1}
            value={mood ?? t.mood}
            placeholder="warm evening light, calm, film grain"
            onChange={(e) => setMood(e.target.value)}
            onBlur={() => {
              if (mood !== null && mood.trim() !== t.mood) onEdit({ mood: mood.trim() });
              setMood(null);
            }}
            className="w-full rounded-lg border border-line bg-raised px-3 py-2 text-ink placeholder:text-ink-3"
          />
          <span className="text-xs text-ink-2">A few words every clip keeps: they are added to what happens in each clip, and the designer writes with them in mind.</span>
        </label>
        <div><Button tone="quiet" onClick={onClose}>Close</Button></div>
    </Dialog>
  );
}
