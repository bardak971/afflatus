import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { LATENT_GRID, type FrameGrid } from "@afflatus/core";
import { api, type AssetDetail, type CommandEntry, type CommandEstimate, type Entity, type PromptHistoryItem, type RecipeInfo, type Settings } from "../api";
import { useAsset, useEntities, useFamilies, useRecipes, useSettings, useStorage } from "../data";
import { itemsWord } from "../assetCache";
import { groupingSaves } from "../screens/queue/bulk";
import { useQueueOf } from "../screens/studio/queueOf";
import { aboutMs, size } from "../format";
import { useProject } from "../project";
import { useBanners, useExplain, useHoverPlay, useNotify } from "../store";
import { useThemeChoice } from "../theme/store";
import { opened } from "../keys/search";
import { BAR_DEFAULT } from "../keys/table";
import { TABS, tabHref } from "../screens/settings/settingsIndex";
import { isUnder, queryKeys } from "../queryKeys";
import { type Grid } from "./calc";
import { commandTemplates, type CommandCtx } from "./commandRows";
import { indexItems, navItems, rowsFor, settingItems, usedItems, withItems, type Item, type Section } from "./items";
import { prepare } from "./match";
import { COMMANDS, parseCommand, type Command, type Mode } from "./parse";
import { load, recentKeys, renamed, type Ranks } from "./rank";
import { PAGES, SETTINGS, settingKeyNow, type SettingCtx } from "./settingsRegistry";
import { useSelectedClip } from "./bridge";
import { castPlace } from "./castTo";
import { useBar } from "./store";
import type { TimelineAim } from "./useActions";

/** One empty list while the recipes load, so what is worked out from them is not redone at every render. */
const NO_RECIPES: RecipeInfo[] = [];
const NO_HISTORY: PromptHistoryItem[] = [];

/** How long a row stays selected before its preview is drawn: arrowing fast loads nothing. */
const DWELL_MS = 80;

/** What this browser learned, with the keys of results that were renamed since carried over. */
export const loadRanks = () => renamed(load(), settingKeyNow);

/**
 * The calculator's grid: the model in play's (the open draft's, else one on the grid of the latents the app keeps, else
 * the first one that makes video on a grid), that grid when none is known.
 */
function gridOf(recipes: RecipeInfo[], prefer: string | undefined): Grid {
  const video = recipes.filter((r) => r.traits?.frameGrid);
  const kept = (g: FrameGrid) => g.step === LATENT_GRID.step && g.offset === LATENT_GRID.offset;
  const r = video.find((x) => x.id === prefer) ?? video.find((x) => kept(x.traits!.frameGrid)) ?? video[0];
  const sizeInput = r?.inputs.find((i) => i.type === "size");
  return {
    name: r ? r.family.toUpperCase() : "H3",
    fps: r?.traits?.fps ?? 24,
    frames: r?.traits?.frameGrid ?? LATENT_GRID,
    size: sizeInput && sizeInput.type === "size" ? sizeInput.grid : 32,
  };
}

/** What the preview says of a command row: its estimate and targets, or, still missing its figures, what it does. */
export function commandExtra(shown: Item | null, estimate: CommandEstimate | undefined, aim: TimelineAim | null): { text: string; facts: Array<{ k: string; v: string }> } | undefined {
  if (shown?.kind !== "command") return undefined;
  if (shown.command) return {
    text: shown.meta,
    facts: [
      ...(estimate ? [{ k: "estimate", v: estimate.ms !== null ? `${aboutMs(estimate.ms)} (learned)` : "not learned yet" }, { k: "queue ahead", v: String(estimate.ahead) }] : []),
      ...(shown.command.cmd === "render-clips" ? [{ k: "clips", v: shown.command.clips.join(", ") }] : []),
      ...(aim && ["render-clips", "render-missing", "export", "bin-unused"].includes(shown.command.cmd) ? [{ k: "timeline", v: aim.name }] : []),
    ],
  };
  if (!shown.complete) return undefined;
  const c = COMMANDS.find((x) => `cmd:${x.id}` === shown.key);
  return { text: `${c?.what ?? ""}.\nEnter or Tab writes it in the bar: add its figures.`, facts: [{ k: "example", v: c?.example ?? "" }] };
}

/**
 * Everything the bar's rows are made of: the index of what Afflatus holds, the recipes, settings, Prompt kit and queue,
 * the timeline a command acts on, a render command's estimate, and the rows themselves for what is typed (rowsFor).
 */
export function useBarData({ open, mode, text, ranks, picked, learn, foundEntries, history }: {
  open: boolean;
  mode: Mode;
  text: string;
  ranks: Ranks;
  /** The library's items opened from the bar since the index was read. */
  picked: CommandEntry[];
  learn: boolean;
  foundEntries: CommandEntry[] | undefined;
  /** The prompt history found for what is typed in its mode. */
  history: PromptHistoryItem[] | undefined;
}) {
  const [path] = useLocation();
  const client = useQueryClient();
  const recipeList = useRecipes().data;
  const recipes = recipeList?.recipes ?? NO_RECIPES;
  const families = useFamilies();
  const settings = useSettings();
  const entities = useEntities();
  const currentProject = useProject((s) => s.id);
  // the index holds the newest of the library's items and those used here lately (for Recent); the others are asked for as typed
  const index = useQuery({ queryKey: queryKeys.commandIndex.all(), queryFn: ({ signal }) => api.commandIndex(usedItems(loadRanks()), { signal }), staleTime: Infinity });

  // marked old by a live event while closed: read on opening (the old one shows meanwhile)
  useLayoutEffect(() => {
    if (open && index.isStale && !index.isFetching) void index.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on opening only
  }, [open]);

  // a draft made, saved or deleted is not announced by the server: a change of the drafts lists marks the index old too
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const stop = client.getQueryCache().subscribe((e) => {
      // (the workflows likewise: their import and removal send no live event)
      const key = e.query.queryKey;
      if (e.type !== "updated" || e.action.type !== "success" || !(isUnder(key, queryKeys.drafts.lists()) || isUnder(key, queryKeys.workflows()))) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => void client.invalidateQueries({ queryKey: queryKeys.commandIndex.all(), refetchType: useBar.getState().open ? "active" : "none" }), 300);
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
      client.setQueryData(queryKeys.settings(), saved);
    },
  }), [settings.data, client]);
  // the switches kept in this browser: the bar is drawn again when one changes, so that a switch flipped here shows it
  const kept = [useHoverPlay(), useExplain(), useThemeChoice(), useNotify()];
  const bar = settings.data?.bar;
  const selectedClip = useSelectedClip((c) => c.clip);
  // what the bin holds, for Empty the bin and Put all back
  const binNow = useStorage().data?.bin;
  const binEmpty = binNow ? !binNow.count : false;
  const binSaid = binNow ? `${itemsWord(binNow.count)} · ${size(binNow.bytes)}` : "";
  // the queue only while open, and in full only in the queue mode (its jobs live): the bar does not draw again
  // at every sampler step for the counts it says elsewhere
  const queueNow = useQueueOf((q) => (open ? { paused: q.paused, online: q.online, rendering: q.running?.kind === "render", running: Boolean(q.running), waiting: q.waiting.length, failed: q.recent.filter((j) => j.status === "failed").length, saves: groupingSaves(q.waiting, q.running) } : null));
  const queueFull = useQueueOf((q) => (open && mode === "queue" ? q : null));

  // the timeline a command acts on: the one open in the editor, else the one last opened from here, else the last changed
  const entries = useMemo(() => withItems(index.data?.entries ?? [], picked, foundEntries ?? []), [index.data, picked, foundEntries]);
  const familyList = recipeList?.families;
  const base = useMemo(() => indexItems(entries, recipes, currentProject, index.data?.inboxItems, familyList), [entries, recipes, currentProject, index.data?.inboxItems, familyList]);
  const byKey = useMemo(() => new Map(base.map((i) => [i.key, i])), [base]);
  const aim: TimelineAim | null = useMemo(() => {
    const open = /^\/timelines\/([^/]+)/.exec(path)?.[1];
    const pick = (id: string | undefined) => {
      const it = id ? byKey.get(`timeline:${id}`) : undefined;
      return it?.entry?.kind === "timeline" ? { id: it.entry.id, name: it.entry.label, entry: it.entry } : null;
    };
    if (open) return { ...(pick(open) ?? { id: open, name: "the open timeline" }), open: true };
    const used = recentKeys(ranks, 50).find((k) => k.startsWith("timeline:"));
    if (used && pick(used.slice(9))) return pick(used.slice(9));
    const last = base.filter((i) => i.kind === "timeline" && !i.archived).sort((a, b) => (b.entry!.updatedAt > a.entry!.updatedAt ? 1 : -1))[0];
    return last ? pick(last.entry!.id) : null;
  }, [path, byKey, ranks, base]);
  // what `> undo` would undo: the open editor's last change (as its header's Undo says it), else the newest banner's
  const bannerUndo = useBanners((s) => [...s.items].reverse().find((x) => x.action?.undo)?.title ?? null);
  const editorUndo = aim?.open ? client.getQueryData<{ undo?: string | null }>(queryKeys.timelines.one(aim.id))?.undo ?? null : null;

  // eslint-disable-next-line react-hooks/exhaustive-deps -- the rows follow the kept settings' values, not the identity of their list
  const settingRows = useMemo(() => settingItems([...SETTINGS, ...PAGES], settingCtx), [settingCtx, ...kept]);
  const recipeItems = useMemo(() => recipes.map((r) => ({ r, p: prepare(`${r.family} ${r.title}`) })), [recipes]);
  const presetItems = useMemo(() => (entities.data?.items ?? []).filter((e): e is Extract<Entity, { kind: "preset" }> => e.kind === "preset").map((e) => ({ e, p: prepare(e.name) })), [entities.data]);
  const navRows = useMemo(() => navItems(TABS.map((t) => ({ id: t.id, label: t.label, href: tabHref(t.id) }))), []);
  // the places of the key table open under the bar, read as it opens: the `?` mode lists their rows first, as the sheet does
  const keysHere = useMemo(() => (open ? opened().here : []), [open]);
  const barKey = bar?.shortcut ?? BAR_DEFAULT;

  // what the command rows say of the moment (commandRows.ts); the commands offered with it, those that apply now
  const commandCtx: CommandCtx = useMemo(() => ({ aim, queue: queueNow ?? null, selectedClip, bannerUndo, editorUndo, binEmpty, binSaid }), [aim, queueNow, selectedClip, bannerUndo, editorUndo, binEmpty, binSaid]);
  const templates = useMemo(() => commandTemplates(commandCtx), [commandCtx]);

  // the render estimate of a render command, learned from this machine's renders (none said when nothing is learned)
  const parsed: Command | null = mode === "command" ? parseCommand(text) : null;
  const estimateOf = parsed && aim && (parsed.cmd === "render-clips" || parsed.cmd === "render-missing") ? { timeline: aim.id, clips: parsed.cmd === "render-clips" ? parsed.clips : undefined } : null;
  const estimate = useQuery({
    queryKey: queryKeys.barEstimate(estimateOf),
    queryFn: ({ signal }) => api.commandEstimate(estimateOf!, { signal }),
    enabled: Boolean(estimateOf) && open,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  const estimated = estimateOf ? estimate.data : undefined;
  const estimateSaid = estimated ? [estimated.ms !== null && `${aboutMs(estimated.ms)}, learned from ${estimated.basis} render${estimated.basis === 1 ? "" : "s"}`, estimated.ahead ? `after ${estimated.ahead} job${estimated.ahead === 1 ? "" : "s"}` : "nothing before it"].filter(Boolean).join(" · ") : "";

  const sections: Section[] = useMemo(() => {
    if (!open) return [];
    return rowsFor(mode, {
      text, base, byKey, templates, settingRows, navRows, command: commandCtx, learn, ranks, now: Date.now(), parsed, estimateSaid,
      recipes, recipeItems, presetItems, familyOn: (f) => families.isOn(f), grid: gridOf(recipes, undefined), queue: queueFull ?? null,
      history: history ?? NO_HISTORY, keysHere, barKey, entities: entities.data?.items ?? [], castTo: castPlace(selectedClip).detail,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the rows are worked out from what they show; the helpers read here are new at every render
  }, [open, mode, text, base, ranks, learn, queueFull, settingRows, estimateSaid, history, entities.data, recipeItems, presetItems, navRows, selectedClip, keysHere, barKey, templates, commandCtx]);
  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);

  return { index, recipes, settingCtx, bar, aim, estimated, sections, flat };
}

/**
 * The row the preview shows, and the render read in full for it and for the actions: both wait until the row stays
 * selected a moment (`setDwell` shows one at once). `acted` is the result whose actions are shown.
 */
export function useShown(open: boolean, current: Item | null, acted: Item | null) {
  const [dwell, setDwell] = useState<Item | null>(null);
  useEffect(() => {
    if (!current) return setDwell(null);
    const t = setTimeout(() => setDwell(current), DWELL_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the row by its key: a new object for the same row does not start the wait again
  }, [current?.key]);
  const shown = dwell && current && dwell.key === current.key ? current : null;
  const renderId = (acted ?? shown)?.kind === "render" ? (acted ?? shown)!.entry!.id : null;
  const read = useAsset(open ? renderId : null).data;
  // the render last read stays the actions' subject once the bar closes: an action runs after the bar is gone, and the
  // hooks that do it (Mirror, Image to video, Extend, a pass's form…) read their item when they run, not when chosen
  const lastRead = useRef<AssetDetail | null>(null);
  if (read) lastRead.current = read;
  const detail = read ?? (open ? undefined : lastRead.current ?? undefined);
  return { shown, setDwell, detail };
}
