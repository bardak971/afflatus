import { envSaid } from "./config";
import { httpError, notFound } from "./errors";
import type { FastifyInstance } from "fastify";
import { said } from "./forecast";
import { allowedHosts, fromThisComputer, hostAllowed } from "./hostCheck";
import { z } from "zod";
import { ComfyClient, ComfyLocked, plannedScan } from "@afflatus/comfy";
import { describeRecipe, listOptions, parseInput, type InputSpec } from "@afflatus/core";
import { withMentions } from "./entities";
import { mergeScans } from "./machineScans";
import { comfyFolderOf, onThisMachine, Refused } from "./modelDownload";
import { accessOf } from "./lock-api";
import { installNodePack } from "./nodePack";
import { preflight } from "./preflight";
import { ffmpegGetter } from "./ffmpegGet";
import { said as ffmpegSaid } from "./ffmpegCheck";
import { withMedia } from "./queueSubmit";
import type { Services } from "./services";
import { publicSettings, readSettings, writeSettings } from "./settings";

/** Afflatus itself and its ComfyUI: whether it is alive, what it can make, the settings, the setup scan, the log, and advice on a form. */

export function registerSetup(app: FastifyInstance, s: Services, version: string): void {
  /** Alive, the version, the database, and the start-up checks (the tools, the Node, the data folder) as they were last run. */
  const health = (checks: typeof preflight.last) => ({ ok: true, version, database: s.dbKind, checks: checks?.checks ?? [], checkedAt: checks?.at ?? null });
  // a probe asks by a name of its own (a pod's address) and is answered whatever the Host (hostCheck.ts ANY_HOST); so is a page
  // that pointed a name of its own at this machine, which is told only that the server is alive, not what it found on the machine
  const hosts = allowedHosts();
  // locked by a password (access.ts) and not signed in, only that it is alive too: the checks name the computer's folders
  app.get("/api/health", async (req) => (hostAllowed(req.headers.host, hosts) && (req.access.open || req.access.session) ? health(preflight.last) : { ok: true, version }));
  /** The start-up checks run again, now (Settings → About → Check again): every ffmpeg tried anew, none of the kept results used. */
  app.post("/api/health/check", async () => health(await preflight.run(undefined, { fresh: true })));

  /** Get ffmpeg (ffmpegGet.ts): how it is going. */
  app.get("/api/ffmpeg/get", async () => ffmpegGetter.view);
  /**
   * Get ffmpeg started: BtbN's build downloaded into the data folder, then the checks run again, which find it and use it. Not
   * when FFMPEG is set: theirs is never swapped for another, the check says to change it. Only from this computer, as Updates:
   * 185 MB written into the program's data folder is not for anyone who reaches the page. And not when the ffmpeg in use
   * passed: the page hides the button then, a request made anyway would only download one more.
   */
  app.post("/api/ffmpeg/get", async (req) => {
    if (!fromThisComputer(req)) throw httpError("Get ffmpeg is done on the computer Afflatus runs on, not from another one.", 403);
    if (envSaid.ffmpeg()?.trim()) throw httpError("FFMPEG is set: Afflatus uses that ffmpeg and no other. Point FFMPEG to a newer one, or take it out.", 409);
    const used = preflight.last?.ffmpeg.used;
    if (used?.ok) throw httpError(`${ffmpegSaid(used)} passed the checks: there is nothing to get.`, 409);
    try {
      return ffmpegGetter.start(preflight.dataDir, async () => {
        const p = await preflight.run(undefined, { fresh: true });
        const used = p.ffmpeg.used;
        return used?.ok && used.where === "got" ? null : `${p.checks.find((c) => c.id === "ffmpeg")?.detail ?? "ffmpeg was not checked"}`;
      });
    } catch (err) {
      if (err instanceof Refused) throw httpError(err.message, 400);
      throw err;
    }
  });

  /** Everything the composer can make things with, and the form of each. */
  app.get("/api/recipes", async () => ({ families: s.registry.families(), recipes: s.registry.recipes().map(describeRecipe) }));
  /** How large the families' official files are, by address: those known now, the others asked in the background with lookups on (officialSizes.ts). */
  app.get("/api/official-sizes", async () => s.officialSizes.sizes());

  /**
   * A ComfyUI asked at an address without saving it (the first launch, Settings' Find it): whether it answers, its version
   * and its GPU. `/find` asks the usual addresses in turn (envSaid.probeUrls) and says the first that answers.
   */
  const probe = async (url: string) => {
    try {
      const client = new ComfyClient(url);
      const st = await client.status();
      // its folder, when it runs here: Afflatus then writes its node pack in by itself
      const dir = await comfyFolderOf(client, url).catch(() => null);
      // on this PC or not: one here whose folder was not found is told to set it, not that it is on another computer
      return { url, online: true as const, version: st.version, device: st.device, locked: false, error: null, dir, local: onThisMachine(url) };
    } catch (e) {
      // locked against Afflatus: a ComfyUI is there, its token to paste once added
      return { url, online: false as const, version: null, device: null, locked: e instanceof ComfyLocked, error: e instanceof Error ? e.message : String(e), dir: null, local: onThisMachine(url) };
    }
  };
  app.post("/api/setup/probe", async (req) => probe(z.object({ url: z.string().trim().url().max(400).regex(/^https?:\/\//i, "an http(s) address") }).parse(req.body ?? {}).url.replace(/\/+$/, "")));
  app.get("/api/setup/find", async () => {
    const tried = (envSaid.probeUrls() ?? "http://127.0.0.1:8188,http://127.0.0.1:8000").split(",").map((u) => u.trim()).filter(Boolean);
    for (const url of tried) {
      const got = await probe(url);
      if (got.online || got.locked) return { found: got, tried };
    }
    return { found: null, tried };
  });

  app.get("/api/settings", async () => publicSettings(await readSettings(s.db), onThisMachine));
  app.put("/api/settings", async (req) => {
    // under the Access settings' rule (access.ts mayChange: a sign-in of the last 10 minutes, or the password in the
    // X-Afflatus-Password header): the new-device notice, which would hide a sign-in from elsewhere, and Telegram's bot and
    // chat, where reset codes and alarms go (a session taken over would point them at its own bot)
    const sent = req.body as { notify?: { events?: { newDevice?: unknown }; telegramToken?: unknown; telegramChat?: unknown } } | null;
    const ip = req.socket.remoteAddress ?? "";
    const telegram = sent?.notify?.telegramToken !== undefined || sent?.notify?.telegramChat !== undefined;
    if (sent?.notify?.events?.newDevice !== undefined || telegram) {
      // the page sends it URI-encoded: a header takes no character past U+00FF (a Cyrillic or emoji password threw there)
      const typed = req.headers["x-afflatus-password"];
      let password: string | undefined;
      try {
        password = typeof typed === "string" ? decodeURIComponent(typed) : undefined;
      } catch {
        password = typeof typed === "string" ? typed : undefined;
      }
      await s.access.mayChange(req.access.session, password, ip);
    }
    const before = (await readSettings(s.db)).notify;
    let saved = await writeSettings(s.db, req.body);
    if (telegram && (saved.notify.telegramToken !== before.telegramToken || saved.notify.telegramChat !== before.telegramChat)) await s.access.telegramChanged(before, ip);
    // a file chosen by hand for a family: what is ready is worked out again
    if (req.body && typeof req.body === "object" && "slotFiles" in req.body) for (const { comfy } of await s.machines()) comfy.forgetScan();
    // a family switched, on every machine or on one: what each machine may run changed (the queue looks again, the pages read it again)
    if (req.body && typeof req.body === "object" && ("families" in req.body || "machines" in req.body)) s.queue.events.emit("setup");
    // the user's ComfyUI given by its address alone (the first launch, Add): its folder found from what it says, when it
    // runs on this machine, so that the node pack goes in by itself (written in there too). Off now: looked for again once it answers
    const asked = req.body && typeof req.body === "object" && ("comfyUrl" in req.body || "machines" in req.body);
    const found = asked && !("comfyDir" in (req.body as object)) ? await s.comfyFolder() : null;
    if (found) saved = found;
    // ComfyUI's folder set: Afflatus's node pack goes into its custom_nodes (ComfyUI loads it at its next start)
    if (req.body && typeof req.body === "object" && "comfyDir" in req.body && saved.comfyDir.trim()) {
      await installNodePack(saved.comfyDir).catch((err: Error) => console.warn(`[node-pack] not written: ${err.message}`));
    }
    return publicSettings(saved, onThisMachine);
  });

  /**
   * What ComfyUI can do: the setup page, and what the composer offers. Read-only on ComfyUI. Each list of what an input
   * offers is sent once (core's listOptions), and each recipe names the ones it offers. `machine`: that ComfyUI's alone
   * (Settings › Models, its tab); without, what every machine together can do (machineScans.ts), with one the same.
   */
  const setupOf = async (machine: string | undefined, fresh: boolean) => {
    const all = await s.machines();
    if (machine) {
      const one = all.find((m) => m.machine.id === machine);
      if (!one) throw httpError("there is no ComfyUI with that id");
      return listOptions(await one.comfy.scan(fresh));
    }
    const scans = await Promise.all(all.map(async ({ machine: m, comfy }) => ({ machine: m, scan: await comfy.scan(fresh) })));
    // no ComfyUI of the user's own and no pod answering (a rented-only start, a new install before its first launch): what
    // a pod would offer, so that the forms work and their jobs wait for a GPU. One of their own that is off says it is off
    if (!scans.some((x) => x.scan.comfy.online) && !scans.some((x) => !x.machine.rented)) return listOptions(await plannedScan(s.registry.families(), s.registry.recipes()));
    return listOptions(mergeScans(scans, await readSettings(s.db), (id) => s.registry.recipe(id)?.family));
  };
  const machineQuery = z.object({ machine: z.string().max(40).optional() });
  app.get("/api/setup", async (req) => setupOf(machineQuery.parse(req.query).machine, false));
  /** The same, asked of ComfyUI afresh rather than from what was learned a moment ago ("Test" in Settings). */
  app.post("/api/setup/rescan", async (req) => {
    const fresh = await setupOf(machineQuery.parse(req.query).machine, true);
    // a file put in by hand is seen now: a job that waited for it may start
    s.queue.events.emit("setup");
    return fresh;
  });

  /**
   * ComfyUI's terminal log, the last few hundred lines: the Queue page's log tab reads it every couple of seconds.
   * `since`: the stamp of the last line the page has; only the lines from that moment on come back (that one again
   * among them, as lines can share a stamp: the page drops what it has).
   */
  /**
   * Each ComfyUI of the settings asked now, side by side: whether it answers (and why not), its version, its GPU and the
   * Afflatus node pack it loaded. Read-only: what Settings › ComfyUI shows on each machine's card.
   */
  app.get("/api/machines", async () => {
    const all = await s.machines();
    return Promise.all(all.map(async ({ machine, comfy }) => {
      try {
        const [st, pack] = await Promise.all([comfy.client.status(), comfy.client.packVersion().catch(() => null)]);
        return { id: machine.id, online: true as const, error: null, version: st.version, device: st.device, vramTotal: st.vramTotal, vramFree: st.vramFree, pack, access: await accessOf(comfy, true, false, pack), tokenEnd: machine.token.slice(-4) };
      } catch (e) {
        // locked against Afflatus's token: it answered, so the access line says so (a token to paste), not "not answering"
        const locked = e instanceof ComfyLocked;
        return { id: machine.id, online: false as const, error: e instanceof Error ? e.message : String(e), version: null, device: null, vramTotal: null, vramFree: null, pack: null, access: await accessOf(comfy, false, locked, null), tokenEnd: machine.token.slice(-4) };
      }
    }));
  });

  app.get("/api/comfy/logs", async (req) => {
    // `of`: whose log `since` is a stamp of (the pod's boot log's, or ComfyUI's): a stamp of the one never cuts the other's
    const { since, of, machine } = z.object({ since: z.string().max(64).optional(), of: z.enum(["boot", "comfy"]).optional(), machine: z.string().max(40).optional() }).parse(req.query ?? {});
    // a line whose stamp does not read is kept
    const after = <L extends { t: string }>(lines: L[], source: "boot" | "comfy") => {
      const from = since && (of ?? "comfy") === source ? Date.parse(since) : Number.NaN;
      return Number.isNaN(from) ? lines : lines.filter((l) => !(Date.parse(l.t) < from));
    };
    const id = machine ?? (await s.machines())[0]?.machine.id ?? "";
    // a rented pod whose ComfyUI is not up yet: its boot log (the Afflatus image's), which has ComfyUI's start in it too
    const boot = async () => {
      const got = await s.rented.bootLines(id);
      return got ? { lines: after(got.lines, "boot"), source: "boot" as const } : null;
    };
    if (s.rented.comfyDown(id)) {
      const got = await boot();
      if (got) return got;
    }
    const comfy = await s.comfyOf(machine);
    try {
      return { lines: after(await comfy.client.logs(), "comfy"), source: "comfy" as const };
    } catch (e) {
      const got = await boot();
      if (got) return got;
      throw httpError(`it answered: ${e instanceof Error ? e.message : String(e)}`, 502);
    }
  });

  /**
   * Restart ComfyUI, through ComfyUI-Manager's reboot (it starts itself again with the same command
   * line): after node packs were installed, which ComfyUI only loads at start. Refused while a render
   * runs. What was learned of ComfyUI is forgotten: the new node types show at the next read.
   */
  app.post("/api/comfy/restart", async (req) => {
    const { machine } = z.object({ machine: z.string().max(40).optional() }).parse(req.body ?? {});
    const all = await s.machines();
    // the first machine only when none was named: a machine named and gone (a pod removed in another tab) is not
    // another one to restart, least of all the first ComfyUI, rebooted unasked
    const on = machine === undefined ? all[0] : all.find((m) => m.machine.id === machine);
    if (!on) throw notFound("this machine");
    if ((await s.queue.status()).machines.find((m) => m.id === on.machine.id)?.running) throw httpError("A render is running: restart ComfyUI once it is done.", 409);
    const comfy = on.comfy;
    let res: Response | null = null;
    try {
      res = await comfy.client.raw("/v2/manager/reboot", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000) });
    } catch {
      // the process replaces itself as it answers: a dropped connection is the restart under way
    }
    if (res?.status === 404) throw httpError("This ComfyUI has no ComfyUI-Manager, which does the restarting: restart ComfyUI by hand.");
    if (res?.status === 403) throw httpError("ComfyUI-Manager does not allow a restart from outside at its security level: restart ComfyUI by hand.");
    if (res && !res.ok) throw httpError(`ComfyUI-Manager refused the restart (${res.status}): restart ComfyUI by hand.`);
    comfy.forgetAll();
    return { ok: true };
  });

  /**
   * What the form says under an option whose node pack the machine it renders on lacks (formPacks.ts): installed on first
   * use, asked first, or why it cannot be and what the render does instead.
   */
  app.post("/api/form/packs", async (req) => {
    const b = z.strictObject({ recipe: z.string().min(1).max(200), input: z.record(z.string(), z.unknown()), machine: z.string().min(1).max(40).optional() }).parse(req.body);
    return (await s.queue.formPacks(b.recipe, b.input, b.machine)) ?? { machine: null, rule: null, notes: [] };
  });

  /**
   * The prompt as sent of a form written from parts (card #34): what goes while its prompt is left empty, for the form to
   * show there. Written by the recipe's own rules (Recipe.promptFromParts), as the render will.
   */
  app.post("/api/form/prompt", async (req) => {
    const b = z.strictObject({ recipe: z.string().min(1).max(200), input: z.record(z.string(), z.unknown()) }).parse(req.body);
    const recipe = s.registry.recipe(b.recipe);
    if (!recipe?.partsInto || !recipe.promptFromParts) return { into: null, text: "" };
    const input = (() => {
      try {
        // a form without its media yet (no source picked) is read with its settings' defaults, as the render will have them
        return parseInput(recipe, withMedia(recipe, b.input));
      } catch {
        // a form that does not read (a setting out of range) still has its parts: read as they are (the rules take a part left out as empty)
        return b.input;
      }
    })();
    // a Prompt kit person named "@Nicolas" in a part: said in the prompt as the render will say them
    const said = (await withMentions(s.db, recipe, input as Record<string, unknown>, null)).input;
    // a model left on its family's file is the one this ComfyUI has, as the render takes it (a swap's fused turbo has
    // sentences of its own)
    const slotsHere = (await (await s.comfy()).scan().catch(() => null))?.families.find((f) => f.id === recipe.family)?.slots ?? [];
    for (const spec of recipe.inputs as InputSpec[]) {
      const file = spec.type === "model" && spec.slot && !said[spec.id] ? slotsHere.find((x) => x.id === spec.slot)?.file : null;
      if (file) said[spec.id] = file;
    }
    return { into: recipe.partsInto, text: recipe.promptFromParts(said) };
  });

  /**
   * What a form will take, learned from this machine's own renders with the same model (see forecast.ts): a
   * line for the form's Output part, whether it is past where the card slowed down before (the part's header
   * says so then), and the figure the Generate button says. Nothing is assumed about the card; a model never rendered here says nothing.
   */
  app.post("/api/advice", async (req) => {
    const b = z.strictObject({ recipe: z.string().min(1), input: z.record(z.string(), z.unknown()) }).parse(req.body);
    const recipe = s.registry.recipe(b.recipe);
    const got = recipe ? await s.queue.forecast(b.recipe, b.input).catch(() => null) : null;
    if (!recipe || !got) return { estimate: null };
    // the figure itself too, for the Generate button: its "about" is this one, times the batch (the load counted once); with
    // several machines, each one's with its load, for the machine picked for the draft (GenerateOn.tsx), and the machines
    // Auto shares a batch between (queue.forecast)
    const on = got.on ? Object.fromEntries(Object.entries(got.on).map(([m, f]) => [m, f.ms])) : null;
    const loadOn = got.on ? Object.fromEntries(Object.entries(got.on).map(([m, f]) => [m, f.loadMs])) : null;
    const auto = "auto" in got ? got.auto : null;
    return { estimate: { text: said(got.forecast, got.shape).text, pace: got.forecast.pace, ms: got.forecast.ms, loadMs: got.forecast.loadMs, on, loadOn, auto } };
  });
}
