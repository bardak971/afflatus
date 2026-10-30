import { isModelFile } from "@afflatus/core";
import { Link } from "wouter";
import { useSettings, useSetup } from "../../data";
import { plural } from "../../format";
import { settingHref } from "./settingsIndex";

/**
 * How many model files this PC's ComfyUI lists in its forms' choices: more than none where Afflatus found none in the
 * folder it reads means that folder is not ComfyUI's, or cannot be read (card #176: "No model file" stood over forms that
 * listed six), and is said so rather than as an empty folder.
 */
export function useComfyListed(): number {
  const setup = useSetup();
  const files = new Set<string>();
  for (const r of setup.data?.recipes ?? []) for (const list of Object.values(r.options)) for (const f of list) if (isModelFile(f)) files.add(f);
  return files.size;
}

/** What Model files and Your models online say when Afflatus reads nothing where ComfyUI lists files: the folder, and its fix. */
export function UnseenFolder({ listed }: { listed: number }) {
  const dir = useSettings().data?.comfyDir;
  return (
    <>
      ComfyUI lists {plural(listed, "model file")}, but Afflatus finds none in {dir ? <span className="font-mono">{dir}</span> : "the folder it reads"}: it is not this ComfyUI's folder, or Afflatus cannot read it.{" "}
      <Link href={settingHref("comfy.folder")} className="font-semibold underline">Set the folder</Link>
    </>
  );
}
