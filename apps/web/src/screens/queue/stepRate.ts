import { useQueueOf } from "../studio/queueOf";

/**
 * The running render's pace, in seconds per sampler step (s/it), over its last few steps: worked out here from the
 * step count's changes as the progress events bring them (at most four a second), not sent by the server.
 * One record for the whole page: the running card and the command bar read the same figure.
 */

/** How many steps back the pace is measured over. */
const STEPS_MEASURED = 5;

interface Mark { step: number; at: number }

/** The steps seen change for one job, and when. The first step seen is not a mark: it was seen mid-step, not as it began. */
export class StepClock {
  private id: string | null = null;
  private first: number | null = null;
  private marks: Mark[] = [];

  /** The step count of job `id` as seen at `at` (ms). The same count twice is one mark; a count that goes back (a new pass) starts over. */
  note(id: string, step: number, at: number): void {
    if (this.id !== id) {
      this.id = id;
      this.first = step;
      this.marks = [];
      return;
    }
    const last = this.marks[this.marks.length - 1]?.step ?? this.first;
    if (last === step) return;
    if (last !== null && step < last) {
      this.first = step;
      this.marks = [];
      return;
    }
    this.marks.push({ step, at });
    if (this.marks.length > STEPS_MEASURED + 1) this.marks.shift();
  }

  /** Seconds per step of job `id` over its last STEPS_MEASURED steps (fewer while it has fewer); null until two changes were seen. */
  rate(id: string): number | null {
    if (this.id !== id || this.marks.length < 2) return null;
    const last = this.marks[this.marks.length - 1]!;
    // the oldest mark within the window; a jump of several steps in one event counts as what it is
    const from = this.marks.find((m) => m.step >= last.step - STEPS_MEASURED && m !== last) ?? this.marks[this.marks.length - 2]!;
    return (last.at - from.at) / 1000 / (last.step - from.step);
  }
}

const clock = new StepClock();

/** "4.82 s/it": two decimals, as ComfyUI's console writes it. */
export const stepRateSaid = (seconds: number) => `${seconds.toFixed(2)} s/it`;

/** What the "?" next to a pace says. */
export const STEP_RATE_HELP = `Seconds per sampler step, over the last ${STEPS_MEASURED} steps. Higher than usual: a bigger size, a heavier LoRA stack, or VRAM spilling.`;

/**
 * The running render's s/it, live: null while nothing samples or before two steps were seen. Any screen can call
 * it (the running card, the command bar): the steps are noted as they come, whoever reads them.
 */
export function useStepRate(): { id: string; secondsPerStep: number } | null {
  const now = useQueueOf((q) => (q.running && q.running.steps > 0 ? { id: q.running.id, step: q.running.step } : null));
  if (!now) return null;
  // noting twice the same step is nothing: safe to do while drawing
  clock.note(now.id, now.step, Date.now());
  const rate = clock.rate(now.id);
  return rate !== null && rate > 0 ? { id: now.id, secondsPerStep: rate } : null;
}
