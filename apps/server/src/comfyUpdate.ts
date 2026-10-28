import { access } from "node:fs/promises";
import { dirname, join } from "node:path";

const there = (path: string) => access(path).then(() => true, () => false);

/**
 * What to run to update the ComfyUI in this folder, as its install has it: the portable's update script (beside its ComfyUI
 * folder, in update/), or a git checkout's pull and its requirements, with its own venv's Python when it has one. Null for a
 * folder that is neither (ComfyUI Desktop, which updates itself, or one not on this computer): the words alone are said then.
 * Only read: nothing is run.
 */
export async function updateCommands(dir: string, windows = process.platform === "win32"): Promise<string | null> {
  const folder = dir.trim();
  if (!folder) return null;
  const portable = join(dirname(folder), "update", "update_comfyui.bat");
  if (windows && (await there(portable))) return `"${portable}"`;
  if (!(await there(join(folder, ".git")))) return null;
  const venvs = ["venv", ".venv"].map((v) => (windows ? join(folder, v, "Scripts", "python.exe") : join(folder, v, "bin", "python")));
  let python = windows ? "python" : "python3";
  for (const v of venvs) {
    if (await there(v)) {
      python = `"${v}"`;
      break;
    }
  }
  return [windows ? `cd /d "${folder}"` : `cd "${folder}"`, "git pull", `${python} -m pip install -r requirements.txt`].join("\n");
}
