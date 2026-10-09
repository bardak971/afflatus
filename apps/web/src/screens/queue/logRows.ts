/**
 * ComfyUI's log as it is read: a progress bar's updates folded into one line (its latest), a Python traceback into
 * its last line (the stack under it), and each prompt given the job it ran for, so its lines can be shown alone.
 * Kept apart from the screen so that all of it is tested without a browser.
 */

export interface LogLine { key: string; t: string; m: string; tone: "error" | "warn" | "mark" | "plain" }

export type LogRow =
  | { kind: "line"; key: string; line: LogLine; job: string | null }
  /** A progress bar: how many updates were folded, and the latest. */
  | { kind: "progress"; key: string; line: LogLine; folded: number; job: string | null }
  /** A traceback: its last line, and every line of it. */
  | { kind: "trace"; key: string; last: LogLine; lines: LogLine[]; job: string | null }
  /** Where a prompt starts: the job it ran for, when known. */
  | { kind: "start"; key: string; line: LogLine; job: string | null; label: string | null };

/** A tqdm bar: "45%|████▌     | 9/20 [00:41<00:50, 4.6s/it]". Its total tells one bar from the next. */
const BAR = /\d{1,3}%\|[^|]*\|\s*\d+\/(\d+)/;
const STARTS = /got prompt/i;
const TRACE = /^Traceback \(most recent call last\)/;
/** The line a traceback ends on: "torch.OutOfMemoryError: CUDA out of memory…", "RuntimeError: …". */
const RAISED = /^[A-Za-z_][\w.]*(Error|Exception|Interrupt|Exit)\b/;

/** The jobs a prompt may have run for: the one whose start is nearest its "got prompt" line, within a minute. */
export interface JobAt { id: string; label: string; startedAt: string | null }

export function logRows(lines: LogLine[], jobs: JobAt[]): LogRow[] {
  const starts = jobs.filter((j) => j.startedAt).map((j) => ({ ...j, at: Date.parse(j.startedAt!) }));
  const jobAt = (t: string) => {
    const at = Date.parse(t);
    if (Number.isNaN(at)) return null;
    let best: (typeof starts)[number] | null = null;
    for (const j of starts) if (Math.abs(j.at - at) <= 60_000 && (!best || Math.abs(j.at - at) < Math.abs(best.at - at))) best = j;
    return best;
  };
  const rows: LogRow[] = [];
  let job: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const text = l.m.trim();
    if (STARTS.test(text)) {
      const found = jobAt(l.t);
      job = found?.id ?? null;
      rows.push({ kind: "start", key: l.key, line: l, job, label: found?.label ?? null });
      continue;
    }
    if (TRACE.test(text)) {
      // the stack goes on to the line that names what was raised (or to the next line that is not part of it)
      const block = [l];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const m = lines[j]!.m;
        block.push(lines[j]!);
        if (RAISED.test(m.trim()) && !/^\s/.test(m)) break;
        if (j - i > 200) break;
      }
      i = Math.min(j, lines.length - 1);
      rows.push({ kind: "trace", key: l.key, last: block[block.length - 1]!, lines: block, job });
      continue;
    }
    const bar = BAR.exec(text);
    const prev = rows[rows.length - 1];
    if (bar && prev?.kind === "progress" && BAR.exec(prev.line.m.trim())?.[1] === bar[1]) {
      rows[rows.length - 1] = { ...prev, line: l, folded: prev.folded + 1 };
      continue;
    }
    rows.push(bar ? { kind: "progress", key: l.key, line: l, folded: 1, job } : { kind: "line", key: l.key, line: l, job });
  }
  return rows;
}
