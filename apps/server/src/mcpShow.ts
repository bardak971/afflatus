import { randomUUID } from "node:crypto";
import { SETTING_TABS, type SettingTab } from "@afflatus/core";
import { z } from "zod";
import { httpError, notFound } from "./errors";
import { quoted, tool, type ToolCtx } from "./mcpTool";
import { unwrittenOf } from "./unwrittenDrafts";
import type { ShowDid } from "./whatsOpen";

/**
 * whats_open's counterpart: an agent shows the user what it made, on the page they have open (card #151). A "show" live
 * event goes to the browser seen last (whereReport.ts), and its tab in front either goes there, or, while the user is typing,
 * says "<token> wants to show you …" in a toast with Go (the web's agentShow.ts). The page answers which (POST
 * /api/where/shown), and the agent is told: gone there, asked, or no page in front to hear it.
 */

/** Where a page is asked to go: a draft, a timeline and maybe one of its clips (by number), a library item, a Settings tab. */
export type ShowTo =
  | { draft: string }
  | { timeline: string; clip?: number }
  | { item: string; folder: string | null; project: string | null; inBin: boolean }
  | { settings: SettingTab; setting?: string };

/** What a "show" live event says (events.ts relays it whole; the web's agentShow.ts takes it). */
export interface ShowEvent {
  /** The ask's id, which the page's answer names. */
  ask: string;
  /** The token's name, as the toast says it. */
  by: string;
  /** The browser it is for (whereReport.ts browserKey); null: whichever page is in front. */
  browser: string | null;
  /** What it shows, in words: the draft “Portrait”, clip 3 of “Trailer”. */
  said: string;
  to: ShowTo;
}

/** How long a page in front is given to answer: it answers at once, unless the network is slow. */
const ANSWER_MS = 4000;

const TAB_IDS = SETTING_TABS.map((t) => t.id) as [SettingTab, ...SettingTab[]];

/** The target as asked, checked, and said in words: refused when it is not there. */
async function targetOf(ctx: ToolCtx, a: { draft?: string; timeline?: string; clip?: string | number; item?: string; settings?: SettingTab; setting?: string }): Promise<{ to: ShowTo; said: string }> {
  const { db } = ctx.s;
  const asked = [a.draft, a.timeline, a.item, a.settings].filter((x) => x !== undefined).length;
  if (a.clip !== undefined && a.timeline === undefined) throw httpError("A clip is shown on its timeline: name the timeline too.");
  if (a.setting !== undefined && a.settings === undefined) throw httpError("A setting is shown on its Settings tab: name the tab too.");
  if (asked !== 1) throw httpError("Name one thing to show: a draft, a timeline (and a clip of it), a library item, or a Settings tab.");
  if (a.draft !== undefined) {
    const d = (await db.selectFrom("drafts").select(["id", "name", "title"]).where("id", "=", a.draft).executeTakeFirst()) ?? unwrittenOf(db).get(a.draft);
    if (!d) throw notFound("that draft");
    return { to: { draft: d.id }, said: `the draft ${quoted(d.name || d.title || "Untitled draft")}` };
  }
  if (a.timeline !== undefined) {
    const t = await db.selectFrom("timelines").select(["id", "name"]).where("id", "=", a.timeline).executeTakeFirst();
    if (!t) throw notFound("that timeline");
    if (a.clip === undefined) return { to: { timeline: t.id }, said: `the timeline ${quoted(t.name)}` };
    const clips = await db.selectFrom("clips").select("id").where("timeline_id", "=", t.id).orderBy("position").execute();
    // a clip by its id, or by its number on the timeline as the editor says it
    const n = typeof a.clip === "number" ? a.clip : clips.findIndex((c) => c.id === a.clip) + 1;
    if (!(n >= 1 && n <= clips.length)) throw httpError(`${quoted(t.name)} has no such clip: its clips are 1 to ${clips.length}.`, 404);
    return { to: { timeline: t.id, clip: n }, said: `clip ${n} of ${quoted(t.name)}` };
  }
  if (a.item !== undefined) {
    const it = await db.selectFrom("assets").leftJoin("folders", "folders.id", "assets.folder_id")
      .select(["assets.id", "assets.name", "assets.kind", "assets.folder_id", "assets.deleted_at", "folders.project_id"]).where("assets.id", "=", a.item).executeTakeFirst();
    if (!it) throw notFound("that item");
    return { to: { item: it.id, folder: it.folder_id, project: it.project_id ?? null, inBin: it.deleted_at !== null }, said: `${it.kind === "image" ? "the picture" : it.kind === "video" ? "the video" : "the sound"} ${quoted(it.name || it.id)}${it.deleted_at ? " (in the bin)" : ""}` };
  }
  // the Access rows ("access", "access.mcp"…) left Interface for a tab of their own: an agent naming the old tab lands there,
  // as the page does
  const id = a.settings === "interface" && /^access(\.|$)/.test(a.setting ?? "") ? "access" : a.settings;
  const tab = SETTING_TABS.find((t) => t.id === id)!;
  return { to: { settings: tab.id, ...(a.setting ? { setting: a.setting } : {}) }, said: `Settings › ${tab.label}` };
}

const showPage = tool({
  name: "show_page",
  scope: "make",
  title: "Show the user a page",
  description: "Open something on the user's page, to show them what was made: a draft (in Studio › Create), a timeline in its editor (and a clip of it, selected), a library item (shown large in its folder), or a Settings tab. The page in front goes there at once, unless the user typed in the last few seconds: it then says \"<token> wants to show you …\" with Go, and leaves them be. The answer says which, or that no page of Afflatus is open in front. whats_open says where they are.",
  input: {
    draft: z.string().max(64).optional().describe("A draft's id (list_drafts)."),
    timeline: z.string().max(64).optional().describe("A timeline's id (list_timelines)."),
    clip: z.union([z.number().int().min(1), z.string().max(64)]).optional().describe("With `timeline`: a clip, by its number (1 is the first) or id."),
    item: z.string().max(64).optional().describe("A library item's id (search_library)."),
    settings: z.enum(TAB_IDS).optional().describe("A Settings tab."),
    setting: z.string().max(80).optional().describe("With `settings`: the row to land on, as Settings' search names it (\"rented.bootlogs\", \"models.sets\")."),
  },
  async run(a, ctx) {
    const { s } = ctx;
    const { to, said } = await targetOf(ctx, a);
    if (!s.mcp.where.pagesOpen()) {
      ctx.said(`Asked to show ${said}: no page open`);
      return { shown: false, said: "No page of Afflatus is open: nothing was shown. Tell the user where it is instead." };
    }
    const ask = randomUUID();
    const answer = s.mcp.where.answerOf(ask, ANSWER_MS);
    s.queue.events.emit("show", { ask, by: ctx.token.name, browser: s.mcp.where.lastBrowser(), said, to } satisfies ShowEvent);
    const did: ShowDid | null = await answer;
    ctx.said(`Showed ${said}${did === "moved" ? "" : did === "asked" ? ": asked, the user was typing" : ": no page in front"}`);
    if (did === "moved") return { shown: true, said: `The user's page now shows ${said}.` };
    if (did === "asked") return { shown: false, asked: true, said: `The user was typing: their page asks whether to show ${said} (a toast with Go). It did not move.` };
    return { shown: false, said: "Afflatus is open, but no page of it is in front to show it on (a tab or a window in the background): nothing moved." };
  },
});

export const SHOW_TOOLS = [showPage];
