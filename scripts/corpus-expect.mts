// Writes packages/workflows/test/corpus/expect.json from what the importer finds in the corpus today.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { catalog } from "../packages/workflows/test/fixtures";
import { fromEditor, inspect, isEditorFormat } from "../packages/workflows/src/index";
import { corpusFacts } from "../packages/workflows/test/corpusFacts";

const dir = join(import.meta.dirname, "../packages/workflows/test/corpus");
const out: Record<string, ReturnType<typeof corpusFacts>> = {};
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "expect.json").sort()) {
  const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const read = isEditorFormat(raw) ? fromEditor(raw, catalog) : { graph: raw, wiring: undefined, notes: [] };
  out[file] = corpusFacts(inspect(read.graph, catalog, read.wiring, read.notes));
}
writeFileSync(join(dir, "expect.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`expect.json: ${Object.keys(out).length} workflows`);
