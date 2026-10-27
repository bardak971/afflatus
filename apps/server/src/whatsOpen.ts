import { deviceName } from "./access";
import type { Db } from "./db";
import { unwrittenOf } from "./unwrittenDrafts";

/**
 * Where each device is in Afflatus: its page, and the draft, timeline or clip it has open. The page says it as it moves
 * (App.tsx useWhereReport: on navigation and when it comes to the front, a small POST), and the MCP tool `whats_open`
 * reads the device seen last, so that an agent works where the user is. Kept in memory only: after a restart nothing is
 * known until a page moves or comes to the front again.
 */

/** What a page says of itself. */
export interface WhereSaid {
  /** The page's address ("/create", "/timelines/abc"). */
  path: string;
  draft?: string | null;
  timeline?: string | null;
  clip?: string | null;
}

interface Where extends WhereSaid { device: string; at: number }

/** What `whats_open` answers: the page in words, its address, the items open by id and name, the device and when. */
export interface WhatsOpen {
  device: string;
  page: string;
  path: string;
  at: string;
  draft: { id: string; name: string } | null;
  timeline: { id: string; name: string } | null;
  clip: { id: string; name: string } | null;
}

/** The devices kept at most: a page per browser, a few browsers. */
const KEEP = 50;

/** A page's address said as the rail names it. */
export function pageOf(path: string): string {
  const p = path.split("?")[0] ?? "/";
  if (p === "/") return "Studio";
  if (p === "/create") return "Studio › Create";
  if (p === "/timelines") return "Studio › Timelines";
  if (p.startsWith("/timelines/")) return "Timeline editor";
  if (p === "/kit") return "Prompt kit";
  if (p.startsWith("/workflows")) return "Workflows";
  if (p === "/queue") return "Queue";
  if (p.startsWith("/settings")) {
    const tab = p.split("/")[2];
    return tab ? `Settings › ${tab[0]!.toUpperCase()}${tab.slice(1)}` : "Settings";
  }
  return p;
}

export class WhereNow {
  private readonly by = new Map<string, Where>();

  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  /** A page said where it is: `key` tells its browser from another (its session, else a key of its own), `ua` names the device. */
  said(key: string, ua: string, where: WhereSaid): void {
    this.by.delete(key);
    this.by.set(key, { ...where, device: deviceName(ua), at: this.now() });
    // the oldest let go: the map is in the order last said
    while (this.by.size > KEEP) this.by.delete(this.by.keys().next().value!);
  }

  /** The device seen last, with the names of what it has open; null when no page has said anything since the start. */
  async latest(): Promise<WhatsOpen | null> {
    const last = [...this.by.values()].at(-1);
    if (!last) return null;
    // a blank draft is held in memory until something is put in it (unwrittenDrafts.ts): still the one open
    const draft = last.draft ? (await this.db.selectFrom("drafts").select(["id", "name", "title"]).where("id", "=", last.draft).executeTakeFirst()) ?? unwrittenOf(this.db).get(last.draft) : undefined;
    const timeline = last.timeline ? await this.db.selectFrom("timelines").select(["id", "name"]).where("id", "=", last.timeline).executeTakeFirst() : undefined;
    const clip = last.clip ? await this.db.selectFrom("clips").select(["id", "timeline_id", "position"]).where("id", "=", last.clip).executeTakeFirst() : undefined;
    // a clip is named by its number on its timeline, as the editor and the command bar say it
    const before = clip ? await this.db.selectFrom("clips").select((eb) => eb.fn.countAll<number>().as("n")).where("timeline_id", "=", clip.timeline_id).where("position", "<", clip.position).executeTakeFirstOrThrow() : null;
    return {
      device: last.device, page: pageOf(last.path), path: last.path, at: new Date(last.at).toISOString(),
      draft: draft ? { id: draft.id, name: draft.name || draft.title || "Untitled draft" } : null,
      timeline: timeline ? { id: timeline.id, name: timeline.name } : null,
      clip: clip && before ? { id: clip.id, name: `Clip ${Number(before.n) + 1}` } : null,
    };
  }
}
