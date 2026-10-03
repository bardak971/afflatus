/**
 * What a ComfyUI can do for Afflatus, printed. Read-only: status, node list and model folders. It never
 * queues anything, loads a model or frees memory.
 *   pnpm comfy:scan http://127.0.0.1:8188
 */
import { ComfyClient, scan } from "@afflatus/comfy";
import { families, recipes } from "@afflatus/recipes";

const url = process.argv[2] ?? "http://127.0.0.1:8188";
const s = await scan(new ComfyClient(url), families, recipes);

if (!s.comfy.online) {
  console.log(`ComfyUI at ${s.comfy.url} did not answer: ${s.comfy.error}`);
  process.exit(1);
}
const gb = (n: number) => `${(n / 2 ** 30).toFixed(1)} GB`;
console.log(`ComfyUI ${s.comfy.version} at ${s.comfy.url}`);
console.log(`  ${s.comfy.device}`);
console.log(`  memory: ${gb(s.comfy.vramTotal)} total, ${gb(s.comfy.vramFree)} free · ${s.comfy.nodes} node types`);

for (const f of s.families) {
  for (const slot of f.slots) console.log(`  ${f.id} · ${slot.label}: ${slot.file ?? (slot.optional ? "not found (optional)" : `MISSING, ${slot.hint}`)}`);
}
for (const r of s.recipes) {
  console.log(`\n${r.ready ? "ready  " : "NOT READY"} ${r.id}`);
  if (r.missingNodes.length) console.log(`  missing nodes: ${r.missingNodes.join(", ")}`);
  if (r.missingSlots.length) console.log(`  missing files: ${r.missingSlots.join(", ")}`);
  if (r.emptyInputs.length) console.log(`  nothing to pick for: ${r.emptyInputs.join(", ")}`);
  if (r.limitedBy.length) console.log(`  options switched off (missing nodes): ${r.limitedBy.join(", ")}`);
  for (const [input, options] of Object.entries(r.options)) console.log(`  ${input}: ${options.length} choices`);
}
