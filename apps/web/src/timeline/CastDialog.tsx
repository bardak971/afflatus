import { Users } from "lucide-react";
import type { Timeline, TimelinePatch } from "../api";
import { Dialog, DialogFoot, DialogHead, DIALOG } from "../Dialog";
import { FieldRow } from "../fields";
import { Kbd } from "../Keys";
import { LookBar } from "../LookBar";
import { AutoText, Button, cx, Help } from "../ui";

/** Cast and look: who is in the video, where it happens, its style and mood, for every clip that has no cast and look of its own. */
export function CastDialog({ timeline: t, mood, onMood: setMood, onEdit, onClose }: {
  timeline: Timeline;
  /** The mood being typed; null while the box shows the timeline's. */
  mood: string | null;
  onMood(mood: string | null): void;
  onEdit(patch: TimelinePatch): void;
  onClose(): void;
}) {
  // the mood typed is kept when the box is left, and when the dialog closes (Esc closes it without leaving the box)
  const keep = () => {
    if (mood !== null && mood.trim() !== t.mood) onEdit({ mood: mood.trim() });
    setMood(null);
  };
  const close = () => {
    keep();
    onClose();
  };
  return (
    <Dialog label="Cast and look" onClose={close} className={cx(DIALOG, "max-w-lg")}>
        <DialogHead
          icon={<Users size={16} />}
          title="Cast and look"
          sub={<span className="flex items-center gap-1.5">Every clip without its own · from the next take<Help title="Cast and look" text="Who is in the video, where it happens, its style and mood: set once here, used by every clip unless a clip is given its own cast and look, from the next take of each clip." /></span>}
          onClose={close}
        />
        <LookBar title="In this video" look={t.look} onChange={(look) => onEdit({ look })} />
        <FieldRow label="Mood" htmlFor="cast-mood" note="A few words every clip keeps: they are added to what happens in each clip, and the designer writes with them in mind.">
          <AutoText
            id="cast-mood"
            rows={1}
            value={mood ?? t.mood}
            placeholder="warm evening light, calm, film grain"
            onChange={(e) => setMood(e.target.value)}
            onBlur={keep}
            className="w-full rounded-lg border border-line bg-raised px-3 py-2 text-ink placeholder:text-ink-3"
          />
        </FieldRow>
        <DialogFoot>
          <Button tone="quiet" onClick={close}>Close <Kbd>Esc</Kbd></Button>
        </DialogFoot>
    </Dialog>
  );
}
