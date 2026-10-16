import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { LATENT_GRID, type FrameGrid } from "@afflatus/core";
import { api, type AssetDetail, type CommandEntry, type CommandEstimate, type Entity, type PromptHistoryItem, type FamilyInfo, type BrowseBases, type RecipeInfo, type SettingsPatch } from "../api";
import { useAsset, useEntities, useFamilies, useRecipes, useSettings, useSetup, useStorage } from "../data";
import { itemsWord } from "../assetCache";
import { groupingSaves } from "../screens/queue/bulk";
import { useQueueOf } from "../screens/studio/queueOf";
import { aboutMs, plural, size } from "../format";
import { useProject } from "../project";
import { useBanners, useCompareResult, useExplain, useHoverPlay, useNotify } from "../store";
import { useThemeChoice } from "../theme/store";
import { opened } from "../keys/search";
import { BAR_DEFAULT } from "../keys/table";
import { TABS, tabHref } from "../screens/settings/settingsIndex";
import { isUnder, queryKeys } from "../queryKeys";
import { type Grid } from "./calc";
import { commandTemplates, type CommandCtx } from "./commandRows";
import { machineLabel, severalMachines } from "../machines";
import { indexItems, navItems, rowsFor, settingItems, usedItems, withItems, type Item, type Section } from "./items";
import { prepare, search } from "./match";
import { COMMANDS, parseCommand, type Command, type Mode } from "./parse";
import { load, recentKeys, renamed, type Ranks } from "./rank";
import { PAGES, SETTINGS, settingKeyNow, type SettingCtx } from "./settingsRegistry";
import { useSelectedClip } from "./bridge";
import { castPlace } from "./castTo";
import { useBar } from "./store";
import type { Chip } from "./SearchChips";
import { pickedNow, usePickedCount } from "../findModels/store";
import { useFormTarget } from "../formTarget";
import { browseRows, browseValueRows, downloadRows, isLink, linkRows } from "./modelRows";
import { parseBrowse, siteQuery } from "./browseSearch";
import { nameOf } from "../fields/Loras";
import { settingHref } from "../screens/settings/settingsIndex";
import { useDebounced } from "../hooks";
import { isRenderSearch, parseSearch } from "./search";
import { filterOf, keyRows, loosened, promptRows, resultSections, valueRows, type SearchData } from "./searchRows";
import { useUpdates } from "../updates";
import type { TimelineAim } from "./actions/ctx";

/** One empty list while the recipes load, so what is worked out from them is not redone at every render. */
const NO_RECIPES: RecipeInfo[] = [];
const NO_HISTORY: PromptHistoryItem[] = [];
const NO_FAMILIES: FamilyInfo[] = [];
const NO_BROWSE_FAMILIES: BrowseBases["families"] = [];
/** Civitai and Hugging Face asked for with lookups off: the row that leads to the switch. */
const lookupsOff: Item = { key: "link:off", kind: "nav", label: "Search Hugging Face and Civitai is off", meta: "Turn it on to search or read a link · Settings › Models", group: "Go to", verb: "open", p: prepare("lookups off"), nav: { href: settingHref("server.civitaiLookups") } };

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
      ...(aim && ["render-clips", "render-missing", "export", "export-editor", "bin-unused"].includes(shown.command.cmd) ? [{ k: "timeline", v: aim.name }] : []),
    ],
  };
  if (!shown.complete) return undefined;
  // a render search's key, value or key taken off: the line it leaves in the bar
  if (shown.group === "Filters") return { text: `${shown.meta}.
Enter or Tab writes it in the bar.`, facts: [{ k: "the bar then reads", v: shown.complete.trim() || "(empty)" }] };
  const c = COMMANDS.find((x) => `cmd:${x.id}` === shown.key);
  return { text: `${c?.what ?? ""}.\nEnter or Tab writes it in the bar: add its figures.`, facts: [{ k: "example", v: c?.example ?? "" }] };
}

/**
 * Everything the bar's rows are made of: the index of what Afflatus holds, the recipes, settings, Prompt kit and queue,
 * the timeline a command acts on, a render command's estimate, and the rows themselves for what is typed (rowsFor).
 */
export function useBarData({ open, mode, text, line, ranks, picked, learn, foundEntries }: {
  open: boolean;
  mode: Mode;
  text: string;
  /** What is typed as it stands, a space at its end kept: the render search reads a key's value as ended by it. */
  line: string;
  ranks: Ranks;
  /** The library's items opened from the bar since the index was read. */
  picked: CommandEntry[];
  learn: boolean;
  foundEntries: CommandEntry[] | undefined;
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
    save: async (patch: SettingsPatch) => {
      const saved = await api.saveSettings(patch);
      client.setQueryData(queryKeys.settings(), saved);
    },
  }), [settings.data, client]);
  // the switches kept in this browser: the bar is drawn again when one changes, so that a switch flipped here shows it
  const kept = [useHoverPlay(), useExplain(), useThemeChoice(), useNotify(), useCompareResult()];
  const bar = settings.data?.bar;
  const selectedClip = useSelectedClip((c) => c.clip);
  // what the bin holds, for Empty the bin and Put all back
  const binNow = useStorage().data?.bin;
  const binEmpty = binNow ? !binNow.count : false;
  const binSaid = binNow ? `${itemsWord(binNow.count)} · ${size(binNow.bytes)}` : "";
  // the queue only while open, and in full only in the queue mode (its jobs live): the bar does not draw again
  // at every sampler step for the counts it says elsewhere
  const queueNow = useQueueOf((q) => (open ? { paused: q.paused, online: q.online, rendering: q.running?.kind === "render", running: Boolean(q.running), waiting: q.waiting.length, failed: q.recent.filter((j) => j.status === "failed").length, saves: groupingSaves(q.waiting, q.running), machines: severalMachines(q).map((m) => ({ id: m.id, label: machineLabel(m), paused: m.paused, online: m.online, locked: m.locked, running: Boolean(m.running), rented: m.rented, outside: m.outside, ...(m.files ? { files: m.files } : {}) })), hunting: Boolean(q.hunt) } : null));
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
  // a recipe hidden for now (core's Recipe.hidden) is no `load` or `new` row
  const recipeItems = useMemo(() => recipes.filter((r) => !r.hidden).map((r) => ({ r, p: prepare(`${r.family} ${r.title}`) })), [recipes]);
  const presetItems = useMemo(() => (entities.data?.items ?? []).filter((e): e is Extract<Entity, { kind: "preset" }> => e.kind === "preset").map((e) => ({ e, p: prepare(e.name) })), [entities.data]);
  const navRows = useMemo(() => navItems(TABS.map((t) => ({ id: t.id, label: t.label, href: tabHref(t.id) }))), []);
  // the places of the key table open under the bar, read as it opens: the `?` mode lists their rows first, as the sheet does
  const keysHere = useMemo(() => (open ? opened().here : []), [open]);
  const barKey = bar?.shortcut ?? BAR_DEFAULT;

  // what the rented GPUs cost (`> spending`), read while the bar is open with a RunPod key; Afflatus's own updates
  const spending = useQuery({ queryKey: queryKeys.rentedSpending(), queryFn: ({ signal }) => api.rentedSpending({ signal }), enabled: open && Boolean(settings.data?.hasRunpodKey), staleTime: 60_000 }).data?.spending ?? null;
  const updates = useUpdates().data ?? null;
  const n = settings.data?.notify;
  const telegram = Boolean(n?.hasTelegramToken && n.telegramChat);
  const discord = Boolean(n?.hasDiscordWebhook);
  const lookups = Boolean(settings.data?.civitaiLookups);
  // the sign-in, read once by its gate (Gate.tsx): Sign out and Sign out everywhere follow it
  const session = useQuery({ queryKey: queryKeys.session(), queryFn: () => api.session(), staleTime: Infinity }).data;
  const locked = Boolean(session?.locked);
  const inSession = Boolean(session?.session);
  // what the command rows say of the moment (commandRows.ts); the commands offered with it, those that apply now
  // what `> picked` and `> get missing files` say: the files picked, and the open form's missing ones (its recipe's status)
  const pickedCount = usePickedCount();
  const pickedFiles = useMemo(() => ({ count: pickedCount, bytes: pickedNow().reduce((n, f) => n + (f.size ?? 0), 0) }), [pickedCount]);
  const formRecipe = useFormTarget((t) => t.target?.recipe ?? null);
  const setup = useSetup().data;
  const missing = useMemo(() => {
    const st = formRecipe ? setup?.recipes.find((r) => r.id === formRecipe.id) : undefined;
    return formRecipe && st ? { recipe: formRecipe.title, files: st.missing.length } : null;
  }, [formRecipe, setup]);
  const commandCtx: CommandCtx = useMemo(
    () => ({ aim, queue: queueNow ?? null, selectedClip, bannerUndo, editorUndo, binEmpty, binSaid, spending, updates, channels: { telegram, discord }, lookups, picked: pickedFiles, missing, access: session ? { locked, session: inSession } : null }),
    [aim, queueNow, selectedClip, bannerUndo, editorUndo, binEmpty, binSaid, spending, updates, telegram, discord, lookups, pickedFiles, missing, session, locked, inSession],
  );
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
  const estimateSaid = estimated ? [estimated.ms !== null && `${aboutMs(estimated.ms)}, learned from ${plural(estimated.basis, "render")}`, estimated.ahead ? `after ${plural(estimated.ahead, "job")}` : "nothing before it"].filter(Boolean).join(" · ") : "";

  // the render search: keys typed anywhere in plain search (search.ts), as rows (searchRows.ts)
  const familyWords = useMemo(() => (familyList ?? []).map((f) => f.id), [familyList]);
  // Civitai or Hugging Face searched (`civitai: …`, `hf: …`, browseSearch.ts): read before the render search, whose keys it shares
  const browsing = open && mode === "all" && /(^|\s)(civitai|hf|huggingface):/i.test(line);
  const browseBases = useQuery({ queryKey: queryKeys.browse.bases(), queryFn: ({ signal }) => api.browseBases({ signal }), enabled: browsing, staleTime: 10 * 60_000 }).data;
  const browseFamilies = browseBases?.families ?? NO_BROWSE_FAMILIES;
  const browse = useMemo(() => (browsing ? parseBrowse(line, browseFamilies) : null), [browsing, line, browseFamilies]);
  const sParsed = useMemo(() => (open && mode === "all" && !browse ? parseSearch(line, familyWords) : null), [open, mode, line, familyWords, browse]);
  const typingKey = sParsed?.typing && "key" in sParsed.typing ? sParsed.typing : null;
  // a model's name among plain words ("red bicycle klein"): that model's renders with the words, above what the words find as before
  const guessing = Boolean(sParsed && !isRenderSearch(sParsed) && !typingKey && sParsed.words && sParsed.tokens.length);
  const searching = Boolean(sParsed && (isRenderSearch(sParsed) || typingKey || guessing));
  const used = useQuery({ queryKey: queryKeys.facets.models(), queryFn: api.assetModels, enabled: searching, staleTime: 60_000 }).data;
  const drafts = useMemo(() => base.filter((i) => i.kind === "draft"), [base]);
  const places = useMemo(() => base.filter((i) => i.kind === "project" || i.kind === "folder"), [base]);
  const familyInfo = familyList ?? NO_FAMILIES;
  const searchFilter = useMemo(() => (sParsed && searching ? filterOf({ parsed: sParsed, used, families: familyInfo, drafts, places }) : null), [sParsed, searching, used, familyInfo, drafts, places]);
  // what the keys find: asked of the library a moment after the typing stops, not while a key's value is being chosen
  const asking = searchFilter && !typingKey && !searchFilter.missing.length ? searchFilter.filter : null;
  const askFor = useDebounced(asking, 120, true, null);
  const found = useQuery({ queryKey: queryKeys.assets.barSearch(askFor), queryFn: ({ signal }) => api.assets({ ...askFor!, limit: 30 }, { signal }), enabled: Boolean(askFor), placeholderData: keepPreviousData, staleTime: 15_000 });
  const count = useQuery({ queryKey: queryKeys.assets.barCount(askFor), queryFn: ({ signal }) => api.assetCount(askFor!, { signal }), enabled: Boolean(askFor), placeholderData: keepPreviousData, staleTime: 15_000 });
  // nothing found: how many each key's absence would find (board 4), a count each
  const loose = useMemo(() => (sParsed && askFor && found.data && !found.data.items.length ? loosened({ parsed: sParsed, used, families: familyInfo, drafts, places }) : []), [sParsed, askFor, found.data, used, familyInfo, drafts, places]);
  const loosen = useQuery({
    queryKey: queryKeys.assets.barLoosen(loose.map((l) => l.filter)),
    queryFn: async ({ signal }) => Promise.all(loose.map(async (l) => ({ token: l.token, count: (await api.assetCount(l.filter, { signal })).count }))),
    enabled: loose.length > 0, staleTime: 15_000,
  });
  const promptWords = typingKey?.key === "prompt" ? typingKey.value : sParsed?.tokens.find((t) => t.key === "prompt")?.value ?? null;
  const promptQ = useDebounced(promptWords ?? "", 150, promptWords !== null, "");
  const prompts = useQuery({ queryKey: queryKeys.promptHistory.search(promptQ), queryFn: ({ signal }) => api.promptHistory(promptQ, 20, { signal }), enabled: open && promptWords !== null, placeholderData: keepPreviousData }).data?.items ?? NO_HISTORY;
  const placeOf = useMemo(() => {
    const folders = new Map(places.filter((p) => p.entry?.kind === "folder").map((p) => [p.entry!.id, p]));
    const projects = new Map(places.filter((p) => p.entry?.kind === "project").map((p) => [p.entry!.id, p.label]));
    return (a: { folderId: string | null }) => {
      const f = a.folderId ? folders.get(a.folderId) : undefined;
      const project = f?.entry?.kind === "folder" ? f.entry.project : null;
      return f ? `${project ? `${projects.get(project) ?? "a project"} › ` : ""}${f.label}` : "";
    };
  }, [places]);

  // Civitai and Hugging Face (modelRows.ts): a pasted link read into its files, with lookups on; newer versions of the
  // LoRAs and models a value row names; the model downloads in `!`
  const linkTyped = open && mode === "all" && isLink(line) ? line.trim() : null;
  const siteAsk = useMemo(() => (browse && !browse.typing ? siteQuery(browse, browseFamilies) : null), [browse, browseFamilies]);
  const siteAsked = useDebounced(siteAsk, 300, true, null);
  const siteCards = useQuery({
    queryKey: siteAsked?.site === "civitai" ? queryKeys.browse.civitai({ bar: siteAsked }) : queryKeys.browse.huggingFace({ bar: siteAsked }),
    queryFn: ({ signal }) => (siteAsked!.site === "civitai" ? api.browseCivitai(siteAsked as Extract<typeof siteAsked, { site: "civitai" }>, { signal }) : api.browseHuggingFace(siteAsked as Extract<typeof siteAsked, { site: "huggingface" }>, { signal })),
    enabled: lookups && Boolean(siteAsked) && (siteAsked?.site !== "civitai" || Boolean(browseBases)), staleTime: 5 * 60_000, placeholderData: keepPreviousData, retry: false,
  });
  const linkQ = useDebounced(linkTyped ?? "", 200, Boolean(linkTyped), "");
  const card = useQuery({ queryKey: queryKeys.browse.link(linkQ), queryFn: () => api.browseLink(linkQ), enabled: lookups && Boolean(linkQ) && linkQ === linkTyped, staleTime: 5 * 60_000, retry: false });
  const modelUpdates = useQuery({ queryKey: queryKeys.modelUpdates(), queryFn: api.modelUpdates, enabled: searching && lookups, staleTime: 5 * 60_000 }).data;
  const newer = useMemo(() => {
    const by = new Map((modelUpdates?.items ?? []).filter((u) => u.newer).map((u) => [nameOf(u.file), u]));
    return (file: string) => by.get(nameOf(file));
  }, [modelUpdates]);
  const downloadList = useQuery({ queryKey: queryKeys.downloads(), queryFn: ({ signal }) => api.downloads({ signal }), enabled: open && mode === "queue" }).data?.items;
  const queueNames = useQueueOf((q) => (open && mode === "queue" ? q.machines : null));

  const sections: Section[] = useMemo(() => {
    if (!open) return [];
    if (browse) {
      if (!lookups) return [{ group: "Model link", rows: [lookupsOff] }];
      if (browse.typing) return browseValueRows(line, browse, browseFamilies);
      const out = browseRows(browse, siteCards.data?.items.slice(0, 20), browseFamilies);
      if (siteCards.error) out[0]!.rows.splice(1, 0, { key: "find-error", kind: "command", label: `${browse.site === "civitai" ? "Civitai" : "Hugging Face"} did not answer`, meta: siteCards.error instanceof Error ? siteCards.error.message : "", group: "Filters", verb: "—", p: prepare("error") });
      return out;
    }
    if (linkTyped) {
      if (!lookups) return [{ group: "Model link", rows: [lookupsOff] }];
      if (card.data && linkQ === linkTyped) return [{ group: "Model link", rows: linkRows(card.data.card) }];
      const said = card.error ? (card.error instanceof Error ? card.error.message : "It reads as no model.") : "Reading the link…";
      return [{ group: "Model link", rows: [{ key: "link:none", kind: "command", label: card.error ? "Not a model this bar can read" : said, meta: card.error ? said : "Civitai or Hugging Face asked", group: "Model link", verb: "wait", p: prepare(said) }] }];
    }
    if (sParsed && searchFilter && !guessing) {
      const d: SearchData = { line, parsed: sParsed, used, families: familyInfo, drafts, places, prompts, found: found.data?.items, count: count.data?.count, loosen: loosen.data, placeOf, newer };
      // a key's value being typed: its values; else what the keys find (and, with prompt:, the prompts that hold its words)
      // (a value that fits none of them: what the line finds as it stands, which says the name finds nothing)
      const values = typingKey ? valueRows(d, typingKey.key, typingKey.value).filter((s) => s.rows.length) : [];
      if (values.length) return values;
      const out = resultSections(d, searchFilter.missing, searchFilter.unsupported);
      if (sParsed.tokens.some((t) => t.key === "prompt" && t.value) && prompts.length) out.push({ group: "Prompts", rows: promptRows(prompts) });
      const begun = sParsed.typing && "prefix" in sParsed.typing ? sParsed.typing.prefix : null;
      if (begun) out.unshift({ group: "Filters", rows: keyRows(line, begun) });
      return out.filter((s) => s.rows.length || s.group.startsWith("No render"));
    }
    if (mode === "queue" && downloadList?.length) {
      const named = (id: string) => queueNames?.find((m) => m.id === id)?.name || null;
      const queueRows = rowsFor(mode, {
        text, base, byKey, templates, settingRows, navRows, command: commandCtx, learn, ranks, now: Date.now(), parsed, estimateSaid,
        recipes, recipeItems, presetItems, familyOn: (f) => families.isOn(f), grid: gridOf(recipes, undefined), queue: queueFull ?? null,
        keysHere, barKey, entities: entities.data?.items ?? [], castTo: castPlace(selectedClip).detail,
      });
      const loads = downloadRows(downloadList, named);
      const shown = text ? search(loads, text, 30).map((x) => x.item) : loads;
      // the downloads after the jobs, before what is done to the whole queue
      return shown.length ? [...queueRows.filter((s) => s.group === "Queue"), { group: "Downloads", rows: shown }, ...queueRows.filter((s) => s.group !== "Queue")] : queueRows;
    }
    const rows = rowsFor(mode, {
      text, base, byKey, templates, settingRows, navRows, command: commandCtx, learn, ranks, now: Date.now(), parsed, estimateSaid,
      recipes, recipeItems, presetItems, familyOn: (f) => families.isOn(f), grid: gridOf(recipes, undefined), queue: queueFull ?? null,
      keysHere, barKey, entities: entities.data?.items ?? [], castTo: castPlace(selectedClip).detail,
    });
    // a key's name begun ("lo"): the keys it fits, above what else the words find
    const prefix = sParsed?.typing && "prefix" in sParsed.typing ? sParsed.typing.prefix : null;
    if (guessing && sParsed && found.data?.items.length) {
      const d: SearchData = { line, parsed: sParsed, used, families: familyInfo, drafts, places, prompts, found: found.data.items, count: count.data?.count, loosen: undefined, placeOf };
      return [...resultSections(d, [], []), ...rows.filter((s) => s.group !== "Renders")];
    }
    return prefix ? [{ group: "Filters", rows: keyRows(line, prefix) }, ...rows] : rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the rows are worked out from what they show; the helpers read here are new at every render
  }, [open, mode, text, base, ranks, learn, queueFull, settingRows, estimateSaid, entities.data, recipeItems, presetItems, navRows, selectedClip, keysHere, barKey, templates, commandCtx, sParsed, searchFilter, typingKey, guessing, line, browse, browseFamilies, siteCards.data, siteCards.error, linkTyped, linkQ, lookups, card.data, card.error, newer, downloadList, queueNames, used, familyInfo, drafts, places, prompts, found.data, count.data, loosen.data, placeOf]);
  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);

  // the search's tokens as chips in the input: a key, a guessed model, a key left out, one that names nothing
  const chips = useMemo((): Chip[] => {
    if (!sParsed || !(searching || sParsed.tokens.length)) return [];
    const off = new Set([...(searchFilter?.missing ?? []), ...(searchFilter?.unsupported ?? [])]);
    return sParsed.tokens.map((t) => ({ start: t.start, end: t.end, tone: off.has(t) ? "off" : t.guessed ? "guessed" : t.not ? "out" : "key" }));
  }, [sParsed, searching, searchFilter]);
  return { index, recipes, settingCtx, bar, aim, estimated, sections, flat, chips };
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
