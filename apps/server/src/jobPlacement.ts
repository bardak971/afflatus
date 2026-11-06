import { readJson, type JobRow } from "./queueModel";

/**
 * Where a job's results land (card #293): the draft it was sent from, the folder they go to, the timeline clip it renders a
 * take of, the take a finish finishes, the stack it renders versions of, its X/Y/Z grid cell. Written to the job's row once
 * (placementColumns), read back for a retry (placementOf) and shown by both queue views (placementView): a field added here
 * is carried on every one of those ways, the retry's too, which tests reach least. A field lost there would land a paid
 * re-render somewhere else.
 */
export interface JobPlacement {
  draft: string | null;
  folder: string | null;
  /** The timeline clip, whether its take should end where the next clip begins, the pinned pictures it flips (input ids). */
  clip: { id: string; fit: boolean; mirror?: readonly string[] } | null;
  /** A finish job: the take whose finished version its result is. */
  finishedFrom: string | null;
  /** The picture its results come back under as versions (versions.ts): on the row, the stack's root when it was queued. */
  versionOf: string | null;
  /** A cell of an X/Y/Z grid (grids.ts): the grid's id and the cell's place on its board ("x.y.z"), carried by what it makes. */
  grid: { id: string; cell: string } | null;
}

/** The job columns a placement is kept in. */
type PlacementRow = Pick<JobRow, "draft_id" | "folder_id" | "clip_id" | "clip_fit" | "clip_mirror" | "finished_from" | "version_of" | "grid_id" | "grid_cell">;

/** A placement as the job's columns, any field left out none; `versionOf` as it is given (the insert resolves the stack's root first). */
export const placementColumns = (p: Partial<JobPlacement>): Required<PlacementRow> => ({
  draft_id: p.draft ?? null, folder_id: p.folder ?? null,
  clip_id: p.clip?.id ?? null, clip_fit: p.clip?.fit ? 1 : 0, clip_mirror: p.clip?.mirror?.length ? JSON.stringify(p.clip.mirror) : null,
  finished_from: p.finishedFrom ?? null, version_of: p.versionOf ?? null,
  grid_id: p.grid?.id ?? null, grid_cell: p.grid?.cell ?? null,
});

/**
 * A job's placement read back from its row: what a retry is queued with, so that it lands where the job it repeats was to,
 * and what its results are filed by (queueStore.ts). A column not read is none.
 */
export const placementOf = (row: Partial<PlacementRow>): JobPlacement => ({
  draft: row.draft_id ?? null, folder: row.folder_id ?? null,
  // with the flips it was sent with: done again, it renders what it was asked to, whatever the clip says now
  clip: row.clip_id ? { id: row.clip_id, fit: Boolean(row.clip_fit), mirror: readJson<string[]>(row.clip_mirror, []) } : null,
  finishedFrom: row.finished_from ?? null, versionOf: row.version_of ?? null,
  grid: row.grid_id && row.grid_cell ? { id: row.grid_id, cell: row.grid_cell } : null,
});

/** What the queue's views (waiting, running, the finished list) say of a job's placement. */
export const placementView = (r: Pick<JobRow, "clip_id" | "draft_id" | "version_of" | "grid_id" | "grid_cell">) => ({
  clipId: r.clip_id, draftId: r.draft_id,
  /** The picture whose versions it renders (the root of the stack: Keep moves it to the kept one); null: it makes new items. */
  versionOf: r.version_of ?? null,
  /** Of a cell of an X/Y/Z grid: the grid and the cell's place on its board ("x.y.z"), for its live tile there; null otherwise. */
  grid: r.grid_id && r.grid_cell ? { id: r.grid_id, cell: r.grid_cell } : null,
});
