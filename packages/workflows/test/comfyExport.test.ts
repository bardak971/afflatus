import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Graph, NodeCatalog } from "@afflatus/core";
import { fromEditor, prune } from "../src";
import { compare, withFileIds, type Diff } from "./exportCompare";

/**
 * Afflatus's reading of each corpus workflow against ComfyUI's own (comfyExport.mjs writes what its editor
 * would send, as "Export (API)" would). Only workflows whose every node that ComfyUI has are compared: a
 * node of a missing pack cannot be read by the editor either. Skipped when there is no export.
 */
const corpus = join(import.meta.dirname, "corpus");
const dir = join(corpus, process.env.COMFY_API_DIR ?? "comfy-api");
const infoFile = join(dir, "_object_info.json");
const files = existsSync(infoFile) ? readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort() : [];

describe.skipIf(!files.length)("the importer against ComfyUI's own export", () => {
  it("reads every workflow ComfyUI can read the way ComfyUI does", () => {
    const catalog = JSON.parse(readFileSync(infoFile, "utf8")) as NodeCatalog;
    const report: Record<string, { diffs: Diff[] } | { skipped: string }> = {};
    let compared = 0;
    let clean = 0;
    for (const file of files) {
      const exported = JSON.parse(readFileSync(join(dir, file), "utf8")) as { output?: Graph; missing?: string[]; renumbered?: Record<string, Record<string, string>>; error?: string };
      if (exported.error) { report[file] = { skipped: `ComfyUI's editor: ${exported.error.split("\n")[0]}` }; continue; }
      const raw = JSON.parse(readFileSync(join(corpus, file), "utf8"));
      const read = fromEditor(raw, catalog);
      const ours = prune(read.graph, read.wiring, read.wiring?.modes ?? {}).graph;
      // the nodes of kinds ComfyUI lacks are left out of ours as of theirs
      const lacking = new Set(exported.missing ?? []);
      for (const [id, n] of Object.entries(ours)) if (lacking.has(n.class_type)) delete ours[id];
      const diffs = compare(withFileIds(exported.output!, raw, exported.renumbered), ours, catalog);
      report[file] = { diffs };
      compared++;
      if (!diffs.length) clean++;
    }
    writeFileSync(join(dir, "_report.json"), JSON.stringify(report, null, 1));
    console.log(`compared ${compared}, the same as ComfyUI: ${clean}; report in ${dir}/_report.json`);
    expect(compared).toBeGreaterThan(0);
  });
});
