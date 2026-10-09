import { describe, expect, it } from "vitest";
import { logRows, type LogLine } from "../src/screens/queue/logRows";

const at = (s: number) => new Date(Date.UTC(2026, 9, 9, 12, 0, s)).toISOString();
let n = 0;
const line = (m: string, s = 0, tone: LogLine["tone"] = "plain"): LogLine => ({ key: `k${n++}`, t: at(s), m, tone });

describe("ComfyUI's log as it is read", () => {
  it("folds a progress bar's updates into its latest, and a new bar starts its own line", () => {
    const rows = logRows([
      line("  5%|▌         | 1/20 [00:04<01:20,  4.2s/it]"),
      line(" 45%|████▌     | 9/20 [00:41<00:50,  4.6s/it]"),
      line("100%|██████████| 20/20 [01:30<00:00,  4.5s/it]"),
      line("100%|██████████| 4/4 [00:02<00:00,  1.9it/s]"),
      line("Prompt executed in 95.2 seconds"),
    ], []);
    expect(rows.map((r) => r.kind)).toEqual(["progress", "progress", "line"]);
    expect(rows[0]).toMatchObject({ kind: "progress", folded: 3 });
    expect(rows[0]!.kind === "progress" && rows[0]!.line.m).toContain("20/20");
  });

  it("folds a traceback into the line naming what was raised", () => {
    const rows = logRows([
      line("!!! Exception during processing !!!"),
      line("Traceback (most recent call last):", 1, "error"),
      line('  File "execution.py", line 323, in execute'),
      line("    output_data = get_output_data(obj, input_data_all)"),
      line("torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB"),
      line("Prompt executed in 3.1 seconds"),
    ], []);
    expect(rows.map((r) => r.kind)).toEqual(["line", "trace", "line"]);
    const trace = rows[1]!;
    expect(trace.kind === "trace" && trace.last.m).toMatch(/^torch\.OutOfMemoryError/);
    expect(trace.kind === "trace" && trace.lines).toHaveLength(4);
  });

  it("gives each prompt the job that started nearest it, and its lines that job", () => {
    const rows = logRows([line("got prompt", 10), line("Requested to load WanModel", 11), line("got prompt", 300), line("loaded completely", 301)], [
      { id: "a", label: "Big Air · clip 3 · take 2", startedAt: at(9) },
      { id: "b", label: "far away", startedAt: at(200) },
    ]);
    expect(rows[0]).toMatchObject({ kind: "start", job: "a", label: "Big Air · clip 3 · take 2" });
    expect(rows[1]).toMatchObject({ job: "a" });
    // no job within a minute of the second prompt: not guessed
    expect(rows[2]).toMatchObject({ kind: "start", job: null, label: null });
    expect(rows[3]).toMatchObject({ job: null });
  });
});
