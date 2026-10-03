import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ComfyUnreachable } from "@studai/comfy";
import type { Services } from "./services";
import { readSettings } from "./settings";

/**
 * Showing a workflow in ComfyUI's own editor. Its page opens a workflow from its address in one case
 * only: an example workflow of a custom node pack (?template=<name>&source=<pack>, served from
 * custom_nodes/<pack>/example_workflows/). So when ComfyUI's folder is at hand (Settings, same disk),
 * studai keeps a pack of its own there, with no nodes, and writes the file into it. ComfyUI registers the
 * pack when it starts: until it has, and when the folder is not known, the file goes into ComfyUI's user
 * data instead (workflows/studai/<title>.json), which its Workflows sidebar lists.
 */

const PACK = "studai-workflows";
const PACK_INIT = `# studai's helper pack: no nodes. ComfyUI serves example_workflows/ so that studai can open a workflow in the editor.\nNODE_CLASS_MAPPINGS = {}\n`;
const exists = (p: string) => access(p).then(() => true, () => false);
const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export type Opened = { url: string; direct: true } | { url: string; direct: false; path: string; restart?: boolean };

/**
 * Put `file` (the editor's format) where ComfyUI shows it, and say what address to open. `name` is the
 * file's name in the pack (letters, digits, "-", "_" and "." only: ComfyUI's page takes nothing else);
 * `title` names it in the sidebar.
 */
export async function openInComfy(s: Services, name: string, title: string, file: unknown): Promise<Opened> {
  const comfy = await s.comfy();
  const toSidebar = async (): Promise<string> => {
    const path = `workflows/studai/${title.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || name}.json`;
    try {
      await comfy.client.storeUserData(path, file);
    } catch (err) {
      if (err instanceof ComfyUnreachable) throw bad("ComfyUI has to be running: the workflow is written into its own workflows folder.", 503);
      throw err;
    }
    return path;
  };
  const { comfyDir } = await readSettings(s.db);
  if (!comfyDir.trim()) return { url: comfy.url, direct: false, path: await toSidebar() };

  const dir = comfyDir.trim();
  if (!(await exists(join(dir, "custom_nodes")))) throw bad(`"${dir}" is not a ComfyUI folder: it has no custom_nodes folder. Check the ComfyUI folder in Settings.`);
  const pack = join(dir, "custom_nodes", PACK);
  await mkdir(join(pack, "example_workflows"), { recursive: true });
  if (!(await exists(join(pack, "__init__.py")))) await writeFile(join(pack, "__init__.py"), PACK_INIT, "utf-8");
  await writeFile(join(pack, "example_workflows", `${name}.json`), JSON.stringify(file), "utf-8");
  // served only once ComfyUI has started with the pack there: asked, not assumed
  const served = await comfy.client.servesTemplate(PACK, name).catch((err) => {
    if (err instanceof ComfyUnreachable) throw bad("ComfyUI has to be running to open a workflow in it.", 503);
    throw err;
  });
  if (served) return { url: `${comfy.url}/?template=${encodeURIComponent(name)}&source=${PACK}`, direct: true };
  return { url: comfy.url, direct: false, path: await toSidebar(), restart: true };
}
