import { plural } from "@afflatus/core";
import { z } from "zod";
import { library } from "./modelLibrary";
import { tool } from "./mcpTool";

/**
 * Settings › Model files from outside (MCP), to look only: every model file of ComfyUI's folders with its use by Afflatus's
 * jobs, what needs it and its copies (modelLibrary.ts). Deleting, putting back and emptying stay in Afflatus: erasing a
 * model file is on the never-list (mcpTool.ts NEVER["model-files"]).
 */

const gbOf = (bytes: number | null) => (bytes === null ? null : Math.round((bytes / 2 ** 30) * 100) / 100);

const modelFiles = tool({
  name: "model_files",
  scope: "look",
  title: "Model files",
  description: "Every model file in ComfyUI's model folders on this PC, as Settings › Model files lists it (in GB): its folder and kind, its name and base model where Civitai, Hugging Face or its header say them, how many Afflatus jobs loaded it and when last (renders made straight in ComfyUI are not seen: say \"not used by Afflatus since\", never \"unused\"), its takes, the presets and model sets that need it, and its extra copies (same sha256). `machine`: another machine's files, names only, from its last scan. `notUsedDays`: only those no Afflatus job loaded for that long. Biggest first. Deleting model files cannot be done through MCP: the user does it in Settings › Model files.",
  input: {
    machine: z.string().optional().describe("A machine's id (list_machines); left out: this PC."),
    notUsedDays: z.number().int().min(1).max(3650).optional().describe("Only files no Afflatus job loaded for at least this many days."),
    limit: z.number().int().min(1).max(500).default(100),
  },
  async run({ machine, notUsedDays, limit }, ctx) {
    const lib = await library(ctx.s, machine);
    const cutoff = notUsedDays ? Date.now() - notUsedDays * 86_400_000 : null;
    const here = lib.files.filter((f) => !f.removed && (cutoff === null || !f.last || Date.parse(f.last) < cutoff));
    here.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
    ctx.said(`Looked at the model files${lib.readOnly ? ` of ${lib.machines.find((m) => m.id === lib.machine)?.name ?? lib.machine}` : ""}: ${plural(here.length, "file")}`);
    return {
      machine: lib.machine, readOnly: lib.readOnly, usesKeptSince: lib.since, count: here.length,
      totalGb: gbOf(here.reduce((n, f) => n + (f.size ?? 0), 0)),
      files: here.slice(0, limit).map((f) => ({
        folder: f.folder, file: f.file, kind: f.kind, gb: gbOf(f.size), ...(f.name ? { name: f.name } : {}), ...(f.base ? { base: f.base } : {}),
        uses: f.uses, ...(f.approx ? { usesApprox: true } : {}), lastUsed: f.last, takes: f.takes,
        ...(f.needs.length ? { neededBy: f.needs.map((n) => `${n.kind} ${n.name}`) } : {}), ...(f.copies.length ? { copies: f.copies.map((c) => c.split("|").slice(1).join("|")) } : {}),
      })),
      ...(lib.away.files ? { away: { files: lib.away.files, gb: gbOf(lib.away.bin + lib.away.aside), said: "Deleted in Settings › Model files and not emptied yet: put back or emptied there." } } : {}),
    };
  },
});

export const MODEL_FILE_TOOLS = [modelFiles];
