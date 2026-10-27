import { plural } from "@afflatus/core";
import { VERSION } from "./config";
import { DRAFT_TOOLS } from "./mcpDrafts";
import { FORM_TOOLS } from "./mcpForms";
import { KIT_TOOLS } from "./mcpKit";
import { LIBRARY_TOOLS } from "./mcpLibrary";
import { RENDER_TOOLS } from "./mcpRender";
import { SEE_TOOLS } from "./mcpSee";
import { tool, type Tool } from "./mcpTool";
import { dollars } from "./notifyWords";
import { readSettings } from "./settings";

/**
 * The MCP tools (mcp.ts runs them). A tool is a few lines: its name, its scope, its words, its arguments as zod, and what
 * it does through the existing services; mcp.ts checks the scope and the never-list, writes the activity and says the
 * errors. Each later phase adds its own here (forms and render, library, timelines, models and settings).
 */

/** What runs on a machine now, in a few words. */
const runningOf = (r: { id: string; label: string; recipe: string; kind: string; progress?: number; eta?: number; phase?: string } | null) =>
  r ? { job: r.id, label: r.label, recipe: r.recipe, kind: r.kind, ...(typeof r.progress === "number" ? { progress: Math.round(r.progress * 100) / 100 } : {}), ...(r.eta ? { leftMs: r.eta } : {}), ...(r.phase ? { phase: r.phase } : {}) } : null;

const overview = tool({
  name: "overview",
  scope: "look",
  title: "Overview",
  description: "Afflatus as it stands: each machine (this PC's ComfyUIs and rented pods) with its state, model loaded and running job; the queue (running, waiting, when it is done); the rented GPUs' spend today and this month against the caps; this token's own limits and use; Afflatus's version.",
  async run(_args, ctx) {
    const { s, token } = ctx;
    const st = await s.queue.statusRecent();
    const settings = await readSettings(s.db);
    // the same rule as Costs and the status bar: RunPod is read only with a key or a rented machine
    const spending = settings.runpodKey || settings.machines.some((m) => m.rented) ? await s.rented.spending().catch(() => null) : null;
    const [rendersThisHour, spentThisMonth] = await Promise.all([s.mcp.tokens.rendersThisHour(token.id), s.mcp.tokens.spentThisMonth(token.id)]);
    const machines = st.machines.map((m) => ({
      id: m.id, name: m.name, kind: m.rented ? "rented pod" : "ComfyUI",
      online: m.online, paused: m.paused, locked: m.locked, model: m.model,
      ...(m.rented ? { pod: { status: m.rented.status, gpu: m.rented.gpu, usdPerHour: m.rented.rate, spentThisRun: Math.round(m.rented.spent * 100) / 100 } } : {}),
      running: runningOf(m.running as Parameters<typeof runningOf>[0]),
    }));
    const running = st.machines.filter((m) => m.running).length + (st.tool ? 1 : 0);
    ctx.said(`Looked at Afflatus: ${plural(machines.length, "machine")}, ${running} running, ${st.waiting.length} waiting`);
    return {
      afflatus: VERSION,
      machines,
      queue: {
        paused: st.paused, running, waiting: st.waiting.length, doneInMs: st.waitingEndsInMs,
        next: st.waiting.slice(0, 5).map((j) => ({ job: j.id, label: j.label, recipe: j.recipe, kind: j.kind })),
        ...(st.tool ? { tool: runningOf(st.tool as Parameters<typeof runningOf>[0]) } : {}),
      },
      modelLoaded: st.model,
      rentedGpus: spending ? {
        today: dollars(spending.today), month: dollars(spending.month),
        caps: { day: spending.caps.day ? dollars(spending.caps.day) : "none", month: spending.caps.month ? dollars(spending.caps.month) : "none" },
        balance: spending.balance === null ? null : dollars(spending.balance),
      } : null,
      thisToken: {
        name: token.name, scopes: token.scopes,
        renders: `${rendersThisHour} of ${token.rendersPerHour} this hour`,
        spend: token.scopes.includes("spend") ? `${dollars(spentThisMonth)} of ${dollars(token.spendCapCents / 100)} this month` : "Spend is not ticked: no rented GPU",
        ends: token.expiresAt ?? "never",
      },
    };
  },
});

const whatsOpen = tool({
  name: "whats_open",
  scope: "look",
  title: "What's open",
  description: "Where the user is in Afflatus now: the page (Studio › Create, the timeline editor…), the draft, timeline or clip open there, by id and name, on the device used last. Work there first.",
  async run(_args, ctx) {
    const open = await ctx.s.mcp.where.latest();
    if (!open) {
      ctx.said("Asked what is open: nothing said yet");
      return { open: null, said: "No page of Afflatus has said where it is since the server started: the user has it closed, or has not moved since." };
    }
    const item = open.clip && open.timeline ? `${open.timeline.name}, ${open.clip.name}` : open.timeline?.name ?? open.draft?.name;
    ctx.said(`Asked what is open: ${open.page}${item ? ` › “${item}”` : ""}`);
    return open;
  },
});

/** Every tool, in the order the client lists them. */
export const TOOLS: readonly Tool[] = [whatsOpen, overview, ...FORM_TOOLS, ...DRAFT_TOOLS, ...RENDER_TOOLS, ...SEE_TOOLS, ...LIBRARY_TOOLS, ...KIT_TOOLS] as readonly Tool[];
