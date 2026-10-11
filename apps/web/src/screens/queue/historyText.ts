import type { HistoryJob, Job } from "../../api";
import { clock, plural } from "../../format";

/**
 * What a row of the history is called: the name of what it made (renders are named as they are made), else the job's
 * label. A row that made several is called by what they share ("Terrace 01", "Terrace 02": "Terrace"), not after one of them.
 */
export function rowName(jobs: Pick<HistoryJob, "label" | "made">[]): string {
  const named = jobs.flatMap((j) => j.made).map((m) => m.name).filter(Boolean);
  if (named.length > 1) {
    const label = named[0]!.replace(/ \d{2,}$/, "");
    if (label && named.every((n) => n === label || n.startsWith(`${label} `))) return label;
  }
  return named[0] || jobs[0]?.label || "";
}

/** A cut that finishes a timeline's clip (an upscale: SeedVR2, RTX or a model) rather than keeping a range of it. */
export const isFinish = (job: Pick<Job, "kind" | "label">) => job.kind === "cut" && /· finish$/.test(job.label);

const KIND = { image: "picture", video: "video", audio: "audio" } as const;

/** The dim line under a row's name: what kind of thing it made, and its size or length ("video · 0:05 · 1024×576", "4 pictures · 1536×864"). */
export function rowFacts(jobs: Pick<HistoryJob, "kind" | "status" | "made" | "label">[]): string {
  const head = jobs[0];
  if (!head) return "";
  const made = jobs.flatMap((j) => j.made);
  const first = made[0];
  const size = first?.width && first.height ? `${first.width}×${first.height}` : "";
  const length = first?.durationMs ? clock(first.durationMs, { decimals: 1 }) : "";
  if (isFinish(head)) return made.length ? `finish · ${[length, size].filter(Boolean).join(" · ")}` : "finish · a new take of the clip";
  if (head.kind === "cut") return made.length ? `cut · ${plural(made.length, "video")} in the library` : "cut";
  if (head.kind === "export") return ["export", length, size].filter(Boolean).join(" · ");
  if (head.kind === "load") return "model load · renders nothing";
  if (head.status === "cancelled") return "cancelled";
  if (!first) return head.status === "done" ? "its result was deleted since" : "";
  const kind = made.length > 1 ? `${made.length} ${KIND[first.kind]}s` : KIND[first.kind];
  return [kind, first.kind === "image" ? "" : length, first.kind === "audio" ? "" : size].filter(Boolean).join(" · ");
}
