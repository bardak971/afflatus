import { useMemo } from "react";
import { sameBase } from "@afflatus/core";
import type { ModelInfo } from "../api";
import { useModelInfo, useModelUpdates } from "../data";
import { fileLabel } from "../format";
import { Select, type Option } from "../Select";

/**
 * A file as a choice: its name to read, beside it the model it is for and the folder it is in. It is
 * found by everything the file says about itself, shown or not.
 */
export const fileOption = (file: string, info?: ModelInfo): Option => {
  const folder = file.split(/[\\/]/).slice(0, -1).join("/");
  const note = [info?.base, folder].filter(Boolean).join(" · ");
  const search = [info?.title, info?.trainedOn, info?.trigger, info?.tags?.join(" "), info?.about].filter(Boolean).join(" ");
  return { value: file, label: fileLabel(file), ...(note ? { note } : {}), ...(search ? { search } : {}) };
};

/** The ComfyUI model folder behind a node input that picks a file, for the inputs whose name says it. */
export const FOLDER_OF: Record<string, string> = {
  ckpt_name: "checkpoints", unet_name: "diffusion_models", vae_name: "vae", clip_name: "text_encoders", lora_name: "loras", control_net_name: "controlnet",
};

/** A dropdown of model files, searched by what the files say about themselves when their folder is known. */
export function FileSelect({ id, label, value, files, folder, placeholder, match, family, onChange }: {
  id: string;
  label: string;
  value: string;
  files: string[];
  folder: string | undefined;
  placeholder?: string;
  /** Names of the files made for this form, when the folder holds other kinds too: those are listed apart from the rest. */
  match?: string[];
  /** The model family the form is for: a file whose weights say they are its is "made for this" whatever its name. */
  family?: string;
  onChange(value: string): void;
}) {
  const known = useModelInfo(folder);
  const info = known.data?.items;
  const updates = useModelUpdates();
  const newerOf = (f: string) => updates.data?.items.find((u) => u.folder === folder && u.file === f && u.newer)?.newer ?? null;
  const options = useMemo(() => {
    const made = match?.map((p) => new RegExp(p, "i"));
    // the files arrive with the ones made for it first; a file that says it is another model's is told apart too
    const groupOf = (f: string) => {
      if (!made) return undefined;
      const base = info?.[f]?.base;
      if (made.some((re) => re.test(f)) || (family && sameBase(base, family))) return "Made for this";
      if (base && family && !sameBase(base, family)) return `Made for other models (${base})`;
      return `Everything else in models/${folder}`;
    };
    return files.map((f) => {
      const o = fileOption(f, info?.[f]);
      const newer = newerOf(f);
      return { ...o, ...(newer ? { note: [o.note, `newer on Civitai: ${newer.name}`].filter(Boolean).join(" · ") } : {}), ...(made ? { group: groupOf(f) } : {}) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the updates' list, not newerOf, which is new at every render and reads it
  }, [files, info, match, folder, family, updates.data]);
  return <Select id={id} label={label} value={value} onChange={onChange} options={options} placeholder={placeholder} searchHint={info && files.length > 1 ? `Search ${files.length} by name or model` : undefined} />;
}
