/**
 * Saves a ComfyUI's node catalog as the graph checker's reference, with every list of files emptied
 * (model names and pictures describe one person's disk and do not belong in the repository).
 * Read-only on ComfyUI: one GET /object_info.
 *   pnpm catalog:save http://127.0.0.1:8188
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ComfyClient, leftoverNames, stripFileLists } from "@afflatus/comfy";

const url = process.argv[2];
if (!url) {
  console.error("usage: pnpm catalog:save <ComfyUI address>");
  process.exit(1);
}
const client = new ComfyClient(url);
const catalog = await client.catalog();
const stripped = stripFileLists(catalog);
// checked against the files this ComfyUI really has: none of their names may be left anywhere
const files = (await Promise.all((await client.folders()).map((f) => client.models(f).catch(() => [] as string[])))).flat();
const left = leftoverNames(catalog, files);
if (left.length) {
  console.error(`NOT saved: ${left.length} names of your model files are still in the catalog, in a place the cleaner does not know (${left.slice(0, 3).map((n) => `${n.slice(0, 4)}…`).join(", ")}). Fix stripFileLists first.`);
  process.exit(1);
}
const out = fileURLToPath(new URL("../reference/comfy-object-info.json", import.meta.url));
writeFileSync(out, JSON.stringify(catalog));
console.log(`${Object.keys(catalog).length} node types saved to ${out} (${stripped} file lists emptied)`);
