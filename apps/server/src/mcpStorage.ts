import { plural } from "@afflatus/core";
import { z } from "zod";
import { clearUnused } from "./drafts";
import { httpError } from "./errors";
import { jobRow, mayTouch } from "./mcpRender";
import { quoted, tool } from "./mcpTool";
import { binIdleTakes, storageView } from "./usage";

/**
 * Space and tidying, from outside (MCP): where the space goes as Settings › Storage counts it, the takes no clip plays
 * binned across every timeline, the drafts left unused cleared, a finished job taken off the queue's list. Each through
 * the web's own path (usage.ts, drafts.ts clearUnused, the queue's dismiss). Emptying the bin, erasing an item for good and
 * forgetting the render times stay in Afflatus.
 */

/** A count and its size, as these tools say them. */
const counted = (x: { count: number; bytes: number }) => ({ count: x.count, mb: Math.round(x.bytes / 2 ** 20) });
const mbOf = (bytes: number) => Math.round(bytes / 2 ** 20);

const storage = tool({
  name: "storage",
  scope: "look",
  title: "Storage",
  description: "Where the library's space goes, as Settings › Storage counts it (in MB): pictures, videos, sounds; the takes no clip plays (videos kept only because a clip once rendered them: bin_idle_takes); the bin (emptied by the user in Afflatus, or after its week); the results nobody kept (they go to the bin a day after they were made).",
  async run(_args, ctx) {
    const v = await storageView(ctx.s);
    ctx.said(`Looked at the storage: ${mbOf(v.total)} MB in all`);
    return {
      totalMb: mbOf(v.total), picturesMb: mbOf(v.pictures), videosMb: mbOf(v.videos), soundsMb: mbOf(v.sounds),
      idleTakes: counted(v.idleTakes), bin: counted(v.bin), unkept: counted(v.unkept),
    };
  },
});

const binIdle = tool({
  name: "bin_idle_takes",
  scope: "make",
  title: "Bin the takes no clip plays",
  description: "The takes no clip plays and nothing else needs, on every timeline, to the bin, as Settings › Storage's Bin unused takes does (bin_unused_takes does one timeline, with an undo step): their clips forget them. Not a draft a kept take was finished from or carries on from, nor a video another clip, timeline, person, preset or waiting job uses, nor a linked folder's file. restore brings a video back to the library until the user empties the bin. Answers how many videos went.",
  async run(_args, ctx) {
    const moved = await binIdleTakes(ctx.s);
    ctx.said(moved ? `Binned ${plural(moved, "take")} no clip plays` : "Looked for takes no clip plays: none");
    return { binned: moved, ...(moved ? { said: `${plural(moved, "video")} went to the bin: restore brings one back until the user empties the bin.` } : { said: "No take is unused: nothing went." }) };
  },
});

const clearUnusedDrafts = tool({
  name: "clear_unused_drafts",
  scope: "make",
  title: "Clear unused drafts",
  description: "Delete the drafts left unused, as the Projects panel's Clear does: those with no prompt, no name, no conversation and nothing made from them still in the library (settings picked and left). Of one project, the Inbox (\"none\"), or all when left out. The draft open in Afflatus stays. Deleted drafts do not come back.",
  input: { project: z.string().optional().describe("A project's id (list_places), or \"none\": the Inbox; left out: every project.") },
  async run({ project }, ctx) {
    const { s } = ctx;
    if (project && project !== "none" && !(await s.db.selectFrom("projects").select("id").where("id", "=", project).executeTakeFirst())) throw httpError("There is no such project: list_places gives the ids.", 404);
    const open = (await s.mcp.where.latest())?.draft?.id;
    const deleted = await clearUnused(s.db, project, open);
    ctx.said(deleted ? `Cleared ${plural(deleted, "unused draft")}` : "Looked for unused drafts: none");
    return { deleted };
  },
});

const dismiss = tool({
  name: "dismiss",
  scope: "make",
  title: "Dismiss a job",
  description: "Take a finished, failed or cancelled job off the queue's list, as its row's × does: what it made stays in the library. A job still waiting or running is refused (cancel stops it), and so is one a waiting job carries on from. This token's own jobs and the ones the user queued; another token's are refused.",
  input: { job: z.string().min(1) },
  async run({ job: id }, ctx) {
    const { s } = ctx;
    const row = await jobRow(s, id);
    await mayTouch(s, ctx, row);
    if (row.status === "queued" || row.status === "running") throw httpError(`${quoted(row.label)} has not ended yet: it is ${row.status === "running" ? "running" : "waiting"}. cancel stops it.`);
    if (!(await s.queue.dismiss(id))) throw httpError(`${quoted(row.label)} stays on the list: a job waiting or running carries on from it.`);
    ctx.said(`Dismissed ${quoted(row.label)}`);
    return { dismissed: id };
  },
});

export const STORAGE_TOOLS = [storage, binIdle, clearUnusedDrafts, dismiss];
