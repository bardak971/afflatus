import { Users } from "lucide-react";
import type { Timeline, TimelinePatch } from "../api";
import { Dialog, DialogFoot, DialogHead, DIALOG } from "../Dialog";
import { FieldRow } from "../fields";
import { Kbd } from "../Keys";
import { LookBar } from "../LookBar";
import { AutoText, Button, cx } from "../ui";

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
    <Dialog label="Cast and places" onClose={onClose} className={cx(DIALOG, "max-w-lg")}>
        <DialogHead icon={<Users size={16} />} title="Cast and places" sub="Who is in the video, where it happens, how it looks" onClose={onClose} />
        <span className="text-ink-2">Set once here, used by every clip unless a clip is given its own, from the next take of each clip.</span>
        <LookBar title="In this video" look={t.look} onChange={(look) => onEdit({ look })} />
        <FieldRow label="Look and mood" htmlFor="cast-mood" note="A few words every clip keeps: they are added to what happens in each clip, and the designer writes with them in mind.">
          <AutoText
            id="cast-mood"
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
        </FieldRow>
        <DialogFoot>
          <Button tone="quiet" onClick={onClose}>Close <Kbd>Esc</Kbd></Button>
        </DialogFoot>
    </Dialog>
  );
}
