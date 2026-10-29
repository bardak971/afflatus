import { plural } from "@afflatus/core";
import { z } from "zod";
import { withoutPaths } from "./downloads";
import { httpError, notFound } from "./errors";
import { scrubbed, secretsOf } from "./logScrub";
import { machineName } from "./mcpForms";
import { quoted, Rich, tool } from "./mcpTool";
import { findWords, folderOf, known, lookUpPage, nameOf, setOwnWords, wordsOf } from "./modelPages";
import { promptHistory } from "./promptHistory";
import { bootLogText, volumesOf } from "./rented-api";
import { list as rendersList, summary as rendersSummary } from "./rendersRead";
import type { Services } from "./services";
import { readSettings, type Machine } from "./settings";
import { comfyLogs, promptOfParts } from "./setup-api";
import { checkPrompt, loadTagsSoon } from "./tags";

/**
 * What an agent reads to find out why something went wrong, and what it looks up as it writes (card #151): ComfyUI's log, a
 * pod's boot log, a running job's stages and live preview, the render times, the network volumes, a model file's page and
 * the words that call it up, the prompts rendered before, the Danbooru tag check and the prompt a form writes from its parts.
 * Each goes through the route the page reads (the bodies pulled out of them). A log never says a secret nor a folder on a
 * disk (logScrub.ts).
 */

/** A machine by id or name, from the settings; left out, the first one. Refused with the ids there are when there is none. */
async function machineAsked(s: Services, asked: string | undefined): Promise<Machine> {
  const all = (await readSettings(s.db)).machines;
  const m = asked === undefined ? all[0] : all.find((x) => x.id === asked) ?? all.find((x) => x.name.toLowerCase() === asked.toLowerCase());
  if (!m) throw httpError(asked === undefined ? "No machine is set up." : `There is no machine called ${quoted(asked)}: the machines are ${all.map((x) => `${x.id} (${machineName(x)})`).join(", ")}.`, 404);
  return m;
}

/** Lines of a log as an agent reads them: scrubbed, the last `last`, those holding `find` (any case) when asked. */
function linesOf<L extends { t: string; m: string }>(lines: L[], secrets: readonly string[], o: { last: number; find?: string }): Array<{ t: string; m: string }> {
  const find = o.find?.toLowerCase();
  const clean = lines.map((l) => ({ t: l.t, m: scrubbed(l.m, secrets) }));
  // looked for in the scrubbed line: a word of a secret finds nothing
  return (find ? clean.filter((l) => l.m.toLowerCase().includes(find)) : clean).slice(-o.last);
}

const lastInput = z.number().int().min(1).max(1000).default(200).describe("How many lines, the newest; 200 when left out.");
const findInput = z.string().min(1).max(200).optional().describe("Only the lines holding these words (any case): \"error\", \"Traceback\", a node's name.");

const comfyLog = tool({
  name: "comfy_log",
  scope: "look",
  title: "ComfyUI's log",
  description: "ComfyUI's terminal log on a machine, as the Queue page's log tab shows it: its last lines, newest last (a Traceback, a node that failed, a model that did not load, out of memory). A rented pod whose ComfyUI is not up yet gives its boot log instead (`source`). Secrets and folders on a disk are taken out: a key shows as [hidden], a path as its file's name. `since`: a line's stamp, for what came after it.",
  input: {
    machine: z.string().max(80).optional().describe("A machine's id or name (list_machines); left out, the first machine."),
    last: lastInput,
    find: findInput,
    since: z.string().max(64).optional().describe("A line's `t`, as an answer gave it: the lines from then on."),
  },
  async run(a, ctx) {
    const { s } = ctx;
    const m = await machineAsked(s, a.machine);
    const settings = await readSettings(s.db);
    const got = await comfyLogs(s, { machine: m.id, ...(a.since ? { since: a.since, of: "comfy" as const } : {}) });
    const lines = linesOf(got.lines, secretsOf(settings), { last: a.last, find: a.find });
    ctx.said(`Read ${quoted(machineName(m))}'s ${got.source === "boot" ? "boot log" : "ComfyUI log"}: ${plural(lines.length, "line")}`);
    return { machine: m.id, source: got.source === "boot" ? "the pod's boot log (its ComfyUI is not up)" : "ComfyUI", lines };
  },
});

const bootLog = tool({
  name: "boot_log",
  scope: "look",
  title: "A pod's boot log",
  description: "A rented pod's boot (its image's pull, node packs, ComfyUI's start): `machine`, the boot log of a pod now, read from it; `run`, the boot log kept of a past run (Settings › Rented GPUs › Boot logs keeps them some days); neither, the runs whose boot log is kept, newest first. Secrets and folders on a disk are taken out.",
  input: {
    machine: z.string().max(80).optional().describe("A rented machine's id or name: its pod's boot log now."),
    run: z.string().max(40).optional().describe("A run's id, as the list gives it: the boot log kept of it."),
    last: lastInput,
    find: findInput,
  },
  async run(a, ctx) {
    const { s } = ctx;
    const secrets = secretsOf(await readSettings(s.db));
    if (a.machine !== undefined) {
      const m = await machineAsked(s, a.machine);
      const got = await s.rented.bootLines(m.id);
      if (!got) throw httpError(`${machineName(m)} is not a rented pod: it has no boot log. comfy_log reads its ComfyUI's log.`);
      const lines = linesOf(got.lines, secrets, { last: a.last, find: a.find });
      ctx.said(`Read ${quoted(machineName(m))}'s boot log: ${plural(lines.length, "line")}`);
      return { machine: m.id, lines };
    }
    if (a.run !== undefined) {
      const text = await bootLogText(s, a.run);
      if (text === null) throw notFound("a boot log kept for that run");
      const lines = linesOf(text.split("\n").map((m) => ({ t: "", m })), secrets, { last: a.last, find: a.find }).map((l) => l.m);
      ctx.said(`Read a pod's boot log kept: ${plural(lines.length, "line")}`);
      return { run: a.run, lines };
    }
    const runs = await s.db.selectFrom("rent_sessions").select(["id", "machine_id", "gpu", "started_at", "ended_at", "end_why", "start_failed"])
      .where("boot_log", "is not", null).orderBy("started_at", "desc").limit(50).execute();
    const days = (await readSettings(s.db)).bootLogDays;
    ctx.said(`Listed the boot logs kept: ${runs.length}`);
    return {
      keptDays: days,
      runs: runs.map((r) => ({ run: r.id, machine: r.machine_id, gpu: r.gpu, started: r.started_at, ended: r.ended_at, ...(r.end_why ? { endedBy: r.end_why } : {}), ...(r.start_failed ? { startFailedAt: r.start_failed } : {}) })),
      ...(runs.length ? {} : { said: days > 0 ? "No boot log is kept yet: one is kept from a pod's next boot." : "Boot logs are not kept: Settings › Rented GPUs › Boot logs." }),
    };
  },
});

const jobLive = tool({
  name: "job_live",
  scope: "look",
  title: "A running job, live",
  description: "A running job as the Queue page shows it while it renders: its phase, step and time left, the pictures its workflow showed on the way (its Preview nodes, as `stages`), and its latest live preview as a picture. `stage`: that stage's picture instead. Only while it runs: job says the rest.",
  input: {
    job: z.string().max(64).optional().describe("A job's id (queue_status); left out, the one running (the first, with several machines)."),
    stage: z.number().int().min(0).max(99).optional().describe("A stage's `n`, as `stages` lists them: its picture."),
  },
  async run(a, ctx) {
    const { s } = ctx;
    const now = await s.queue.progress();
    const all = now?.all ?? [];
    const run = a.job ? all.find((r) => r.id === a.job) : all[0];
    if (!run) throw httpError(a.job ? "That job is not running: job says where it is." : "Nothing is rendering now.", 404);
    const figures = {
      job: run.id, machine: run.machine, phase: run.phase,
      ...(run.steps ? { step: run.step, steps: run.steps } : {}),
      progress: Math.round(run.progress * 100) / 100, leftSeconds: run.eta || null,
      stages: run.stages.map((st) => ({ n: st.n, title: st.title ?? `node ${st.node}`, files: st.count })),
    };
    if (a.stage !== undefined) {
      const p = await s.queue.stage(run.id, a.stage);
      if (!p) throw httpError(`It has no stage ${a.stage} to show now: ${run.stages.length ? `its stages are 0 to ${run.stages.length - 1}` : "it has shown none yet"}.`, 404);
      if (!p.mime.startsWith("image/")) throw httpError("That stage is a video, which is shown once the job is done: view_item shows what it made.");
      ctx.said(`Looked at stage ${a.stage} of a running job`);
      return new Rich([{ type: "text", text: JSON.stringify(figures) }, { type: "image", data: Buffer.from(p.bytes).toString("base64"), mimeType: p.mime }]);
    }
    const p = await s.queue.preview(run.id);
    ctx.said(`Looked at a running job${p ? " and its live preview" : ""}`);
    const said = { ...figures, preview: p ? "the picture below" : "none yet (ComfyUI sends one once sampling starts, when its previews are on)" };
    return new Rich([{ type: "text", text: JSON.stringify(said) }, ...(p ? [{ type: "image" as const, data: Buffer.from(p.bytes).toString("base64"), mimeType: p.mime }] : [])]);
  },
});

const renderStats = tool({
  name: "render_stats",
  scope: "look",
  title: "Render times",
  description: "The Queue › Render times tab: over a period (day, week, month, all) or a window, the renders done, failed and cancelled, GPU time, loads, waits, each machine's renders and pace (1 the common pace, 2 half as fast) and each model's figures. `renders`: the renders themselves instead, newest first (each its model, machine, times and status), `trouble` for the failed and cancelled only. What a form will take is estimate's.",
  input: {
    period: z.enum(["day", "week", "month", "all"]).default("week"),
    from: z.string().datetime().optional().describe("A window's start (ISO), with `to`, in place of the period."),
    to: z.string().datetime().optional(),
    machine: z.string().max(80).optional().describe("One machine's id or name: its figures alone."),
    renders: z.boolean().default(false),
    trouble: z.boolean().default(false),
    model: z.string().max(200).optional().describe("With `renders`: one form's renders (its id, as list_forms gives it)."),
    limit: z.number().int().min(1).max(200).default(50),
  },
  async run(a, ctx) {
    const { s } = ctx;
    const machine = a.machine === undefined ? null : (await machineAsked(s, a.machine)).id;
    const from = a.from ? Date.parse(a.from) : undefined;
    const to = a.to ? Date.parse(a.to) : undefined;
    const window = from !== undefined && to !== undefined && to > from ? { from, to } : null;
    if ((a.from || a.to) && !window) throw httpError("A window needs both `from` and `to`, `to` after `from`.");
    if (a.renders) {
      const got = await rendersList(s.db, s.registry, { recipe: a.model, trouble: a.trouble, limit: a.limit, from, to, machine: machine ?? undefined });
      ctx.said(`Read the render times: ${plural(got.items.length, "render")}`);
      return got;
    }
    const keep = (await readSettings(s.db)).renderHistoryDays;
    const sum = await rendersSummary(s.db, s.registry, window ?? a.period, keep, Date.now(), machine, () => s.queue.paces());
    ctx.said(`Read the render times over ${window ? "a window" : `the ${a.period}`}`);
    // the charts' series left out: the page draws them, an agent reads the figures
    const { times: _t, step: _s, buckets: _b, finished: _f, phases: _p, wait: _w, gpu: _g, ...figures } = sum;
    return figures;
  },
});

const networkVolumes = tool({
  name: "network_volumes",
  scope: "look",
  title: "Network volumes",
  description: "The RunPod account's network volumes (Settings › Rented GPUs): each one's size, data center, monthly price, the pod running on it now if any, and each Model set as the volume held it the last time a pod ran there (all there, or what it lacks). Read only: a volume is made, grown or deleted in Afflatus.",
  async run(_a, ctx) {
    const { s } = ctx;
    if (!(await readSettings(s.db)).runpodKey) throw httpError("No RunPod API key is set: Settings › Rented GPUs in Afflatus.");
    const volumes = await volumesOf(s);
    ctx.said(`Listed the network volumes: ${volumes.length}`);
    return { volumes };
  },
});

const modelUpdates = tool({
  name: "model_updates",
  scope: "look",
  title: "Model hashes and updates",
  description: "Settings › Models › Your models online: how far the hashing of this PC's model files is and what the sites matched (Civitai, Hugging Face, neither), and the update check's last report: each file matched to its Civitai version, with the newer version and its page when there is one. Read only: the checks run in Afflatus (daily when ticked).",
  async run(_a, ctx) {
    const { s } = ctx;
    const [hashes, report] = await Promise.all([s.hashes.status(), s.updates.report()]);
    const newer = report.items.filter((i) => i.newer);
    ctx.said(`Looked at the model updates: ${plural(newer.length, "newer version")}`);
    return {
      hashes: { ...hashes, error: hashes.error && withoutPaths(hashes.error) },
      updates: { ...report, error: report.error && withoutPaths(report.error), newer: newer.length },
    };
  },
});

// ---------------------------------------------------------------- a model file's page and words

const modelFolder = z.string().regex(/^[\w-]{1,64}$/).describe("The ComfyUI model folder: loras, checkpoints, diffusion_models…");
const modelFile = z.string().min(1).max(500).describe("The file, as list_models lists it.");

const modelPage = tool({
  name: "model_page",
  scope: "look",
  title: "A model's page and trigger words",
  description: "What is known of a model file (a LoRA most often): what its header says (its title, base model, trained-on, its author's trigger words, the caption tags it was trained with, most used first), its page on Civitai or Hugging Face, and the words that call it up beyond the file: the user's own (which come first in Afflatus) and those Civitai gave. `find`: look its page and trigger words up on Civitai and Hugging Face now (Search Hugging Face and Civitai on in Settings › Models), as the page's Find does.",
  input: { folder: modelFolder, file: modelFile, find: z.boolean().default(false) },
  async run(a, ctx) {
    const { s } = ctx;
    const folder = folderOf(a.folder);
    const name = nameOf(a.file);
    const rows = await s.db.selectFrom("model_info").select(["file", "info"]).where("folder", "=", folder).execute();
    const row = rows.find((r) => r.file === a.file) ?? rows.find((r) => nameOf(r.file) === name);
    const { v: _v, ...header } = row ? (JSON.parse(row.info) as Record<string, unknown>) : {};
    let page: { page: unknown; candidates?: unknown[]; lookups?: boolean } = { page: await known(s.db, folder, name) };
    let looked: boolean | null = null;
    if (a.find) {
      page = await lookUpPage(s.db, folder, a.file);
      looked = (await findWords(s, folder, [row?.file ?? a.file])).lookups;
    }
    const words = (await wordsOf(s.db, folder, [name]))[name] ?? { own: null, found: null };
    ctx.said(`Looked at ${quoted(a.file)}'s page and words`);
    return {
      folder, file: row?.file ?? a.file,
      header: row ? header : null,
      ...(row ? {} : { headerSaid: "Not read yet: Afflatus reads a file's header once list_models or the page lists its folder." }),
      page: page.page, ...(page.candidates?.length ? { candidates: page.candidates } : {}),
      words: { yours: words.own, civitai: words.found },
      ...(looked === false ? { lookups: "Search Hugging Face and Civitai is off in Settings › Models: nothing was looked up." } : {}),
    };
  },
});

const setModelWords = tool({
  name: "set_model_words",
  scope: "manage",
  title: "Set a model's own words",
  description: "The user's own words for a model file (its trigger words as they want them), which come before the file's and Civitai's wherever Afflatus offers them (a LoRA added to a prompt, the command bar). Empty or null takes them away again. Kept by the file's name, whatever sub-folder it moves to.",
  input: { folder: modelFolder, file: modelFile, words: z.string().max(600).nullable() },
  async run(a, ctx) {
    const folder = folderOf(a.folder);
    const name = nameOf(a.file);
    const now = (await setOwnWords(ctx.s.db, folder, a.file, a.words))[name];
    ctx.said(now?.own ? `Set ${quoted(a.file)}'s own words: ${quoted(now.own)}` : `Took ${quoted(a.file)}'s own words away`);
    // the page's lists of words read again
    ctx.s.queue.events.emit("models");
    return { folder, file: a.file, words: { yours: now?.own ?? null, civitai: now?.found ?? null } };
  },
});

// ---------------------------------------------------------------- prompts

const promptHistoryTool = tool({
  name: "prompt_history",
  scope: "look",
  title: "Prompts rendered before",
  description: "The prompts that were rendered, each once, newest first, as the command bar's \" finds them: its form, the draft it was sent from, a library item it made still there (view_item shows it), the timeline clip that item is a take of. `q`: those holding these words. Reads the newest 5000 renders.",
  input: { q: z.string().max(200).optional(), limit: z.number().int().min(1).max(200).default(30) },
  async run(a, ctx) {
    const got = await promptHistory(ctx.s, { q: a.q, limit: a.limit });
    ctx.said(`Read the prompts rendered${a.q ? ` holding ${quoted(a.q)}` : ""}: ${got.items.length}`);
    return { prompts: got.items.map(({ assetId, draftId, recipe, ...p }) => ({ ...p, form: recipe, draft: draftId, item: assetId })) };
  },
});

const checkTags = tool({
  name: "check_tags",
  scope: "look",
  title: "Check Danbooru tags",
  description: "The prompt's tags that are not Danbooru tags, as the form's tag check underlines them (for the anime checkpoints, Illustrious, NoobAI, Pony): each said an alias (another name of a real tag) or unknown, with the tag to write instead when there is one. Run on this computer: nothing leaves it. `ignore`: tags to let through.",
  input: { text: z.string().max(20_000), ignore: z.array(z.string().max(400)).max(200).default([]) },
  async run(a, ctx) {
    await loadTagsSoon();
    const issues = checkPrompt(a.text, a.ignore);
    ctx.said(`Checked a prompt's tags: ${plural(issues.length, "issue")}`);
    return { issues };
  },
});

const promptFromParts = tool({
  name: "prompt_from_parts",
  scope: "look",
  title: "The prompt from a form's parts",
  description: "The prompt a form written in parts (subject, action, place, look… as describe_form lists them) sends while its prompt is left empty: written by the form's own rules, the Prompt kit's @people said as the render says them, as the form shows it. `into`: the input it goes into; null for a form without parts.",
  input: {
    form: z.string().min(1).max(200).describe("A form's id (list_forms)."),
    values: z.record(z.string(), z.unknown()).describe("The form's values, the parts among them."),
  },
  async run(a, ctx) {
    if (!ctx.s.registry.recipe(a.form)) throw httpError(`There is no form called ${quoted(a.form)}: list_forms names them.`, 404);
    const got = await promptOfParts(ctx.s, a.form, a.values);
    ctx.said(`Wrote ${quoted(a.form)}'s prompt from its parts`);
    return got.into ? got : { into: null, text: "", said: "This form has no parts: its prompt is written whole." };
  },
});

export const DIAGNOSTIC_TOOLS = [comfyLog, bootLog, jobLive, renderStats, networkVolumes];
export const MODEL_PAGE_TOOLS = [modelPage, setModelWords, modelUpdates];
export const PROMPT_TOOLS = [promptHistoryTool, checkTags, promptFromParts];
