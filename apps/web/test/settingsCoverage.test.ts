import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAGES, SETTINGS } from "../src/bar/settingsRegistry";
import { INDEX, spotOf } from "../src/screens/settings/settingsIndex";

/**
 * Every setting is found: each field of the server's settings and each thing this browser keeps is either a row of the
 * settings index (what Settings' search and the command bar's `/` read), or named here as state the app keeps for itself,
 * with why. A new setting with neither fails here, before it ships unfindable.
 */

const src = fileURLToPath(new URL("../src", import.meta.url));
const read = (path: string) => readFileSync(join(src, path), "utf-8");
const files = (dir: string): string[] =>
  readdirSync(join(src, dir)).flatMap((f) => {
    const path = join(dir, f);
    return statSync(join(src, path)).isDirectory() ? files(path) : /\.tsx?$/.test(f) ? [path] : [];
  });

/** The server's settings, by field: the index key of the row that sets it, or why it has none. */
const SERVER: Record<string, string> = {
  machines: "comfy.machines",
  comfyUrl: "comfy.url",
  comfyDir: "comfy.folder",
  unloadAfterMinutes: "comfy.unload",
  llm: "designer.llms",
  llms: "designer.llms",
  designerLlm: "internal: the LLM picked in the designer's panel, remembered for the next conversation",
  designerInstructions: "designer.notes",
  designerGuides: "prompts.guides",
  designerInstruction: "internal: the system prompt picked in the designer's panel, remembered for the next conversation",
  tagCheck: "server.tagCheck",
  families: "models.families",
  allFamilies: "models.families",
  firstLaunch: "internal: the first launch's page, shown once and then done or skipped (Settings › ComfyUI brings it back)",
  hasCivitaiKey: "models.civitaiKey",
  hasHuggingFaceToken: "models.huggingFaceToken",
  hasRunpodKey: "comfy.runpod",
  runpodS3User: "rented.s3",
  hasRunpodS3Secret: "rented.s3",
  rentCaps: "comfy.rentcaps",
  costs: "costs.kwh",
  volumeUnusedDays: "rented.unused",
  bootLogDays: "rented.bootlogs",
  lastDeploy: "internal: the Deploy dialog's last choices, its next defaults and what Deploy again repeats",
  machinesSetAside: "internal: not stored as a setting; the stored machines that could not be read, said above the machine cards in Settings › ComfyUI",
  finish: "internal: the Finish dialog's own choices, saved from it as the next time's defaults",
  slotFiles: "models.files",
  acceptedPresets: "internal: a preset's licence, accepted where the preset is applied",
  civitaiLookups: "server.civitaiLookups",
  downloadModels: "server.downloadModels",
  afflatusUpdateChecks: "about.updates",
  renderHistoryDays: "storage.renderTimes",
  jobHistoryDays: "storage.jobDays",
  unkeptDays: "storage.unkeptDays",
  binDays: "storage.binDays",
  updateChecks: "server.updateChecks",
  bar: "bar.shortcut",
  pinnedProjects: "internal: the rail's pins, set on the rail and in the Projects panel",
  pinnedFields: "interface.pins",
  notify: "notify.telegram",
  access: "access.password",
};

/** What this browser keeps (localStorage keys and zustand `persist` names): the index key, or why it has none. */
const BROWSER: Record<string, string> = {
  "afflatus.hover-play": "hover.video",
  "afflatus.compare-result": "compare.result",
  "afflatus.explain": "explain",
  "afflatus.notify": "notify.browser",
  "afflatus.theme": "interface.theme",
  "afflatus.bar.learn": "bar.learn",
  "afflatus.bar.preview": "bar.preview",
  "afflatus.bar.rank": "bar.forget",
  "afflatus.allFamiliesHint": "internal: Settings › Models' hint to turn every family on, closed for good",
  "afflatus.theme.paint": "internal: the theme's colours, painted before the app loads",
  "afflatus.attention-kept": "internal: Needs a look items kept by hand, per timeline",
  "afflatus.cut.crf": "internal: Trim's last quality, remembered where it is set",
  "afflatus.editor-column": "internal: the timeline editor's column width and fold",
  "afflatus.form.parts": "internal: which parts of a form are open",
  "afflatus.grid-shapes": "internal: the shapes each library list had last time, for its loading placeholders",
  "afflatus.kit.categories": "internal: the Prompt kit's open snippet categories",
  "afflatus.kit.tab": "internal: the Prompt kit's tab",
  "afflatus.last-timeline": "internal: the timeline last open, per project",
  "afflatus.live": "internal: not stored; the name of the lock and channel live events share between tabs",
  "afflatus.live-sound.2": "internal: the live preview's volume, set on it",
  "afflatus.media-open": "internal: the editor's media panel open",
  "afflatus.open-draft": "internal: the open draft",
  "afflatus.panel-width": "internal: the form panel's width, dragged by its edge",
  "afflatus.player.volume": "internal: the player's volume, set on it",
  "afflatus.project": "internal: the project worked in",
  "afflatus.projects.kind": "internal: the Projects panel's filter",
  "afflatus.projects.open": "internal: the Projects panel's open rows",
  "afflatus.draft-machine": "internal: the machine each draft generates on, set from Generate's machine slice",
  "afflatus.find-all": "internal: Find models' All of Civitai switch, remembered in this browser",
  "afflatus.picture-sets": "internal: the pictures made for each Motion transfer form (its photos of who goes in, Relight, the jobs), kept per draft or timeline source",
  "afflatus.projects.sort": "internal: the Projects panel's sort",
  "afflatus.reloaded-at": "internal: when the app last reloaded itself for a new version",
  "afflatus.seed-mode": "internal: the form's seed mode, set beside the seed",
  "afflatus.snippets.open": "internal: the snippet menu's open categories",
  "afflatus.studio": "internal: the Studio's view (form open, size, grouping, place)",
  "afflatus.timeline-aspects": "internal: each timeline's frame shape last seen, for the editor's loading placeholder",
  "afflatus.timeline.snapQuiet": "internal: the editor's range snapping, switched where it acts",
  "afflatus.timeline.takes": "internal: how many takes a clip's panel shows",
  "afflatus.volume": "internal: the viewer's volume, set on it",
  "afflatus.check.": "internal: a start-up check already said, per check",
  "afflatus.updates.seen": "internal: the new version About was last seen with, for the rail's dot",
  "afflatus.updates.security": "internal: the security fix whose banner was closed",
};

// a row's key, or one of the bar's ids the row stands for (`also`)
const covered = (v: string) => v.startsWith("internal: ") || Boolean(spotOf(v));

describe("settings coverage", () => {
  it("knows every field of the server's settings", () => {
    const body = /export interface Settings \{([\s\S]*?)\n\}/.exec(read("api/types/settings.ts"))![1]!;
    const fields = [...body.matchAll(/^\s*(?:\/\*\*.*?\*\/\s*)?(\w+)\??:/gm)].map((m) => m[1]!);
    expect(fields.length).toBeGreaterThan(15);
    expect(fields.filter((f) => !(f in SERVER))).toEqual([]);
    expect(Object.keys(SERVER).filter((f) => !fields.includes(f))).toEqual([]);
  });

  it("knows everything this browser keeps", () => {
    const keys = new Set<string>();
    for (const f of files(".")) for (const m of read(f).matchAll(/["'`](afflatus\.[\w.-]*?)(?:\$\{|["'`])/g)) keys.add(m[1]!);
    expect([...keys].filter((k) => !(k in BROWSER))).toEqual([]);
    expect(Object.keys(BROWSER).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("points only at rows of the index", () => {
    expect(Object.entries({ ...SERVER, ...BROWSER }).filter(([, v]) => !covered(v))).toEqual([]);
  });

  // Settings outlines the row carrying `data-setting="<key>"` (or its `near` one when it is not shown): a key no row carries
  // is a jump that lands nowhere
  it("has a row on the Settings screen for every entry of the index", () => {
    const anchors = new Set(files("screens/settings").flatMap((f) => [...read(f).matchAll(/(?:data-)?setting="([^"]+)"/g)].flatMap((m) => m[1]!.split(" "))));
    expect(INDEX.filter((i) => !anchors.has(i.key) && !(i.near && anchors.has(i.near))).map((i) => i.key)).toEqual([]);
    expect(INDEX.filter((i) => i.near && !anchors.has(i.near)).map((i) => i.key)).toEqual([]);
  });

  it("gives every setting the bar flips a row to open", () => {
    expect(SETTINGS.filter((s) => !spotOf(s.id)).map((s) => s.id)).toEqual([]);
    expect(new Set([...SETTINGS, ...PAGES].map((s) => s.id)).size).toBe(SETTINGS.length + PAGES.length);
  });
});
