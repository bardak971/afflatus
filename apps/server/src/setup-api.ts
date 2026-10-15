import { httpError } from "./errors";
import type { FastifyInstance } from "fastify";
import { said } from "./forecast";
import { allowedHosts, hostAllowed } from "./hostCheck";
import { z } from "zod";
import { ComfyLocked } from "@afflatus/comfy";
import { describeRecipe, listOptions } from "@afflatus/core";
import { mergeScans } from "./machineScans";
import { accessOf } from "./lock-api";
import { installNodePack } from "./nodePack";
import { preflight } from "./preflight";
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
  /** The start-up checks run again, now (Settings → About → Check again). */
  app.post("/api/health/check", async () => health(await preflight.run()));

  /** Everything the composer can make things with, and the form of each. */
  app.get("/api/recipes", async () => ({ families: s.registry.families(), recipes: s.registry.recipes().map(describeRecipe) }));

  app.get("/api/settings", async () => publicSettings(await readSettings(s.db)));
  app.put("/api/settings", async (req) => {
    // under the Access settings' rule (access.ts mayChange: a sign-in of the last 10 minutes, or the password in the
    // X-Afflatus-Password header): the new-device notice, which would hide a sign-in from elsewhere, and Telegram's bot and
    // chat, where reset codes and alarms go (a session taken over would point them at its own bot)
    const sent = req.body as { notify?: { events?: { newDevice?: unknown }; telegramToken?: unknown; telegramChat?: unknown } } | null;
    const ip = req.socket.remoteAddress ?? "";
    const telegram = sent?.notify?.telegramToken !== undefined || sent?.notify?.telegramChat !== undefined;
    if (sent?.notify?.events?.newDevice !== undefined || telegram) {
      const typed = req.headers["x-afflatus-password"];
      await s.access.mayChange(req.access.session, typeof typed === "string" ? typed : undefined, ip);
    }
    const before = (await readSettings(s.db)).notify;
    const saved = await writeSettings(s.db, req.body);
    if (telegram && (saved.notify.telegramToken !== before.telegramToken || saved.notify.telegramChat !== before.telegramChat)) await s.access.telegramChanged(before, ip);
    // a file chosen by hand for a family: what is ready is worked out again
    if (req.body && typeof req.body === "object" && "slotFiles" in req.body) for (const { comfy } of await s.machines()) comfy.forgetScan();
    // a family switched, on every machine or on one: what each machine may run changed (the queue looks again, the pages read it again)
    if (req.body && typeof req.body === "object" && ("families" in req.body || "machines" in req.body)) s.queue.events.emit("setup");
    // ComfyUI's folder set: Afflatus's node pack goes into its custom_nodes (ComfyUI loads it at its next start)
    if (req.body && typeof req.body === "object" && "comfyDir" in req.body && saved.comfyDir.trim()) {
      await installNodePack(saved.comfyDir).catch((err: Error) => console.warn(`[node-pack] not written: ${err.message}`));
    }
    return publicSettings(saved);
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
    const { since, machine } = z.object({ since: z.string().max(64).optional(), machine: z.string().max(40).optional() }).parse(req.query ?? {});
    const from = since ? Date.parse(since) : Number.NaN;
    const comfy = await s.comfyOf(machine);
    try {
      const lines = await comfy.client.logs();
      // a line whose stamp does not read is kept
      return { lines: Number.isNaN(from) ? lines : lines.filter((l) => !(Date.parse(l.t) < from)) };
    } catch (e) {
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
    const on = all.find((m) => m.machine.id === machine) ?? all[0]!;
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
    // several machines, each one's, for the machine picked for the draft (GenerateOn.tsx)
    const on = got.on ? Object.fromEntries(Object.entries(got.on).map(([m, f]) => [m, f.ms])) : null;
    return { estimate: { text: said(got.forecast, got.shape).text, pace: got.forecast.pace, ms: got.forecast.ms, loadMs: got.forecast.loadMs, on } };
  });
}
