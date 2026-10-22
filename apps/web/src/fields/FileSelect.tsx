import { useMemo } from "react";
import { sameBase, sameFile } from "@afflatus/core";
import type { FamilyInfo, ModelInfo, RecipeInfo, RecipeStatus } from "../api";
import { useModelInfo, useModelUpdates, useOfficialSizes, useSettings, useSetup } from "../data";
import { fileLabel, size, waitsForGpu } from "../format";
import { GetFile } from "../GetFile";
import { Select, type Option } from "../Select";
import { Label } from "./Label";
import { officialFiles, samePath, type Official } from "../officialFiles";

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
export function FileSelect({ id, label, value, files, folder, placeholder, match, family, absent, absentGroup, onChange }: {
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
  /** The family's official files not here: listed after a divider, greyed with their size, picked all the same. */
  absent?: Official[];
  /** Their section's title ("Not here · official files"). */
  absentGroup?: string;
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
    // the user's files under a head of their own when official ones follow, so that the divider between them reads
    const ownHead = absent?.length && files.length ? "On your ComfyUI" : undefined;
    const own = files.map((f): Option => {
      const o = fileOption(f, info?.[f]);
      const newer = newerOf(f);
      const group = made ? groupOf(f) : ownHead;
      return { ...o, ...(newer ? { note: [o.note, `newer on Civitai: ${newer.name}`].filter(Boolean).join(" · ") } : {}), ...(group ? { group } : {}) };
    });
    const notHere = absentGroup?.startsWith("Not here");
    const greyed = (absent ?? []).map((a): Option => ({ ...fileOption(a.file), note: a.bytes ? `${size(a.bytes)}${notHere ? " · not here" : ""}` : "not here", group: absentGroup ?? "Not here", muted: true }));
    return [...own, ...greyed];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the updates' list, not newerOf, which is new at every render and reads it
  }, [files, info, match, folder, family, updates.data, absent, absentGroup]);
  return <Select id={id} label={label} value={value} onChange={onChange} options={options} placeholder={placeholder} searchHint={info && options.length > 1 ? `Search ${options.length} by name or model` : undefined} />;
}


/**
 * Where a form's jobs run, for what its model fields say of a file that is not here: "here", a ComfyUI of the user's own
 * is listed (a greyed file shows Download, the job waits for it there); "pod", none is and the setup is what a pod would
 * offer (the pod fetches the file before the job).
 */
export function useFilesWhere(): "here" | "pod" {
  const settings = useSettings();
  const setup = useSetup();
  const own = (settings.data?.machines ?? []).some((m) => !m.rented);
  return !own || waitsForGpu(setup.data?.comfy) ? "pod" : "here";
}

/**
 * A model input: the files the user has first, then a divider and the family's official files greyed with their size
 * (where you render, card #20). A greyed file is picked like any other: on this PC the line under the field offers its
 * Download (never automatic) and the job waits until it is there; with rented GPUs only, the pod fetches it before the job.
 */
export function ModelField({ id, spec, value, options, family, onChange }: {
  id: string;
  spec: { label: string; note?: string; folder: string; slot?: string; match?: string[] };
  value: string;
  options: string[] | undefined;
  family: FamilyInfo | undefined;
  onChange(value: string): void;
}) {
  const sizes = useOfficialSizes();
  const where = useFilesWhere();
  const official = officialFiles(family, spec.folder, spec.slot, sizes.data);
  // with rented GPUs only, the setup's lists are the official files themselves (the server's plannedScan): none is here
  const have = where === "pod" ? (options ?? []).filter((f) => !official.some((o) => o.file === f)) : (options ?? []);
  // an official file kept in a sub-folder of the user's own is here, as the server finds it when it builds the job (core sameFile)
  const absent = official.filter((o) => !sameFile(have, o.file));
  const picked = absent.find((o) => samePath(o.file, value));
  const counted = [have.length ? `${have.length} on your ComfyUI` : null, absent.length ? (where === "pod" ? "official files · fetched by the pod" : `${absent.length} official not here`) : null].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} note={spec.note} aside={counted || undefined}>{spec.label}</Label>
      <FileSelect
        id={id} label={spec.label} value={value} onChange={onChange} files={have} folder={spec.folder} match={spec.match} family={family?.name}
        absent={absent} absentGroup={where === "pod" ? "Official files · fetched by the pod" : "Not here · official files"}
        placeholder={have.length || absent.length ? "Choose a model" : `Nothing found in models/${spec.folder}`}
      />
      {picked && where === "here" && (
        <div className="flex flex-col gap-1 text-xs text-ink-2">
          <span className="text-ink-3">Not on your ComfyUI{picked.bytes ? ` · ${size(picked.bytes)}` : ""} · models/{spec.folder}</span>
          <GetFile file={picked.file} folder={spec.folder} url={picked.url} buttons />
          <span>Render queues the job: it waits until the file is there.</span>
        </div>
      )}
      {picked && where === "pod" && <span className="text-xs text-ink-3">{picked.bytes ? `${size(picked.bytes)} · ` : ""}the pod fetches it before the job</span>}
    </div>
  );
}

/**
 * What a form's job will wait for, said on Generate in place of its time: a GPU, with no ComfyUI answering and none of the
 * user's own expected; on this PC, a file still to download (an official file picked greyed, or a family file not here).
 */
export function useWaitsOn(recipe: RecipeInfo | undefined, status: RecipeStatus | undefined, family: FamilyInfo | undefined): (whole: Record<string, unknown>) => string | null {
  const setup = useSetup();
  const where = useFilesWhere();
  const sizes = useOfficialSizes();
  return (whole) => {
    if (!recipe) return null;
    if (waitsForGpu(setup.data?.comfy)) return "waits for a GPU";
    if (where !== "here" || !status) return null;
    const picked = recipe.inputs.some((i) => {
      if (i.type !== "model") return false;
      const value = String(whole[i.id] ?? "");
      return Boolean(value) && !sameFile(status.options[i.id] ?? [], value) && officialFiles(family, i.folder, i.slot, sizes.data).some((o) => samePath(o.file, value));
    });
    const slotMissing = status.missingSlots.length > 0 && status.missingSlots.every((id) => family?.slots?.find((s) => s.id === id)?.get);
    return picked || slotMissing ? "waits for the download" : null;
  };
}
