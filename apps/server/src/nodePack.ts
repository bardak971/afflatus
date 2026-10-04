import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Services } from "./services";
import { readSettings } from "./settings";

/**
 * Afflatus's node pack for ComfyUI (comfy-nodes/afflatus-nodes in the repository: save/load a MiniMax H3
 * latent, and the MIT continuation nodes). When ComfyUI's folder is known (Settings → ComfyUI, same disk),
 * the pack is copied into its custom_nodes folder, and kept up to date when Afflatus starts or the folder
 * is set; ComfyUI loads it at its next start. Nothing is run: files are written, that is all.
 */

export const NODE_PACK = "afflatus-nodes";
/** The node that says the pack is loaded in a running ComfyUI. */
export const NODE_PACK_PROBE = "AfflatusSaveH3Latent";
const exists = (p: string) => access(p).then(() => true, () => false);

/** Where the pack's source is: the repository's folder, or NODE_PACK_DIR. */
export function nodePackSource(): string {
  return process.env.NODE_PACK_DIR?.trim() || fileURLToPath(new URL("../../../comfy-nodes/afflatus-nodes", import.meta.url));
}

/** Copy the pack into `<comfyDir>/custom_nodes/afflatus-nodes/`; says whether anything was written. */
export async function installNodePack(comfyDir: string): Promise<{ written: boolean; changed: boolean; path: string }> {
  const dir = comfyDir.trim();
  const path = join(dir, "custom_nodes", NODE_PACK);
  if (!dir || !(await exists(join(dir, "custom_nodes")))) return { written: false, changed: false, path };
  const source = nodePackSource();
  if (!(await exists(source))) return { written: false, changed: false, path };
  await mkdir(path, { recursive: true });
  let changed = false;
  for (const name of await readdir(source)) {
    if (!/\.(py|md|toml)$|^LICENSE/.test(name)) continue;
    const body = await readFile(join(source, name));
    const had = await readFile(join(path, name)).catch(() => null);
    if (had && Buffer.compare(had, body) === 0) continue;
    await writeFile(join(path, name), body);
    changed = true;
  }
  return { written: true, changed, path };
}

export function registerNodePack(app: FastifyInstance, s: Services): void {
  /** Whether the pack is in ComfyUI's folder, and whether the running ComfyUI has loaded it (else: restart it). */
  app.get("/api/comfy/node-pack", async () => {
    const { comfyDir } = await readSettings(s.db);
    const path = comfyDir.trim() ? join(comfyDir.trim(), "custom_nodes", NODE_PACK) : "";
    const written = path ? await exists(join(path, "__init__.py")) : false;
    const loaded = await (await s.comfy()).catalog().then((catalog) => NODE_PACK_PROBE in catalog).catch(() => false);
    return { pack: NODE_PACK, path, written, loaded };
  });
}
