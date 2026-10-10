import type { CommandEntry, Entity, Job, PromptHistoryItem, QueueStatus, RecipeInfo, RunningJob } from "../api";
import { aboutMs, clock, plural, size, timeLeft, when } from "../format";
import { calc, type CalcCard, type Grid } from "./calc";
import { commandRow, liveRow, QUEUE_BULK, type CommandCtx } from "./commandRows";
import { highlight, prepare, search, type Prepared } from "./match";
import type { Command, CommandId, Mode } from "./parse";
import type { KeyHit } from "../keys/grammar";
import { allRows, keysOfRow, searchKeys, type Found, type KeysAsk } from "../keys/search";
import { rowKeys, type PlaceId } from "../keys/table";
import { pageLabel, type SettingCtx, type SettingEntry, valueSaid } from "./settingsRegistry";
import { bonus, recentKeys, type Ranks } from "./rank";

/** What one row of the bar is, the sections it falls in, and how each kind is said. */

export type Kind = "timeline" | "render" | "draft" | "project" | "folder" | "command" | "setting" | "job" | "calc" | "history" | "person" | "workflow" | "kit" | "nav" | "key";
type Group = "Recent" | "Suggested" | "Timelines" | "Renders" | "Drafts" | "Projects & folders" | "Workflows" | "Prompt kit" | "Go to" | "Commands" | "Settings" | "Queue" | "Calculator" | "Prompt history" | "Cast" | "Keys";

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
  /** A place of the app to go to: an address, an event the app listens for (the Projects panel, the keys sheet), or the bin. */
  nav?: Nav;
  /** In an archived project, or in the bin: listed after the others. */
  archived?: boolean;
  /** The Inbox, worked in like a project (what is in none): its row in `#`. */
  inbox?: true;
  /** The key that does the same in the app (from the key table), drawn on the row's right. */
  keys?: string;
  /** A row of the key table (`?`): Enter opens the sheet on it; `hits` are the caps a key search lit. */
  keyRow?: KeysAsk & { hits?: KeyHit[] };
}

/** Where a row of "Go to" leads: an address, an event the app listens for, or the Studio's bin (every project's). */
type Nav = { href: string } | { event: string } | { bin: true };


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

/**
 * Every entry of the index as a row: its words, its detail line, its project said by name. `inboxItems`: how many items are
 * in no project, as the server counted them (the index holds only some of the library's items); left out, those of `entries`.
 */
export function indexItems(entries: readonly CommandEntry[], recipes: readonly RecipeInfo[], current: string | null, inboxItems?: number): Item[] {
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
        // in the bin: found by its name, after the rest, and said so first (its Tab list puts it back)
        out.push({
          ...base, key: `render:${e.id}`, kind: "render", group: "Renders", verb: e.assetKind === "audio" ? "open" : "view", archived: archived(e.project) || Boolean(e.inBin),
          meta: [e.inBin && "In the bin", KIND_WORD[e.assetKind], e.durationMs !== null && e.assetKind !== "image" ? clock(e.durationMs) : null, e.width && e.height ? `${e.width}×${e.height}` : null, when(e.updatedAt), e.folder ? folders.get(e.folder) : place(e.project)].filter(Boolean).join(" · "),
        });
        break;
      case "project":
        out.push({ ...base, kind: "project", group: "Projects & folders", verb: e.archived ? "unarchive" : "work in it", archived: e.archived, meta: ["Project", plural(e.timelines, "timeline"), plural(e.items, "item"), size(e.bytes), e.archived ? "archived" : e.id === current ? "working in it" : null].filter(Boolean).join(" · ") });
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
  // the Inbox, as the Projects panel lists it beside the projects: worked in from `#` like one of them
  const loose = (kind: CommandEntry["kind"]) => entries.filter((e) => e.kind === kind && "project" in e && e.project === null && !(e.kind === "asset" && e.inBin)).length;
  out.push({
    key: "project:inbox", kind: "project", inbox: true, label: "Inbox", group: "Projects & folders", verb: "work in it", p: prepare("Inbox"),
    meta: ["Out of every project", plural(loose("timeline"), "timeline"), plural(inboxItems ?? loose("asset"), "item"), current === "none" ? "working in it" : null].filter(Boolean).join(" · "),
  });
  return out;
}

/** The render keys ("render:<id>") the bar learned, newest first: the library's items it asks the index to hold. */
export const usedItems = (ranks: Ranks, max = 100): string[] =>
  recentKeys(ranks, Infinity).filter((k) => k.startsWith("render:")).slice(0, max).map((k) => k.slice(7));

/**
 * The index's entries with the library's items found for what is typed, and those picked in the bar since the index was
 * read: each once, the latest read of it kept (a found item may have been renamed or binned since the index was read).
 */
export function withItems(entries: readonly CommandEntry[], ...more: ReadonlyArray<readonly CommandEntry[]>): CommandEntry[] {
  if (!more.some((m) => m.length)) return entries as CommandEntry[];
  const fresh = new Map<string, CommandEntry>();
  for (const list of more) for (const e of list) if (e.kind === "asset") fresh.set(e.id, e);
  const out = entries.map((e) => (e.kind === "asset" && fresh.has(e.id) ? fresh.get(e.id)! : e));
  const held = new Set(entries.flatMap((e) => (e.kind === "asset" ? [e.id] : [])));
  for (const e of fresh.values()) if (!held.has(e.id)) out.push(e);
  return out;
}

/**
 * Drafts of one name among the rows shown (two "1girl, terrace, red dress…" in Recent): their detail line then leads with
 * what tells them apart. A draft with a name of its own shows the start of its prompt, every one when it was started and
 * last changed; the rest of the line (its model, its renders) follows. Other rows, and drafts of a name of their own, are
 * left as they are.
 */
function tellApart<T extends Item>(rows: readonly T[]): T[] {
  const seen = new Map<string, number>();
  const key = (r: Item) => r.label.trim().toLowerCase();
  for (const r of rows) if (r.entry?.kind === "draft") seen.set(key(r), (seen.get(key(r)) ?? 0) + 1);
  return rows.map((r) => {
    const e = r.entry;
    if (e?.kind !== "draft" || (seen.get(key(r)) ?? 0) < 2) return r;
    const prompt = e.prompt ? `“${e.prompt.length > 48 ? `${e.prompt.slice(0, 47).trimEnd()}…` : e.prompt}”` : null;
    const started = e.createdAt && e.createdAt !== e.updatedAt ? `started ${when(e.createdAt)}` : null;
    return { ...r, meta: ["Draft", prompt, `changed ${when(e.updatedAt)}`, started, r.meta.replace(/^Draft · /, "").replace(` · ${when(e.updatedAt)}`, "")].filter(Boolean).join(" · ") };
  });
}

/** The places of the app the bar goes to: its screens, each tab of Settings, the Queue's views, the Projects panel and the keys sheet. */
export function navItems(tabs: ReadonlyArray<{ id: string; label: string; href: string }>): Item[] {
  const go = (key: string, label: string, meta: string, nav: Nav, words = ""): Item =>
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
    go("bin", "Go to Bin", "What was moved to the bin, every project's: each is erased a week after it was binned", { bin: true }, "trash deleted put back restore"),
    go("projects", "Open Projects", "The Projects panel: projects, folders, timelines, drafts", { event: "afflatus:projects" }, "tree panel"),
    { ...go("keys", "Keyboard shortcuts", "Every key, by screen", { event: "afflatus:keys" }, "keys hotkeys help ?"), keys: rowKeys("keys") },
  ];
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

/**
 * An action's label inside a sentence of the footer ("Ctrl+Enter show in Projects"): its first letter lowered, the rest
 * as it is written, and left whole when its first word is a name with capitals of its own (ComfyUI, CFG, PNG).
 */
export function lowerFirst(label: string): string {
  const word = /^\S+/.exec(label)?.[0] ?? "";
  return /[A-Z]/.test(word.slice(1)) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * Rows in sections, as many as `limit`: the section of the best row first, then the others as their best
 * row ranks; within a section, the rank order.
 */
function grouped(rows: readonly Item[], limit = 50): Array<{ group: Group; rows: Item[] }> {
  const out: Array<{ group: Group; rows: Item[] }> = [];
  for (const r of rows.slice(0, limit)) {
    let g = out.find((x) => x.group === r.group);
    if (!g) out.push((g = { group: r.group, rows: [] }));
    g.rows.push(r);
  }
  // drafts of one name found together are told apart, as in Recent
  return out.map((g) => ({ ...g, rows: tellApart(g.rows) }));
}

/** How many rows the bar shows at most. */
const LIMIT = 50;

/** A row with the parts of its label that matched what is typed, lit. */
type Shown = Item & { ranges?: Array<[number, number]> };
export type Section = { group: string; rows: Shown[] };

/** What the rows of the bar are made of: the index read into rows, the commands and settings offered, and the moment. */
export interface RowsData {
  /** What is typed after the mode's character. */
  text: string;
  /** The index's entries as rows (indexItems), and by key. */
  base: readonly Item[];
  byKey: ReadonlyMap<string, Item>;
  /** The commands as offered now (commandTemplates). */
  templates: readonly Item[];
  settingRows: readonly Item[];
  navRows: readonly Item[];
  command: CommandCtx;
  /** Whether the bar learns from what is chosen (off: nothing ranks by it, Recent lists what changed last). */
  learn: boolean;
  ranks: Ranks;
  now: number;
  /** The command read from what is typed in the `>` mode, and its render estimate said. */
  parsed: Command | null;
  estimateSaid: string;
  recipes: readonly RecipeInfo[];
  recipeItems: ReadonlyArray<{ r: RecipeInfo; p: Prepared }>;
  presetItems: ReadonlyArray<{ e: Extract<Entity, { kind: "preset" }>; p: Prepared }>;
  /** Whether a model family is turned on: a new draft is offered only on those. */
  familyOn(family: string): boolean;
  /** The calculator's grid. */
  grid: Grid;
  /** The queue in full, in the `!` mode. */
  queue: QueueStatus | null;
  history: readonly PromptHistoryItem[];
  keysHere: readonly PlaceId[];
  barKey: string;
  entities: readonly Entity[];
  /** Where `@name` puts a person, said ("→ the open draft"). */
  castTo: string;
}

// searching everything, a command or a setting comes after a timeline, a draft or a render that matches as well
// (and a timeline, a draft or a project before the renders of the same name: "Harbor walk" the timeline before its takes)
const KIND_NUDGE: Partial<Record<Kind, number>> = { timeline: 25, draft: 15, project: 15, folder: 10, command: -60, nav: -40 };

/** The bar's rows in their sections for one mode: what it lists for what is typed. */
export function rowsFor(mode: Mode, d: RowsData): Section[] {
  const q = d.text;
  const { base, byKey, templates, settingRows, navRows, learn, ranks, now, parsed } = d;
  const { aim, queue: queueNow, editorUndo, bannerUndo, binEmpty } = d.command;
  const cmd = (c: Command, recipe?: RecipeInfo, preset?: Extract<Entity, { kind: "preset" }>) => commandRow(d.command, c, recipe, preset);
  const live = (id: CommandId) => liveRow(d.command, id);
  const learned = (it: Item) => (learn ? bonus(ranks[it.key], now) : 0) - (it.archived ? 400 : 0);
  const everything = (it: Item) => learned(it) + (it.kind === "setting" ? (it.setting?.kind === "page" ? -160 : -90) : KIND_NUDGE[it.kind] ?? 0);
  // the accent on the label itself (a row may have been found by its other words: then nothing is lit)
  const withRanges = (rows: Item[], typed: string): Shown[] => rows.map((r) => ({ ...r, ranges: highlight(prepare(r.label), typed.trim().toLowerCase()) }));
  switch (mode) {
    case "all": {
      if (!q) {
        const recent: Item[] = [];
        // pausing a paused queue, resuming a running one, or undoing with nothing to undo does nothing: Recent leaves it out until it would
        const idle = (k: string) => (k === "cmd:pause" && queueNow?.paused) || (k === "cmd:resume" && queueNow && !queueNow.paused) || (k === "cmd:undo" && !(aim?.open ? editorUndo : bannerUndo)) || ((k === "cmd:empty-bin" || k === "cmd:put-back-all") && binEmpty);
        if (learn) for (const k of recentKeys(ranks, 12)) {
          const it = byKey.get(k) ?? templates.find((t) => t.key === k) ?? settingRows.find((s) => s.key === k);
          if (it && !it.archived && !it.complete && !idle(k)) recent.push(it);
          if (recent.length >= 6) break;
        }
        // nothing learned yet: what was changed last
        if (recent.length < 4) {
          const latest = base.filter((i) => (i.kind === "timeline" || i.kind === "draft" || i.kind === "render") && !i.archived && !recent.includes(i)).sort((a, b) => (b.entry!.updatedAt > a.entry!.updatedAt ? 1 : -1));
          recent.push(...latest.slice(0, 6 - recent.length));
        }
        const suggested: Item[] = [];
        const qd = queueNow;
        if (qd?.paused) suggested.push(cmd({ cmd: "resume" }));
        else if (qd?.running || qd?.waiting) suggested.push(cmd({ cmd: "pause" }));
        if (aim?.entry?.unusedTakes) suggested.push(cmd({ cmd: "bin-unused" }));
        if (qd && !qd.online) suggested.push(cmd({ cmd: "reconnect" }));
        // a clip selected in the open editor: what its keys do to it
        suggested.push(...live("split"), ...live("previous-take"), ...live("next-take"), ...live("group-queue"));
        const failed = qd?.failed ?? 0;
        if (failed) {
          const label = `${failed} failed in the queue`;
          suggested.push({ key: "suggest:queue", kind: "job", label, meta: "Type ! to see them, Tab on one to retry", group: "Suggested", verb: "show", p: prepare(label), complete: "!" });
        }
        return [
          // two drafts of one name: their detail lines say what tells them apart
          { group: "Recent", rows: tellApart(recent.map((r) => ({ ...r, group: "Recent" as const }))) },
          // a suggestion already in Recent is not said twice
          ...(suggested.some((r) => !recent.some((x) => x.key === r.key)) ? [{ group: "Suggested", rows: suggested.filter((r) => !recent.some((x) => x.key === r.key)).map((r) => ({ ...r, group: "Suggested" as const })) }] : []),
        ].filter((s) => s.rows.length);
      }
      const found = search([...base, ...templates, ...navRows, ...settingRows], q, LIMIT, everything).map((x) => x.item);
      return grouped(withRanges(found, q), LIMIT);
    }
    case "command": {
      const rows: Item[] = [];
      if (parsed?.cmd === "load" || parsed?.cmd === "new-draft") {
        const word = parsed.cmd === "load" ? parsed.model : parsed.recipe;
        const pool = d.recipeItems.filter((x) => parsed.cmd === "load" || d.familyOn(x.r.family));
        const hits = search(pool, word, 6).map((x) => x.item.r);
        if (hits.length) for (const r of hits) rows.push(cmd(parsed, r));
        else rows.push(cmd(parsed));
      } else if (parsed?.cmd === "preset") {
        // the presets the words name, as the models of `load`
        const hits = search(d.presetItems, parsed.name, 6).map((x) => x.item.e);
        if (hits.length) for (const p of hits) rows.push(cmd(parsed, undefined, p));
        else rows.push(cmd(parsed));
      } else if (parsed) rows.push({ ...cmd(parsed), meta: [cmd(parsed).meta, d.estimateSaid].filter(Boolean).join(" · ") });
      const named = q ? search(templates, q.split(/\s+\d/)[0]!, LIMIT, learned).map((x) => x.item) : templates;
      const rest = named.filter((t) => !parsed || t.key !== `cmd:${parsed.cmd}`);
      // the places to go to, after the commands: `> settings` finds Settings too
      const places = q && !parsed ? search(navRows, q, 12, learned).map((x) => x.item) : [];
      return [{ group: "Commands", rows: withRanges([...rows, ...rest], parsed ? "" : q) }, { group: "Go to", rows: withRanges(places, q) }].filter((s) => s.rows.length);
    }
    case "place": {
      const places = base.filter((i) => i.kind === "project" || i.kind === "folder");
      const found = q ? search(places, q, LIMIT, learned).map((x) => x.item) : [...places].sort((a, b) => learned(b) - learned(a) || Number(a.kind === "folder") - Number(b.kind === "folder") || a.label.localeCompare(b.label)).slice(0, LIMIT);
      return grouped(withRanges(found, q), LIMIT);
    }
    case "setting": {
      const found = q ? search(settingRows, q, LIMIT, learned).map((x) => x.item) : settingRows.filter((s) => s.setting?.kind !== "page");
      return [{ group: "Settings", rows: withRanges(found, q) }].filter((s) => s.rows.length);
    }
    case "calc": {
      const cards = calc(q, d.grid) ?? [];
      return [{ group: "Calculator", rows: cards.map((c, i) => ({ key: `calc:${i}`, kind: "calc" as const, label: c.value, meta: `${c.label} · ${c.note}`, group: "Calculator" as const, verb: "copy", p: prepare(c.value), card: c })) }].filter((s) => s.rows.length);
    }
    case "queue": {
      const qd = d.queue;
      const jobs: Item[] = [];
      if (qd?.running) jobs.push({ key: `job:${qd.running.id}`, kind: "job", label: qd.running.label, group: "Queue", verb: "open", p: prepare(qd.running.label), job: { job: qd.running, state: "running" }, meta: `running · ${qd.running.steps ? `step ${qd.running.step} of ${qd.running.steps}` : `${Math.round(qd.running.progress * 100)} %`}${qd.running.eta ? ` · ${timeLeft(qd.running.eta)}` : ""}` });
      qd?.waiting.forEach((w, i) => jobs.push({ key: `job:${w.id}`, kind: "job", label: w.label, group: "Queue", verb: "open", p: prepare(w.label), job: { job: w, state: "waiting", position: i + 1 }, meta: `waiting · ${i === 0 ? "next" : `${i + 1}${["st", "nd", "rd"][i] ?? "th"}`}${w.estimateMs ? ` · ${aboutMs(w.estimateMs)}` : ""} · Tab → to the top` }));
      for (const f of qd?.recent.filter((j) => j.status === "failed") ?? []) jobs.push({ key: `job:${f.id}`, kind: "job", label: f.label, group: "Queue", verb: "open", p: prepare(f.label), job: { job: f, state: "failed" }, meta: `failed${f.finishedAt ? ` ${new Date(f.finishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}${f.error ? ` · ${f.error.slice(0, 80)}` : ""} · Ctrl+Enter retries` });
      const found = q ? search(jobs, q, LIMIT).map((x) => x.item) : jobs;
      // what is done to the whole queue, after its jobs (Enter on the first row opens one, never cancels them all)
      const bulk = QUEUE_BULK.flatMap(live);
      const bulkFound = q ? search(bulk, q, LIMIT).map((x) => x.item) : bulk;
      return [{ group: "Queue", rows: withRanges(found, q) }, { group: "Commands", rows: withRanges(bulkFound, q) }].filter((s) => s.rows.length);
    }
    case "history": {
      const rows = d.history.map((h, i): Item => ({ key: `history:${i}:${h.createdAt}`, kind: "history", label: h.prompt.replace(/\s+/g, " ").slice(0, 140), meta: `${d.recipes.find((r) => r.id === h.recipe)?.title ?? h.recipe} · ${when(h.createdAt)}`, group: "Prompt history", verb: "use", p: prepare(h.prompt.slice(0, 140)), history: h }));
      return [{ group: "Prompt history", rows: withRanges(rows, q) }].filter((s) => s.rows.length);
    }
    case "keys": {
      // the sheet's own search over the key table: the same rows in the same order; with nothing typed, every row
      const found = q ? searchKeys(q, d.keysHere, d.barKey) : null;
      if (!found) return [{ group: "Keys", rows: keyItems(allRows(d.keysHere), d.barKey) }];
      const kq = found.kq;
      return [
        { group: kq ? `The ${kq.exact.length > 1 ? "keys" : "key"} ${kq.exact.join("+")}` : "Keys", rows: keyItems(found.keys, d.barKey) },
        { group: "Words", rows: keyItems(found.said, d.barKey) },
      ].filter((s) => s.rows.length);
    }
    case "cast": {
      // where `@name` puts the person: the clip selected in the timeline editor, else the open draft
      const people = d.entities.filter((e): e is Extract<Entity, { kind: "person" }> => e.kind === "person").map((p): Item => ({ key: `person:${p.id}`, kind: "person", label: p.name, meta: `Prompt kit · ${p.def.pictures.length} picture${p.def.pictures.length === 1 ? "" : "s"} ${d.castTo}`, group: "Cast", verb: "add", p: prepare(p.name), person: p }));
      const found = q ? search(people, q, LIMIT, learned).map((x) => x.item) : people.slice(0, LIMIT);
      return [{ group: "Cast", rows: withRanges(found, q) }].filter((s) => s.rows.length);
    }
  }
}
