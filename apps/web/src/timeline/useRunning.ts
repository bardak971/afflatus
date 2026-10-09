import type { RunningJob } from "../api";
import { useQueueOf } from "../screens/studio/queueOf";

/**
 * The render under way of this clip, read from the queue on its own: only what shows its progress (the clip on the
 * track, the panel's footer, the live preview) draws again at every step, not the whole editor.
 */
export const useRunningOf = (clip: string | null | undefined): RunningJob | null =>
  useQueueOf((q) => (clip && q.running?.clipId === clip ? q.running : null)) ?? null;
