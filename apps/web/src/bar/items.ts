import type { CommandEntry, Entity, Job, PromptHistoryItem, RecipeInfo, RunningJob } from "../api";
import { clock, size, when } from "../format";
import type { CalcCard } from "./calc";
import { prepare, type Prepared } from "./match";
import { COMMANDS, type Command, type CommandId } from "./parse";
import { keysOfRow, type Found, type KeysAsk } from "../keys/search";
import { rowKeys, type RowId } from "../keys/table";
import { pageLabel, type SettingCtx, type SettingEntry, valueSaid } from "./settingsRegistry";

/** What one row of the bar is, the sections it falls in, and how each kind is said. */

export type Kind = "timeline" | "render" | "draft" | "project" | "folder" | "command" | "setting" | "job" | "calc" | "history" | "person" | "workflow" | "kit" | "nav" | "key";
export type Group = "Recent" | "Suggested" | "Timelines" | "Renders" | "Drafts" | "Projects & folders" | "Workflows" | "Prompt kit" | "Go to" | "Commands" | "Settings" | "Queue" | "Calculator" | "Prompt history" | "Cast" | "Keys";

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
  /** A preset a command applies (`> preset night`). */
  preset?: Extract<Entity, { kind: "preset" }>;
  /** A place of the app to go to: an address, or an event the app listens for (the Projects panel, the keys sheet). */
  nav?: { href: string } | { event: string };
  /** In an archived project: listed after the others. */
  archived?: boolean;
  /** The key that does the same in the app (from the key table), drawn on the row's right. */
  keys?: string;
  /** A row of the key table (`?`): Enter opens the sheet on it; `hits` are the caps a key search lit. */
  keyRow?: KeysAsk & { hits?: string[] };
}

export const GROUP_OF: Record<Kind, Group> = {
  timeline: "Timelines", render: "Renders", draft: "Drafts", project: "Projects & folders", folder: "Projects & folders",
  command: "Commands", setting: "Settings", job: "Queue", calc: "Calculator", history: "Prompt history", person: "Cast",
  workflow: "Workflows", kit: "Prompt kit", nav: "Go to", key: "Keys",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const KIND_WORD = { image: "Image", video: "Video", audio: "Sound" } as const;
const KIT_WORD = { person: "Person", place: "Place", style: "Style", preset: "Preset", snippet: "Snippet" } as const;

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
      case "workflow":
        out.push({ ...base, kind: "workflow", group: "Workflows", verb: "try it", meta: ["Workflow", KIND_WORD[e.output], e.problem ? "cannot be built as mapped" : null, e.updatedAt ? when(e.updatedAt) : null].filter(Boolean).join(" · ") });
        break;
      case "kit":
        out.push({ ...base, kind: "kit", group: "Prompt kit", verb: "open", meta: ["Prompt kit", KIT_WORD[e.entity], e.shipped ? "built in" : null].filter(Boolean).join(" · ") });
        break;
    }
  }
  return out;
}

/** The places of the app the bar goes to: its screens, each tab of Settings, the Queue's views, the Projects panel and the keys sheet. */
export function navItems(tabs: ReadonlyArray<{ id: string; label: string; href: string }>): Item[] {
  const go = (key: string, label: string, meta: string, nav: { href: string } | { event: string }, words = ""): Item =>
    ({ key: `nav:${key}`, kind: "nav", label, meta, group: "Go to", verb: "go", p: prepare(`${label.replace(/^Go to /, "")} ${words} go to`), nav });
  return [
    go("studio", "Go to Studio", "The library and the form", { href: "/" }, "library create home"),
    go("timelines", "Go to Timelines", "Every timeline of the project you work in", { href: "/timelines" }, "videos edit"),
    go("kit", "Go to Prompt kit", "People, places, styles, presets, snippets", { href: "/kit" }, "people cast"),
    go("workflows", "Go to Workflows", "The models and the ComfyUI workflows you imported", { href: "/workflows" }, "comfyui models"),
    go("queue", "Go to Queue", "What runs, waits and failed", { href: "/queue" }, "jobs"),
    go("settings", "Go to Settings", "ComfyUI, models, the interface…", { href: "/settings" }, "preferences options"),
    ...tabs.map((t) => go(`settings.${t.id}`, `Settings › ${t.label}`, "A tab of Settings", { href: t.href }, "settings preferences")),
    go("queue.times", "Queue › Render times", "How long renders took, by model and by day", { href: "/queue?view=times" }, "stats speed history"),
    go("queue.log", "Queue › ComfyUI log", "ComfyUI's terminal, live", { href: "/queue?view=log" }, "console terminal errors"),
    go("projects", "Open Projects", "The Projects panel: projects, folders, timelines, drafts", { event: "afflatus:projects" }, "tree panel"),
    { ...go("keys", "Keyboard shortcuts", "Every key, by screen", { event: "afflatus:keys" }, "keys hotkeys help ?"), keys: rowKeys("keys") },
  ];
}

/**
 * The key table's row that does what a command does, when pressing it does that in the place the command acts on:
 * split and the takes in the timeline editor (a clip selected), Generate in the Studio's form. Read from the table,
 * never a second copy of a chord; `half` is one chord of a pair (Alt+[ for the previous take, Alt+] for the next).
 */
export const COMMAND_KEYS: Partial<Record<CommandId, { row: RowId; half?: 0 | 1 }>> = {
  split: { row: "split" },
  "previous-take": { row: "take", half: 0 },
  "next-take": { row: "take", half: 1 },
  generate: { row: "generate" },
};

/**
 * A command's key, said on its row. Rendering clips by number has one only when the number is the clip selected in the
 * open editor: Ctrl+Enter there renders that clip, and no other.
 */
export function commandKeys(c: Command | { cmd: CommandId }, selected?: { timeline: string; number: number } | null, aim?: string | null): string | undefined {
  if (c.cmd === "render-clips" && "clips" in c) {
    return selected && aim === selected.timeline && c.clips.length === 1 && c.clips[0] === selected.number ? rowKeys("render-clip") : undefined;
  }
  const at = COMMAND_KEYS[c.cmd];
  return at ? rowKeys(at.row, at.half) : undefined;
}

/** The key table's rows as rows of the bar's `?` mode: what it does, its place, its keys. */
export const keyItems = (found: readonly Found[], barKey: string): Item[] =>
  found.map((f) => {
    const where = `${f.place.name}${f.group.kind ? ` · ${f.group.kind}` : ""}`;
    return {
      key: `key:${f.id}`, kind: "key" as const, label: f.row.does, group: "Keys" as const, verb: "show in the sheet", p: prepare(f.row.does),
      meta: [where, f.here && "here now", f.row.note].filter(Boolean).join(" · "),
      keys: keysOfRow(f.row, barKey), keyRow: { place: f.place.id, row: f.id, hits: f.hits },
    };
  });

/** The commands as they are offered before their figures: their names found like anything else. */
export const templateItems = (): Item[] =>
  COMMANDS.map((c) => ({ key: `cmd:${c.id}`, kind: "command" as const, label: c.name, meta: `${c.what} · ${c.example}`, group: "Commands" as const, verb: c.needs ? "complete" : "run", p: prepare(`${c.name} ${c.typed}`), complete: c.needs ? `> ${c.typed}` : undefined, keys: commandKeys({ cmd: c.id }) }));

/** The settings, each with its page and, for a switch or a choice, its value now. */
export const settingItems = (list: readonly SettingEntry[], ctx: SettingCtx): Item[] =>
  list.map((s) => {
    const value = valueSaid(s, ctx);
    return {
      key: `set:${s.id}`, kind: "setting" as const, label: s.label, group: "Settings" as const, setting: s, p: prepare(`${s.label} ${s.words ?? ""}`),
      meta: [`Settings › ${pageLabel(s.page)}`, s.kind === "choice" && value, s.scope === "this browser" && "this browser"].filter(Boolean).join(" · "),
      verb: s.kind === "switch" ? "switch" : s.kind === "choice" ? "next" : s.kind === "action" ? s.verb ?? "run" : "open",
    };
  });

/** The order the sections come in when nothing ranks them (nothing typed). */
export const GROUP_ORDER: Group[] = ["Recent", "Suggested", "Calculator", "Keys", "Commands", "Go to", "Timelines", "Renders", "Drafts", "Projects & folders", "Workflows", "Prompt kit", "Queue", "Settings", "Prompt history", "Cast"];

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
