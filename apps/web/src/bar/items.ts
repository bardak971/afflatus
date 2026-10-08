import type { CommandEntry, Entity, Job, PromptHistoryItem, RecipeInfo, RunningJob } from "../api";
import { clock, size, when } from "../format";
import type { CalcCard } from "./calc";
import { prepare, type Prepared } from "./match";
import { COMMANDS, type Command } from "./parse";
import { pageLabel, type SettingCtx, type SettingEntry, valueSaid } from "./settingsRegistry";

/** What one row of the bar is, the sections it falls in, and how each kind is said. */

export type Kind = "timeline" | "render" | "draft" | "project" | "folder" | "command" | "setting" | "job" | "calc" | "history" | "person";
export type Group = "Recent" | "Suggested" | "Timelines" | "Renders" | "Drafts" | "Projects & folders" | "Commands" | "Settings" | "Queue" | "Calculator" | "Prompt history" | "Cast";

export interface Item {
  /** Unique, and what the learned rank is kept under: "timeline:<id>", "cmd:pause", "set:hover.video". */
  key: string;
  kind: Kind;
  label: string;
  /** One line of detail. */
  meta: string;
  group: Group;
  /** What Enter does, in a word. */
  verb: string;
  p: Prepared;
  entry?: CommandEntry;
  /** A command with its figures: Enter runs it. */
  command?: Command;
  /** A command named but not yet given its figures: Enter (or Tab) completes the bar with what to type. */
  complete?: string;
  recipe?: RecipeInfo;
  setting?: SettingEntry;
  job?: { job: Job | RunningJob; state: "running" | "waiting" | "failed"; position?: number };
  card?: CalcCard;
  history?: PromptHistoryItem;
  person?: Extract<Entity, { kind: "person" }>;
  /** In an archived project: listed after the others. */
  archived?: boolean;
}

export const GROUP_OF: Record<Kind, Group> = {
  timeline: "Timelines", render: "Renders", draft: "Drafts", project: "Projects & folders", folder: "Projects & folders",
  command: "Commands", setting: "Settings", job: "Queue", calc: "Calculator", history: "Prompt history", person: "Cast",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const KIND_WORD = { image: "Image", video: "Video", audio: "Sound" } as const;

/**
 * A timeline's length: what is rendered of it, and what the editor's header says (clips not rendered yet at the length their
 * form asks for) when that is more. "0:12 rendered of 0:42"; one figure when both read the same.
 */
export function timelineLength(e: { durationMs: number; plannedMs: number }): string {
  const rendered = clock(e.durationMs);
  const planned = clock(e.plannedMs);
  return rendered === planned ? rendered : `${rendered} rendered of ${planned}`;
}

/** Every entry of the index as a row: its words, its detail line, its project said by name. */
export function indexItems(entries: readonly CommandEntry[], recipes: readonly RecipeInfo[], current: string | null): Item[] {
  const projects = new Map<string, { label: string; archived: boolean }>();
  for (const e of entries) if (e.kind === "project") projects.set(e.id, { label: e.label, archived: e.archived });
  const folders = new Map<string, string>();
  for (const e of entries) if (e.kind === "folder") folders.set(e.id, e.label);
  const place = (project: string | null) => (project ? projects.get(project)?.label ?? "a project" : "Inbox");
  const archived = (project: string | null) => Boolean(project && projects.get(project)?.archived);
  const recipeTitle = new Map(recipes.map((r) => [r.id, r.title]));
  const out: Item[] = [];
  for (const e of entries) {
    const base = { key: `${e.kind}:${e.id}`, label: e.label, p: prepare(e.label), entry: e };
    switch (e.kind) {
      case "timeline":
        out.push({ ...base, kind: "timeline", group: "Timelines", verb: "open", archived: archived(e.project), meta: ["Timeline", plural(e.clips, "clip"), timelineLength(e), e.exported && "exported", place(e.project)].filter(Boolean).join(" · ") });
        break;
      case "draft":
        out.push({ ...base, kind: "draft", group: "Drafts", verb: "open", archived: archived(e.project), meta: ["Draft", recipeTitle.get(e.recipe) ?? e.recipe, plural(e.renders, "render"), when(e.updatedAt), place(e.project)].join(" · ") });
        break;
      case "asset":
        out.push({
          ...base, key: `render:${e.id}`, kind: "render", group: "Renders", verb: e.assetKind === "audio" ? "open" : "view", archived: archived(e.project),
          meta: [KIND_WORD[e.assetKind], e.durationMs !== null && e.assetKind !== "image" ? clock(e.durationMs) : null, e.width && e.height ? `${e.width}×${e.height}` : null, when(e.updatedAt), e.folder ? folders.get(e.folder) : place(e.project)].filter(Boolean).join(" · "),
        });
        break;
      case "project":
        out.push({ ...base, kind: "project", group: "Projects & folders", verb: "work in it", archived: e.archived, meta: ["Project", plural(e.timelines, "timeline"), plural(e.items, "item"), size(e.bytes), e.archived ? "archived" : e.id === current ? "working in it" : null].filter(Boolean).join(" · ") });
        break;
      case "folder":
        out.push({ ...base, kind: "folder", group: "Projects & folders", verb: "open", archived: archived(e.project), meta: ["Folder", place(e.project), plural(e.items, "item"), e.linked && "on your disk"].filter(Boolean).join(" · ") });
        break;
    }
  }
  return out;
}

/** The commands as they are offered before their figures: their names found like anything else. */
export const templateItems = (): Item[] =>
  COMMANDS.map((c) => ({ key: `cmd:${c.id}`, kind: "command" as const, label: c.name, meta: `${c.what} · ${c.example}`, group: "Commands" as const, verb: c.needs ? "complete" : "run", p: prepare(`${c.name} ${c.typed}`), complete: c.needs ? `> ${c.typed}` : undefined }));

/** The settings, each with its page and, for a switch or a choice, its value now. */
export const settingItems = (list: readonly SettingEntry[], ctx: SettingCtx): Item[] =>
  list.map((s) => {
    const value = valueSaid(s, ctx);
    return {
      key: `set:${s.id}`, kind: "setting" as const, label: s.label, group: "Settings" as const, setting: s, p: prepare(`${s.label} ${s.words ?? ""}`),
      meta: [`Settings › ${pageLabel(s.page)}`, s.kind === "choice" && value, s.scope === "this browser" && "this browser"].filter(Boolean).join(" · "),
      verb: s.kind === "switch" ? "switch" : s.kind === "choice" ? "next" : "open",
    };
  });

/** The order the sections come in when nothing ranks them (nothing typed). */
export const GROUP_ORDER: Group[] = ["Recent", "Suggested", "Calculator", "Commands", "Timelines", "Renders", "Drafts", "Projects & folders", "Queue", "Settings", "Prompt history", "Cast"];

/**
 * Rows in sections, as many as `limit`: the section of the best row first, then the others as their best
 * row ranks; within a section, the rank order.
 */
export function grouped(rows: readonly Item[], limit = 50): Array<{ group: Group; rows: Item[] }> {
  const out: Array<{ group: Group; rows: Item[] }> = [];
  for (const r of rows.slice(0, limit)) {
    let g = out.find((x) => x.group === r.group);
    if (!g) out.push((g = { group: r.group, rows: [] }));
    g.rows.push(r);
  }
  return out;
}
