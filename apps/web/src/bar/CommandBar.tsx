import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Bookmark, Calculator, ChevronRight, Film, Folder, FolderKanban, Image as ImageIcon, Keyboard, ListOrdered, MapPin, Music, Navigation, PenLine, Puzzle, Quote, Search, SlidersHorizontal, Sparkles, User, Video, Workflow, Zap,
} from "lucide-react";
import { api, type Entity, type RecipeInfo, type Settings } from "../api";
import { useAsset, useEntities, useFamilies, useRecipes, useSettings } from "../data";
import { groupingSaves } from "../screens/queue/bulk";
import { stepRateSaid, useStepRate } from "../screens/queue/stepRate";
import { useQueueOf } from "../screens/studio/queueOf";
import { aboutMs, timeLeft, when } from "../format";
import { useProject } from "../project";
import { useExplain, useHoverPlay, useNotify } from "../store";
import { useThemeChoice } from "../theme/store";
import { cx } from "../ui";
import { Keys } from "../Keys";
import { allRows, opened, searchKeys } from "../keys/search";
import { BAR_DEFAULT } from "../keys/table";
import { calc, type Grid } from "./calc";
import { commandKeys, grouped, indexItems, keyItems, navItems, settingItems, tellApart, templateItems, type Item, type Kind } from "./items";
import { settingHref, TABS, tabHref } from "../screens/settings/settingsIndex";
import { highlight, pieces, prepare, search } from "./match";
import { COMMANDS, KIT_OF, modeOf, parseCommand, type Command, type CommandId, type KitNew, type Mode } from "./parse";
import { Preview } from "./Preview";
import { bonus, bumped, load, recentKeys, renamed, save, type Ranks } from "./rank";
import { PAGES, SETTINGS, settingKeyNow, type SettingCtx } from "./settingsRegistry";
import { useSelectedClip } from "./bridge";
import { castPlace } from "./castTo";
import { BAR_INDEX, useBar } from "./store";
import { useBarActions, type Action, type TimelineAim } from "./useActions";

/** How many rows the bar shows at most. */
const LIMIT = 50;
/** How long a row stays selected before its preview is drawn: arrowing fast loads nothing. */
const DWELL_MS = 80;

const MODE_WORD: Partial<Record<Mode, string>> = { command: "commands", place: "projects & folders", setting: "settings", calc: "calculator", queue: "queue", keys: "keys", history: "prompt history", cast: "cast" };
const MODE_TONE: Record<Mode, string> = { all: "text-accent", command: "text-warn-ink", place: "text-accent", setting: "text-ink-2", calc: "text-good", queue: "text-good", keys: "text-ink-2", history: "text-ink-2", cast: "text-accent" };

/** Each kind's icon and the colour of its tile. */
const TONE: Record<Kind, string> = {
  timeline: "text-warn", render: "text-picture", draft: "text-accent", project: "text-accent", folder: "text-picture", command: "text-warn-ink",
  setting: "text-ink-2", job: "text-good", calc: "text-good", history: "text-ink-2", person: "text-accent",
  workflow: "text-picture", kit: "text-accent", nav: "text-ink-2", key: "text-ink-2",
};
const KIT_ICON = { person: User, place: MapPin, style: Sparkles, preset: Bookmark, snippet: Puzzle } as const;
function iconOf(it: Item): ReactNode {
  const s = 16;
  switch (it.kind) {
    case "timeline": return <Film size={s} />;
    case "render": return it.entry?.kind === "asset" && it.entry.assetKind === "video" ? <Video size={s} /> : it.entry?.kind === "asset" && it.entry.assetKind === "audio" ? <Music size={s} /> : <ImageIcon size={s} />;
    case "draft": return <PenLine size={s} />;
    case "project": return <FolderKanban size={s} />;
    case "folder": return <Folder size={s} />;
    case "command": return <Zap size={s} />;
    case "setting": return <SlidersHorizontal size={s} />;
    case "job": return <ListOrdered size={s} />;
    case "calc": return <Calculator size={s} />;
    case "history": return <Quote size={s} />;
    case "person": return <User size={s} />;
    case "workflow": return <Workflow size={s} />;
    case "kit": {
      const Icon = KIT_ICON[it.entry?.kind === "kit" ? it.entry.entity : "person"];
      return <Icon size={s} />;
    }
    case "nav": return <Navigation size={s} />;
    case "key": return <Keyboard size={s} />;
  }
}

/** The modes the footer lists, by their first character, with the sheet's names for them. */
const FOOTER_MODES: Array<[string, string]> = [[">", "commands"], ["#", "places"], ["/", "settings"], ["=", "calc"], ["!", "queue"], ["?", "keys"]];
/**
 * The parts of the bar that are off until turned on, listed dimmed in the footer while they are off: a power user finds
 * the `"` and `@` modes (and `;` snippets in prompt boxes) there, and a click opens their row in Settings › Command bar.
 */
const OFF_PARTS: Array<["history" | "cast" | "snippets", string, string]> = [["history", '"', "history"], ["cast", "@", "cast"], ["snippets", ";", "snippets"]];

/** The calculator's grid: the model in play's (the open draft's, else the first one that makes video on a grid), H3's figures when none is known. */
function gridOf(recipes: RecipeInfo[], prefer: string | undefined): Grid {
  const video = recipes.filter((r) => r.traits?.frameGrid);
  const r = video.find((x) => x.id === prefer) ?? video.find((x) => x.family === "h3") ?? video[0];
  const sizeInput = r?.inputs.find((i) => i.type === "size");
  return {
    name: r ? r.family.toUpperCase() : "H3",
    fps: r?.traits?.fps ?? 24,
    frames: r?.traits?.frameGrid ?? { step: 17, offset: 5 },
    size: sizeInput && sizeInput.type === "size" ? sizeInput.grid : 32,
  };
}

/** What this browser learned, with the keys of results that were renamed since carried over. */
const loadRanks = () => renamed(load(), settingKeyNow);

/** The commands offered only where they apply: a clip selected in the open editor, jobs waiting, failures, loads to save. */
const LIVE: CommandId[] = ["split", "previous-take", "next-take", "cancel-waiting", "retry-failed", "dismiss-failed", "group-queue", "unload"];
const QUEUE_BULK: CommandId[] = ["cancel-waiting", "retry-failed", "dismiss-failed", "group-queue"];

/** The running render's s/it, after its row's detail: its own subscription, so that only it draws again at each step. */
function StepRateSaid({ id }: { id: string }) {
  const rate = useStepRate();
  return rate && rate.id === id ? <> · {stepRateSaid(rate.secondsPerStep)}</> : null;
}

const said = (c: Command): string => c.cmd === "render-clips" ? `${c.clips.length > 1 ? "Render clips" : "Render clip"} ${c.clips.length > 2 && c.clips.at(-1)! - c.clips[0]! === c.clips.length - 1 ? `${c.clips[0]}–${c.clips.at(-1)}` : c.clips.join(", ")}` : "";

/**
 * The command bar: one box over whatever screen is open, that reaches everything Afflatus holds and does
 * (docs/command-bar.md). Mounted once it was first opened and kept: what one of its actions opens (the
 * viewer, a dialog) stays after it closes, and the index stays read.
 */
export function CommandBar() {
  const { open, seed, preview, learn, hide, setPreview } = useBar();
  const [path, go] = useLocation();
  const client = useQueryClient();
  const recipes = useRecipes().data?.recipes ?? [];
  const families = useFamilies();
  const settings = useSettings();
  const entities = useEntities();
  const currentProject = useProject((s) => s.id);
  const index = useQuery({ queryKey: BAR_INDEX, queryFn: ({ signal }) => api.commandIndex({ signal }), staleTime: Infinity });

  const [typed, setTyped] = useState(seed);
  const [sel, setSel] = useState(0);
  /** Tab: the selected result's actions, filtered by what is typed in their place. */
  const [acting, setActing] = useState<{ item: Item; text: string; sel: number } | null>(null);
  const [ranks, setRanks] = useState<Ranks>(loadRanks);
  const [flash, setFlash] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  // opened: what was typed starts afresh (or on the mode asked for), the focus comes here and goes back where it was on closing
  useLayoutEffect(() => {
    if (!open) {
      const back = returnTo.current;
      returnTo.current = null;
      if (back && document.contains(back)) back.focus({ preventScroll: true });
      return;
    }
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTyped(seed);
    setSel(0);
    setActing(null);
    setFlash(null);
    setRanks(loadRanks());
    input.current?.focus({ preventScroll: true });
    // marked old by a live event while closed: read now (the old one shows meanwhile)
    if (index.isStale && !index.isFetching) void index.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const close = hide;

  // a draft made, saved or deleted is not announced by the server: a change of the drafts lists marks the index old too
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const stop = client.getQueryCache().subscribe((e) => {
      // (the workflows likewise: their import and removal send no live event)
      const key = e.query.queryKey;
      if (e.type !== "updated" || e.action.type !== "success" || !((key[0] === "drafts" && key[1] === "list") || key[0] === "workflows")) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => void client.invalidateQueries({ queryKey: BAR_INDEX, refetchType: useBar.getState().open ? "active" : "none" }), 300);
    });
    return () => {
      stop();
      if (t) clearTimeout(t);
    };
  }, [client]);

  const settingCtx: SettingCtx = useMemo(() => ({
    server: settings.data,
    save: async (patch: Partial<Settings>) => {
      const saved = await api.saveSettings(patch as Record<string, unknown>);
      client.setQueryData(["settings"], saved);
    },
  }), [settings.data, client]);
  // the switches kept in this browser: the bar is drawn again when one changes, so that a switch flipped here shows it
  const kept = [useHoverPlay(), useExplain(), useThemeChoice(), useNotify()];
  const bar = settings.data?.bar;
  const selectedClip = useSelectedClip((c) => c.clip);
  const { mode, text } = modeOf(typed, { history: Boolean(bar?.history), cast: Boolean(bar?.cast) });
  // the queue only while open, and in full only in the queue mode (its jobs live): the bar does not draw again
  // at every sampler step for the counts it says elsewhere
  const queueNow = useQueueOf((q) => (open ? { paused: q.paused, online: q.online, rendering: q.running?.kind === "render", running: Boolean(q.running), waiting: q.waiting.length, failed: q.recent.filter((j) => j.status === "failed").length, saves: groupingSaves(q.waiting, q.running) } : null));
  const queueFull = useQueueOf((q) => (open && mode === "queue" ? q : null));

  // the timeline a command acts on: the one open in the editor, else the one last opened from here, else the last changed
  const entries = index.data?.entries ?? [];
  const base = useMemo(() => indexItems(entries, recipes, currentProject), [entries, recipes, currentProject]);
  const byKey = useMemo(() => new Map(base.map((i) => [i.key, i])), [base]);
  const aim: TimelineAim | null = useMemo(() => {
    const open = /^\/timelines\/([^/]+)/.exec(path)?.[1];
    const pick = (id: string | undefined) => {
      const it = id ? byKey.get(`timeline:${id}`) : undefined;
      return it?.entry?.kind === "timeline" ? { id: it.entry.id, name: it.entry.label, entry: it.entry } : null;
    };
    if (open) return pick(open) ?? { id: open, name: "the open timeline" };
    const used = recentKeys(ranks, 50).find((k) => k.startsWith("timeline:"));
    if (used && pick(used.slice(9))) return pick(used.slice(9));
    const last = base.filter((i) => i.kind === "timeline" && !i.archived).sort((a, b) => (b.entry!.updatedAt > a.entry!.updatedAt ? 1 : -1))[0];
    return last ? pick(last.entry!.id) : null;
  }, [path, byKey, ranks, base]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const settingRows = useMemo(() => settingItems([...SETTINGS, ...PAGES], settingCtx), [settingCtx, ...kept]);
  const recipeItems = useMemo(() => recipes.map((r) => ({ r, p: prepare(`${r.family} ${r.title}`) })), [recipes]);
  const presetItems = useMemo(() => (entities.data?.items ?? []).filter((e): e is Extract<Entity, { kind: "preset" }> => e.kind === "preset").map((e) => ({ e, p: prepare(e.name) })), [entities.data]);
  const navRows = useMemo(() => navItems(TABS.map((t) => ({ id: t.id, label: t.label, href: tabHref(t.id) }))), []);
  // the places of the key table open under the bar, read as it opens: the `?` mode lists their rows first, as the sheet does
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const keysHere = useMemo(() => (open ? opened().here : []), [open]);
  const barKey = bar?.shortcut ?? BAR_DEFAULT;

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  /** A command read from what is typed, as a row: its words, what it touches and how many. */
  const commandRow = (c: Command, recipe?: RecipeInfo, preset?: Extract<Entity, { kind: "preset" }>): Item => {
    const t = aim?.name ?? "the open timeline";
    const named = "name" in c ? c.name : "";
    const kitNew = (cmd: KitNew): [string, string] => [`New ${KIT_OF[cmd]} “${named}”`, "In the Prompt kit, opened there"];
    const words: Record<Command["cmd"], [string, string]> = {
      "render-clips": [`${said(c)} of ${t}`, c.cmd === "render-clips" ? `${c.clips.length} clip${c.clips.length > 1 ? "s" : ""} · they go to the end of the queue · Ctrl+Enter: to the top` : ""],
      "render-missing": [`Render missing clips of ${t}`, "Clips with no take yet, or whose join went stale · Ctrl+Enter: at the top of the queue"],
      export: [`Export ${t}`, "The export dialog opens on it"],
      finish: [`Finish ${t}…`, "The Finish dialog: every take upscaled to its final quality"],
      "fix-all": [`Fix all in ${t}`, "What Needs attention lists, mended as its Fix all"],
      generate: ["Generate", "The open draft, as its Generate button"],
      preset: [`Apply ${preset?.name ?? named}`, preset ? `Preset${preset.source === "shipped" ? " · built in" : ""} · on the open draft` : "No preset by that name"],
      "save-preset": [`Save as preset “${named}”`, "The open draft's model, form and cast"],
      unload: ["Unload models", !queueNow?.online ? "ComfyUI is offline" : queueNow.rendering ? "Not while a render runs" : "ComfyUI's models out of memory · the next render loads them again"],
      "new-timeline": [named ? `New timeline “${named}”` : "New timeline", "In the project you work in · opens in the editor"],
      "new-folder": [`New folder “${named}”`, "At the top of the project you work in"],
      "new-person": kitNew("new-person"),
      "new-place": kitNew("new-place"),
      "new-style": kitNew("new-style"),
      "new-preset": kitNew("new-preset"),
      "new-snippet": kitNew("new-snippet"),
      "import-workflow": ["Import workflow…", "The Workflows screen's file picker: .json, PNG or MP4"],
      "view-last": ["View last render", "What the last finished job made, in the viewer"],
      reconnect: ["Reconnect to ComfyUI", queueNow && !queueNow.online ? "ComfyUI is offline · asked again now" : "ComfyUI asked again now: its address, its files, its nodes"],
      seed: [`Seed ${c.cmd === "seed" ? c.value : ""}`, "In the open draft's form"],
      steps: [`Steps ${c.cmd === "steps" ? c.value : ""}`, "In the open draft's form"],
      cfg: [`CFG ${c.cmd === "cfg" ? c.value : ""}`, "In the open draft's form"],
      size: [`Size ${c.cmd === "size" ? `${c.width}×${c.height}` : ""}`, "In the open draft's form"],
      length: [`Length ${c.cmd === "length" ? `${c.seconds} s` : ""}`, "In the open draft's form"],
      load: [`Load ${recipe?.title ?? (c.cmd === "load" ? c.model : "")}`, recipe ? `${recipe.family.toUpperCase()} · its models into ComfyUI, ahead of a render` : "No model by that name"],
      "new-draft": [`New draft on ${recipe?.title ?? (c.cmd === "new-draft" ? c.recipe : "")}`, recipe ? `${recipe.family.toUpperCase()} · opens in the Studio` : "No model by that name"],
      pause: ["Pause queue", queueNow ? `${queueNow.running ? "1 running" : "nothing running"}, ${queueNow.waiting} waiting · what runs finishes` : "What runs finishes; nothing new starts"],
      resume: ["Resume queue", `${queueNow?.waiting ?? 0} waiting`],
      "empty-bin": ["Empty the bin…", "Asked first · cannot be undone"],
      "bin-unused": [`Bin unused takes of ${t}…`, aim?.entry ? (aim.entry.unusedTakes ? `${aim.entry.unusedTakes} take${aim.entry.unusedTakes === 1 ? "" : "s"} · asked first` : "It has none") : "Asked first"],
      "link-folder": [c.cmd === "link-folder" && c.path ? `Link ${c.path}` : "Link a folder of your disk", "Used in place, nothing copied"],
      "new-project": [`New project “${c.cmd === "new-project" ? c.name : ""}”`, "Made, and worked in"],
      // the key that does the same in the editor is drawn on the row's right (from the key table), not said here
      split: [selectedClip ? `Split clip ${selectedClip.number} at playhead` : "Split clip at playhead", selectedClip ? selectedClip.timelineName : "No clip selected in an open timeline"],
      "previous-take": [selectedClip ? `Clip ${selectedClip.number}: previous take` : "Previous take", selectedClip ? selectedClip.timelineName : "No clip selected in an open timeline"],
      "next-take": [selectedClip ? `Clip ${selectedClip.number}: next take` : "Next take", selectedClip ? selectedClip.timelineName : "No clip selected in an open timeline"],
      "cancel-waiting": ["Cancel all waiting…", queueNow?.waiting ? `${queueNow.waiting} waiting · asked first · the running one goes on` : "Nothing waits"],
      "retry-failed": ["Retry all failed", queueNow?.failed ? `${plural(queueNow.failed, "failed job")} · the same jobs, oldest first` : "None failed"],
      "dismiss-failed": ["Dismiss all failed…", queueNow?.failed ? `${plural(queueNow.failed, "failed job")} · off the history, asked first` : "None failed"],
      "group-queue": ["Group by model", queueNow?.saves ? `saves ${plural(queueNow.saves, "load")} · same model together` : "Grouping saves no load"],
    };
    const [label, meta] = words[c.cmd];
    return { key: `cmd:${c.cmd}${recipe ? `:${recipe.id}` : ""}${preset ? `:${preset.id}` : ""}`, kind: "command", label, meta, group: "Commands", verb: "run", p: prepare(label), command: c, recipe, preset, keys: commandKeys(c) };
  };
  const applies = (id: CommandId): boolean =>
    id === "split" || id === "previous-take" || id === "next-take" ? Boolean(selectedClip)
    : id === "cancel-waiting" ? Boolean(queueNow?.waiting)
    : id === "retry-failed" || id === "dismiss-failed" ? Boolean(queueNow?.failed)
    : id === "group-queue" ? Boolean(queueNow?.saves)
    : id === "unload" ? Boolean(queueNow?.online)
    : true;
  /** A command that needs no figures, as a row ready to run (its clip and counts said), when it applies. */
  const liveRow = (id: CommandId): Item[] => (applies(id) ? [commandRow({ cmd: id } as Command)] : []);
  // the commands that depend on the moment are offered with what they act on, and only when they apply; one that needs no
  // figures is ready as it stands (Enter on "Pause queue" pauses it), one that does completes the bar
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const templates = useMemo(() => templateItems().flatMap((t) => {
    const id = t.key.slice(4) as CommandId;
    if (LIVE.includes(id)) return liveRow(id).map((r) => ({ ...r, p: t.p }));
    const ready = t.complete ? null : parseCommand(COMMANDS.find((c) => c.id === id)?.typed ?? "");
    return [ready ? { ...commandRow(ready), p: t.p } : t];
  }), [selectedClip, queueNow, aim]);

  // the render estimate of a render command, learned from this machine's renders (none said when nothing is learned)
  const parsed = mode === "command" ? parseCommand(text) : null;
  const estimateOf = parsed && aim && (parsed.cmd === "render-clips" || parsed.cmd === "render-missing") ? { timeline: aim.id, clips: parsed.cmd === "render-clips" ? parsed.clips : undefined } : null;
  const estimate = useQuery({
    queryKey: ["bar-estimate", estimateOf],
    queryFn: ({ signal }) => api.commandEstimate(estimateOf!, { signal }),
    enabled: Boolean(estimateOf) && open,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  const estimateSaid = estimateOf && estimate.data ? [estimate.data.ms !== null && `${aboutMs(estimate.data.ms)}, learned from ${estimate.data.basis} render${estimate.data.basis === 1 ? "" : "s"}`, estimate.data.ahead ? `after ${estimate.data.ahead} job${estimate.data.ahead === 1 ? "" : "s"}` : "nothing before it"].filter(Boolean).join(" · ") : "";

  // prompt history: asked of the server a moment after the typing stops (it searches every prompt rendered)
  const [historyQ, setHistoryQ] = useState("");
  useEffect(() => {
    if (mode !== "history") return;
    const t = setTimeout(() => setHistoryQ(text), 150);
    return () => clearTimeout(t);
  }, [mode, text]);
  const history = useQuery({ queryKey: ["prompt-history", historyQ], queryFn: ({ signal }) => api.promptHistory(historyQ, 30, { signal }), enabled: open && mode === "history", placeholderData: keepPreviousData });

  const now = Date.now();
  const learned = (it: Item) => (learn ? bonus(ranks[it.key], now) : 0) - (it.archived ? 400 : 0);
  // the accent on the label itself (a row may have been found by its other words: then nothing is lit)
  const withRanges = (rows: Item[], q: string) => rows.map((r) => ({ ...r, ranges: highlight(prepare(r.label), q.trim().toLowerCase()) }));
  // searching everything, a command or a setting comes after a timeline, a draft or a render that matches as well
  // (and a timeline, a draft or a project before the renders of the same name: "Harbor walk" the timeline before its takes)
  const KIND_NUDGE: Partial<Record<Kind, number>> = { timeline: 25, draft: 15, project: 15, folder: 10, command: -60, nav: -40 };
  const everything = (it: Item) => learned(it) + (it.kind === "setting" ? (it.setting?.kind === "page" ? -160 : -90) : KIND_NUDGE[it.kind] ?? 0);

  const sections: Array<{ group: string; rows: Array<Item & { ranges?: Array<[number, number]> }> }> = useMemo(() => {
    if (!open) return [];
    const q = text;
    switch (mode) {
      case "all": {
        if (!q) {
          const recent: Item[] = [];
          if (learn) for (const k of recentKeys(ranks, 12)) {
            const it = byKey.get(k) ?? templates.find((t) => t.key === k) ?? settingRows.find((s) => s.key === k);
            if (it && !it.archived && !it.complete) recent.push(it);
            if (recent.length >= 6) break;
          }
          // nothing learned yet: what was changed last
          if (recent.length < 4) {
            const latest = base.filter((i) => (i.kind === "timeline" || i.kind === "draft" || i.kind === "render") && !i.archived && !recent.includes(i)).sort((a, b) => (b.entry!.updatedAt > a.entry!.updatedAt ? 1 : -1));
            recent.push(...latest.slice(0, 6 - recent.length));
          }
          const suggested: Item[] = [];
          const qd = queueNow;
          if (qd?.paused) suggested.push(commandRow({ cmd: "resume" }));
          else if (qd?.running || qd?.waiting) suggested.push(commandRow({ cmd: "pause" }));
          if (aim?.entry?.unusedTakes) suggested.push(commandRow({ cmd: "bin-unused" }));
          if (qd && !qd.online) suggested.push(commandRow({ cmd: "reconnect" }));
          // a clip selected in the open editor: what its keys do to it
          suggested.push(...liveRow("split"), ...liveRow("previous-take"), ...liveRow("next-take"), ...liveRow("group-queue"));
          const failed = qd?.failed ?? 0;
          if (failed) {
            const label = `${failed} failed in the queue`;
            suggested.push({ key: "suggest:queue", kind: "job", label, meta: "Type ! to see them, Tab on one to retry", group: "Suggested", verb: "show", p: prepare(label), complete: "!" });
          }
          return [
            // two drafts of one name: their detail lines say what tells them apart
            { group: "Recent", rows: tellApart(recent.map((r) => ({ ...r, group: "Recent" as const }))) },
            ...(suggested.length ? [{ group: "Suggested", rows: suggested.map((r) => ({ ...r, group: "Suggested" as const })) }] : []),
          ].filter((s) => s.rows.length);
        }
        const found = search([...base, ...templates, ...navRows, ...settingRows], q, LIMIT, everything).map((x) => x.item);
        return grouped(withRanges(found, q), LIMIT);
      }
      case "command": {
        const rows: Item[] = [];
        if (parsed?.cmd === "load" || parsed?.cmd === "new-draft") {
          const word = parsed.cmd === "load" ? parsed.model : parsed.recipe;
          const pool = recipeItems.filter((x) => parsed.cmd === "load" || families.isOn(x.r.family));
          const hits = search(pool, word, 6).map((x) => x.item.r);
          if (hits.length) for (const r of hits) rows.push(commandRow(parsed, r));
          else rows.push(commandRow(parsed));
        } else if (parsed?.cmd === "preset") {
          // the presets the words name, as the models of `load`
          const hits = search(presetItems, parsed.name, 6).map((x) => x.item.e);
          if (hits.length) for (const p of hits) rows.push(commandRow(parsed, undefined, p));
          else rows.push(commandRow(parsed));
        } else if (parsed) rows.push({ ...commandRow(parsed), meta: [commandRow(parsed).meta, estimateSaid].filter(Boolean).join(" · ") });
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
        const cards = calc(q, gridOf(recipes, undefined)) ?? [];
        return [{ group: "Calculator", rows: cards.map((c, i) => ({ key: `calc:${i}`, kind: "calc" as const, label: c.value, meta: `${c.label} · ${c.note}`, group: "Calculator" as const, verb: "copy", p: prepare(c.value), card: c })) }].filter((s) => s.rows.length);
      }
      case "queue": {
        const qd = queueFull;
        const jobs: Item[] = [];
        if (qd?.running) jobs.push({ key: `job:${qd.running.id}`, kind: "job", label: qd.running.label, group: "Queue", verb: "open", p: prepare(qd.running.label), job: { job: qd.running, state: "running" }, meta: `running · ${qd.running.steps ? `step ${qd.running.step} of ${qd.running.steps}` : `${Math.round(qd.running.progress * 100)} %`}${qd.running.eta ? ` · ${timeLeft(qd.running.eta)}` : ""}` });
        qd?.waiting.forEach((w, i) => jobs.push({ key: `job:${w.id}`, kind: "job", label: w.label, group: "Queue", verb: "open", p: prepare(w.label), job: { job: w, state: "waiting", position: i + 1 }, meta: `waiting · ${i === 0 ? "next" : `${i + 1}${["st", "nd", "rd"][i] ?? "th"}`}${w.estimateMs ? ` · ${aboutMs(w.estimateMs)}` : ""} · Tab → to the top` }));
        for (const f of qd?.recent.filter((j) => j.status === "failed") ?? []) jobs.push({ key: `job:${f.id}`, kind: "job", label: f.label, group: "Queue", verb: "open", p: prepare(f.label), job: { job: f, state: "failed" }, meta: `failed${f.finishedAt ? ` ${new Date(f.finishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}${f.error ? ` · ${f.error.slice(0, 80)}` : ""} · Ctrl+Enter retries` });
        const found = q ? search(jobs, q, LIMIT).map((x) => x.item) : jobs;
        // what is done to the whole queue, after its jobs (Enter on the first row opens one, never cancels them all)
        const bulk = QUEUE_BULK.flatMap(liveRow);
        const bulkFound = q ? search(bulk, q, LIMIT).map((x) => x.item) : bulk;
        return [{ group: "Queue", rows: withRanges(found, q) }, { group: "Commands", rows: withRanges(bulkFound, q) }].filter((s) => s.rows.length);
      }
      case "history": {
        const rows = (history.data?.items ?? []).map((h, i): Item => ({ key: `history:${i}:${h.createdAt}`, kind: "history", label: h.prompt.replace(/\s+/g, " ").slice(0, 140), meta: `${recipes.find((r) => r.id === h.recipe)?.title ?? h.recipe} · ${when(h.createdAt)}`, group: "Prompt history", verb: "use", p: prepare(h.prompt.slice(0, 140)), history: h }));
        return [{ group: "Prompt history", rows: withRanges(rows, q) }].filter((s) => s.rows.length);
      }
      case "keys": {
        // the sheet's own search over the key table: the same rows in the same order; with nothing typed, every row
        const found = q ? searchKeys(q, keysHere, barKey) : null;
        if (!found) return [{ group: "Keys", rows: keyItems(allRows(keysHere), barKey) }];
        const kq = found.kq;
        return [
          { group: kq ? `The ${kq.exact.length > 1 ? "keys" : "key"} ${kq.exact.join("+")}` : "Keys", rows: keyItems(found.keys, barKey) },
          { group: "Words", rows: keyItems(found.said, barKey) },
        ].filter((s) => s.rows.length);
      }
      case "cast": {
        // where `@name` puts the person: the clip selected in the timeline editor, else the open draft
        const castTo = castPlace(selectedClip).detail;
        const people = (entities.data?.items ?? []).filter((e): e is Extract<Entity, { kind: "person" }> => e.kind === "person").map((p): Item => ({ key: `person:${p.id}`, kind: "person", label: p.name, meta: `Prompt kit · ${p.def.pictures.length} picture${p.def.pictures.length === 1 ? "" : "s"} ${castTo}`, group: "Cast", verb: "add", p: prepare(p.name), person: p }));
        const found = q ? search(people, q, LIMIT, learned).map((x) => x.item) : people.slice(0, LIMIT);
        return [{ group: "Cast", rows: withRanges(found, q) }].filter((s) => s.rows.length);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, text, base, ranks, learn, queueNow, queueFull, aim, settingRows, estimateSaid, history.data, entities.data, recipeItems, presetItems, navRows, selectedClip, keysHere, barKey]);

  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const at = Math.min(sel, Math.max(0, flat.length - 1));
  const current = flat[at] ?? null;

  // the preview and the full read of a render wait until the row stays selected a moment
  const [dwell, setDwell] = useState<Item | null>(null);
  useEffect(() => {
    if (!current) return setDwell(null);
    const t = setTimeout(() => setDwell(current), DWELL_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.key]);
  const shown = dwell && current && dwell.key === current.key ? current : null;
  const renderId = (acting?.item ?? shown)?.kind === "render" ? (acting?.item ?? shown)!.entry!.id : null;
  const detail = useAsset(open ? renderId : null).data;

  const onCopied = (what: string) => setFlash(what ? `Copied ${what}` : "Could not copy: the browser refused");
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [flash]);
  const { actionsOf, element } = useBarActions({ subject: detail ?? null, aim, settingCtx, onCopied });

  const actions: Action[] = acting ? actionsOf(acting.item) : [];
  const shownActions = acting ? (acting.text.trim() ? search(actions.map((a) => ({ a, p: prepare(a.label) })), acting.text, 60).map((x) => x.item.a) : actions) : [];

  const remember = (it: Item) => {
    if (!learn || it.kind === "calc" || it.kind === "history" || it.key.startsWith("suggest:")) return;
    const next = bumped(ranks, it.key.startsWith("cmd:") ? it.key.split(":").slice(0, 2).join(":") : it.key, Date.now());
    setRanks(next);
    save(next);
  };
  const run = (it: Item, a: Action | undefined) => {
    if (!a || a.disabled) return;
    remember(it);
    if (!a.stay) close();
    void Promise.resolve().then(() => a.run());
  };
  /** Enter on a row (Ctrl: its second action). A command still missing its figures completes the bar instead. */
  const choose = (it: Item | null, second = false) => {
    if (!it) return;
    if (it.complete) {
      setTyped(it.complete);
      setSel(0);
      return;
    }
    const list = actionsOf(it);
    run(it, list[second ? 1 : 0] ?? (second ? undefined : list[0]));
  };

  // the selected row stays in view
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>(`[data-row="${acting ? acting.sel : at}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [at, acting?.sel, acting]);

  // Shift pressed and let go alone shows or hides the preview (Shift + a letter is a capital, Shift + Tab goes back)
  const shiftAlone = useRef(false);
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const k = e.key;
    shiftAlone.current = k === "Shift" && !e.repeat;
    const count = acting ? shownActions.length : flat.length;
    const move = (by: number) => {
      e.preventDefault();
      if (!count) return;
      if (acting) setActing({ ...acting, sel: (acting.sel + by + count) % count });
      else setSel((at + by + count) % count);
    };
    if (k === "ArrowDown") return move(1);
    if (k === "ArrowUp") return move(-1);
    if (k === "PageDown") return move(Math.min(8, count - 1 - (acting ? acting.sel : at)) || 0);
    if (k === "PageUp") return move(-Math.min(8, acting ? acting.sel : at));
    if (k === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (acting) return setActing(null);
      if (typed) {
        setTyped("");
        setSel(0);
        return;
      }
      return close();
    }
    if (k === "Tab") {
      e.preventDefault();
      if (acting) return setActing(null);
      if (current?.complete) return choose(current);
      if (current && actionsOf(current).length) {
        setDwell(current);
        setActing({ item: current, text: "", sel: 0 });
      }
      return;
    }
    if (k === "Enter") {
      e.preventDefault();
      if (e.nativeEvent.isComposing) return;
      if (acting) {
        const a = shownActions[acting.sel];
        if (a) {
          run(acting.item, a);
          if (a.stay) setActing(null);
        }
        return;
      }
      return choose(current, e.ctrlKey || e.metaKey);
    }
  };
  const onKeyUp = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Shift" && shiftAlone.current) setPreview(!useBar.getState().preview);
    shiftAlone.current = false;
  };

  if (!open) return element;

  // a row of the key table has nothing to preview: the sheet is where it is shown
  const showPreview = preview && !acting && Boolean(current) && mode !== "calc" && mode !== "keys";
  const second = current && !current.complete ? actionsOf(current)[1] : undefined;
  const verb = acting ? "run" : current?.complete ? "complete" : current?.verb ?? "open";
  const commandExtra = shown?.kind === "command" && shown.command ? {
    text: shown.meta,
    facts: [
      ...(estimateOf && estimate.data ? [{ k: "estimate", v: estimate.data.ms !== null ? `${aboutMs(estimate.data.ms)} (learned)` : "not learned yet" }, { k: "queue ahead", v: String(estimate.data.ahead) }] : []),
      ...(shown.command.cmd === "render-clips" ? [{ k: "clips", v: shown.command.clips.join(", ") }] : []),
      ...(aim && ["render-clips", "render-missing", "export", "bin-unused"].includes(shown.command.cmd) ? [{ k: "timeline", v: aim.name }] : []),
    ],
  } : shown?.kind === "command" && shown.complete ? { text: `${COMMANDS.find((c) => `cmd:${c.id}` === shown.key)?.what ?? ""}.\nEnter or Tab writes it in the bar: add its figures.`, facts: [{ k: "example", v: COMMANDS.find((c) => `cmd:${c.id}` === shown.key)?.example ?? "" }] } : undefined;
  const optionId = (i: number) => `bar-opt-${i}`;
  const empty = !acting && !flat.length;

  return (
    <>
      {element}
      {createPortal(
        <div className="fixed inset-0 z-[85]" onKeyDown={(e) => { if (e.key === "Tab" && e.target !== input.current) { e.preventDefault(); input.current?.focus(); } }}>
          {/* the page behind, dimmed and blurred: a click on it closes the bar */}
          <div aria-hidden className="absolute inset-0 bg-ground/55 backdrop-blur-[3px] animate-[bar-fade_110ms_ease-out] motion-reduce:animate-none" onPointerDown={close} />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Command bar"
            style={{ width: showPreview ? 1080 : 700 }}
            className={cx(
              "absolute top-[11vh] left-1/2 flex max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-[18px] border border-line-strong bg-panel/95 backdrop-blur-md",
              "shadow-[0_40px_120px_-12px_color-mix(in_srgb,var(--color-shade)_75%,transparent),0_0_0_1px_color-mix(in_srgb,var(--color-accent)_12%,transparent),0_0_70px_-8px_color-mix(in_srgb,var(--color-accent)_14%,transparent)]",
              "origin-top animate-[bar-in_120ms_cubic-bezier(.2,.8,.2,1)] transition-[width] duration-150 ease-out motion-reduce:animate-none motion-reduce:transition-none",
            )}
          >
            <div className="flex items-center gap-3 border-b border-line px-5 py-4">
              <Search size={20} strokeWidth={2.2} className={cx("shrink-0", MODE_TONE[mode])} aria-hidden />
              {acting && (
                <button type="button" tabIndex={-1} onClick={() => setActing(null)} className="flex max-w-[45%] shrink-0 items-center gap-1.5 rounded-lg bg-accent/15 px-2.5 py-1 text-[13px] font-semibold text-accent" data-tip="Back to the results (Tab or Esc)">
                  <span className="truncate">{acting.item.label}</span><ChevronRight size={14} className="shrink-0 opacity-70" />
                </button>
              )}
              <input
                ref={input}
                role="combobox"
                aria-expanded={!empty}
                aria-controls="bar-list"
                aria-autocomplete="list"
                aria-activedescendant={acting ? (shownActions.length ? optionId(acting.sel) : undefined) : current ? optionId(at) : undefined}
                aria-label={acting ? `Actions on ${acting.item.label}` : "Search Afflatus"}
                autoComplete="off"
                spellCheck={false}
                value={acting ? acting.text : typed}
                placeholder={acting ? "Filter actions…" : "Search timelines, drafts, renders, commands…"}
                onChange={(e) => {
                  if (acting) setActing({ ...acting, text: e.target.value, sel: 0 });
                  else {
                    setTyped(e.target.value);
                    setSel(0);
                  }
                }}
                onKeyDown={onKey}
                onKeyUp={onKeyUp}
                className="min-w-0 grow bg-transparent text-xl font-medium text-ink placeholder:text-ink-3"
                // the bar itself is what has the focus: no ring of its own (the app's ring is outside the utility layer)
                style={{ outline: "none" }}
              />
              {MODE_WORD[mode] && !acting && <span className={cx("shrink-0 rounded-full bg-raised px-2.5 py-0.5 text-xs", MODE_TONE[mode])}>{MODE_WORD[mode]}</span>}
              {index.isFetching && !index.data && <span className="shrink-0 text-xs text-ink-3">reading…</span>}
              <Keys keys="Esc" />
            </div>

            <div className={cx("flex min-h-0", mode === "calc" ? "max-h-[min(520px,62vh)]" : "h-[min(520px,62vh)]")}>
              <div ref={list} id="bar-list" role="listbox" aria-label={acting ? "Actions" : "Results"} className="min-w-0 flex-1 overflow-y-auto p-2">
                {acting ? (
                  <>
                    <div className="px-3 pt-2.5 pb-1.5 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">Actions</div>
                    {shownActions.map((a, i) => (
                      <button
                        key={`${a.label}:${i}`}
                        id={optionId(i)}
                        data-row={i}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        aria-selected={i === acting.sel}
                        aria-disabled={a.disabled}
                        onMouseMove={() => i !== acting.sel && setActing({ ...acting, sel: i })}
                        onClick={() => { run(acting.item, a); if (a.stay) setActing(null); input.current?.focus(); }}
                        className={cx("flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left", i === acting.sel && "bg-accent/14 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_35%,transparent)]", a.disabled && "opacity-45")}
                      >
                        <span className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-raised", a.danger ? "text-warn-ink" : "text-ink-2")}>{a.icon ?? <Zap size={15} />}</span>
                        <span className="flex min-w-0 grow flex-col">
                          <span className={cx("truncate text-[14.5px] font-semibold", a.danger ? "text-warn-ink" : "text-ink")}>{a.label}</span>
                          {(a.note || i < 2) && <span className="truncate text-xs text-ink-2">{[a.note, i === 0 ? "Enter on the result" : i === 1 ? "Ctrl+Enter on the result" : ""].filter(Boolean).join(" · ")}</span>}
                        </span>
                        {a.keys && <Keys keys={a.keys} size="sm" className="text-ink-2" />}
                        {i === acting.sel && <span className="flex shrink-0 items-center gap-1 text-[11px] text-ink-2"><Keys keys="Enter" size="sm" /> run</span>}
                      </button>
                    ))}
                    {!shownActions.length && <div className="px-5 py-10 text-center text-sm text-ink-3">No action called that.</div>}
                  </>
                ) : mode === "calc" ? (
                  <div className="flex flex-col gap-3 p-2.5">
                    {flat.length ? (
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
                        {flat.map((it, i) => (
                          <button
                            key={it.key}
                            id={optionId(i)}
                            data-row={i}
                            type="button"
                            role="option"
                            tabIndex={-1}
                            aria-selected={i === at}
                            onMouseMove={() => i !== at && setSel(i)}
                            onClick={() => { choose(it); input.current?.focus(); }}
                            className={cx("flex flex-col gap-1 rounded-xl p-3.5 text-left", i === at ? "bg-good/10 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-good)_40%,transparent)]" : "bg-raised/60")}
                          >
                            <span className="text-xs text-ink-2">{it.card!.label}</span>
                            <span className="font-mono text-[26px] leading-tight font-medium text-ink-strong">{it.card!.value}</span>
                            <span className="text-[11.5px] text-ink-2">{it.card!.note}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="px-3 py-6 text-center text-sm text-ink-3">{text ? "The calculator does not read that." : "A length, frames, a size, proportions, or a sum."}</div>
                    )}
                    <div className="flex flex-wrap gap-2 font-mono text-xs text-ink-2">
                      {["7s 24fps", "121f 24fps", "1152x2048", "9:16 1mp", "17*10+5"].map((x) => (
                        <button key={x} type="button" tabIndex={-1} onClick={() => { setTyped(`= ${x}`); input.current?.focus(); }} className="rounded-[7px] bg-raised px-2 py-1 hover:text-ink">{x}</button>
                      ))}
                    </div>
                  </div>
                ) : (
                  sections.map((s) => {
                    const first = flat.indexOf(s.rows[0]!);
                    return (
                      <div key={s.group} role="group" aria-label={s.group}>
                        <div className="px-3 pt-2.5 pb-1.5 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">{s.group}</div>
                        {s.rows.map((it, k) => {
                          const i = first + k;
                          const on = i === at;
                          const toggle = it.setting?.kind === "switch" ? Boolean(it.setting.get?.(settingCtx)) : null;
                          const running = it.job?.state === "running" ? (it.job.job as { progress?: number }).progress ?? 0 : null;
                          return (
                            <button
                              key={it.key}
                              id={optionId(i)}
                              data-row={i}
                              type="button"
                              role="option"
                              tabIndex={-1}
                              aria-selected={on}
                              onMouseMove={() => !on && setSel(i)}
                              onClick={() => { setSel(i); choose(it); input.current?.focus(); }}
                              className={cx("flex w-full items-center gap-3 rounded-xl px-3 py-[9px] text-left", on && "bg-accent/14 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_35%,transparent)]")}
                            >
                              <span className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[color-mix(in_srgb,currentColor_13%,transparent)]", it.job?.state === "failed" ? "text-warn" : TONE[it.kind])}>{iconOf(it)}</span>
                              <span className="flex min-w-0 grow flex-col gap-px">
                                <span className={cx("truncate text-[14.5px] font-semibold", it.job?.state === "failed" ? "text-warn-ink" : "text-ink", it.archived && "opacity-60")}>
                                  {pieces(it.label, it.ranges ?? []).map((p, n) => (p.hit ? <span key={n} className="text-accent">{p.text}</span> : <span key={n}>{p.text}</span>))}
                                </span>
                                {running !== null && <span className="my-1 block h-1 overflow-hidden rounded-full bg-raised"><span className="block h-full rounded-full bg-good transition-[width] duration-500" style={{ width: `${Math.round(running * 100)}%` }} /></span>}
                                <span className="truncate text-xs text-ink-2">{it.meta}{it.job?.state === "running" && <StepRateSaid id={it.job.job.id} />}</span>
                              </span>
                              {toggle !== null && (
                                <span aria-hidden className={cx("h-5 w-[34px] shrink-0 rounded-full p-[3px] transition-colors", toggle ? "bg-accent" : "bg-line-strong")}>
                                  <span className={cx("block h-3.5 w-3.5 rounded-full transition-[margin] duration-150", toggle ? "ml-[14px] bg-knob" : "bg-ink")} />
                                </span>
                              )}
                              {/* the key that does the same in the app, from the key table (a row of the `?` mode: its own keys, a search's lit) */}
                              {it.keys && <Keys keys={it.keys} size="sm" hits={it.keyRow?.hits} className="text-ink-2" />}
                              {on && <span className="flex shrink-0 items-center gap-1 text-[11px] whitespace-nowrap text-ink-2"><Keys keys="Enter" size="sm" /> {it.complete ? "complete" : it.verb}</span>}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })
                )}
                {empty && mode !== "calc" && (
                  <div className="px-5 py-10 text-center text-sm text-ink-3">
                    {index.isLoading ? "Reading what Afflatus holds…"
                      : mode === "command" ? <>No command reads that. Try <span className="font-mono text-ink-2">render clips 3-5</span>, <span className="font-mono text-ink-2">seed 1234</span>, <span className="font-mono text-ink-2">pause queue</span>.</>
                      : mode === "queue" ? "Nothing runs, waits or failed lately."
                      : mode === "history" ? (history.isFetching ? "Looking…" : "No rendered prompt holds that.")
                      : mode === "cast" ? "No person of the Prompt kit is called that."
                      : mode === "keys" ? <>No key does that. Try another word, or a key: <Keys keys="S" size="sm" />, <Keys keys="Ctrl+Z" size="sm" />.</>
                      : <>Nothing called that. Try <Keys keys=">" size="sm" /> for commands.</>}
                  </div>
                )}
              </div>
              {showPreview && shown && <Preview item={shown} detail={detail} recipes={recipes} settingCtx={settingCtx} extra={commandExtra} />}
            </div>

            {/* the footer in the sheet's notation and names: keycaps for the keys, the mode characters as caps with their names */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line bg-ground/40 px-[18px] py-2.5 text-xs whitespace-nowrap text-ink-2">
              <span className="flex items-center gap-1.5"><Keys keys="↑ ↓" /> move</span>
              <span className="flex items-center gap-1.5"><Keys keys="Enter" /> {verb}</span>
              {!acting && current && !current.complete && second && <span className="flex min-w-0 items-center gap-1.5"><Keys keys="Ctrl+Enter" /> <span className="max-w-[170px] truncate">{second.label.toLowerCase()}</span></span>}
              <span className="flex items-center gap-1.5"><Keys keys="Tab" /> {acting ? "back" : "actions"}</span>
              <span className="flex items-center gap-1.5"><Keys keys="Shift" /> preview{preview ? "" : " (off)"}</span>
              <span className="grow" />
              {flash ? (
                <span role="status" className="font-semibold text-good">{flash}</span>
              ) : (
                <span className="flex min-w-0 flex-wrap justify-end gap-x-2.5 gap-y-1 text-ink-3">
                  {[...FOOTER_MODES, ...(bar?.history ? [['"', "history"]] : []), ...(bar?.cast ? [["@", "cast"]] : [])].map(([c, w]) => (
                    <button key={c} type="button" tabIndex={-1} onClick={() => { setTyped(c!); setSel(0); setActing(null); input.current?.focus(); }} className="flex items-center gap-1 hover:text-ink">
                      <Keys keys={c!} /> {w}
                    </button>
                  ))}
                  {bar && OFF_PARTS.filter(([k]) => !bar[k]).map(([k, c, w]) => (
                    <button
                      key={k} type="button" tabIndex={-1}
                      data-tip="Off. Click to turn it on in Settings › Command bar."
                      onClick={() => { close(); go(settingHref(`bar.${k}`)); }}
                      className="flex items-center gap-1 opacity-55 hover:text-ink hover:opacity-100"
                    >
                      <Keys keys={c} /> {w} off
                    </button>
                  ))}
                </span>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
