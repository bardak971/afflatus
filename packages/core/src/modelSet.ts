import type { GraphFile } from "./graphFiles";
import type { InputSpec, LoraValue } from "./inputs";
import { modelStem } from "./modelFiles";
import { loraFit, versionOf, type ModelInfo } from "./models";
import type { Family } from "./recipe";

/**
 * Whether the files of a render go together: the most common "it is broken" with LTX and Wan is a set of files mixed from
 * versions (LTX-2's VAE under LTX 2.3, a 2.3 LoRA on 2.5, Wan's high-noise file in the low-noise place), which gives a
 * black or garbled clip, or a LoRA that does nothing, after minutes of rendering. Each family declares its versions
 * (`line`) and the files known to be wrong in its places (`wrong`), by name and by SHA-256 where known; the check reads
 * the hashes Settings › Models already keeps, never one of its own. A file it does not know passes without a word.
 */

/** A file known to be wrong in some places of a family's set. */
export interface WrongFile {
  /** The places it is wrong in: slot ids, and model or LoRA input ids. */
  at: string[];
  name?: string[];
  sha256?: string[];
  /** What it is, ending "This VAE is …": "Wan 2.2 5B's (48 channels)". */
  is: string;
  /** What goes there instead, in full, when it is not "<family> needs <the place's usual file>": "it goes in LoRAs (low noise)". */
  instead?: string;
  /** Known to give black or garbled frames, or to be refused by ComfyUI: the job is refused rather than warned. */
  black?: true;
}

/** One file of a render, where it is used. */
export interface SetPlace {
  /** The slot or input id. */
  id: string;
  folder: string;
  file: string;
  /** It is one of a LoRA list's files. */
  lora?: true;
  /** The file that usually goes there (a slot's or a model input's download), and whether Settings › Models offers it. */
  usual?: string;
  offered?: boolean;
}

export interface SetFinding {
  /** The place's slot or input id: a form says it under that field. */
  at: string;
  file: string;
  text: string;
  /** Refused: the mix is known to give black frames or not to run. Otherwise the job runs and says it. */
  black: boolean;
}

/** What is known of the files: their SHA-256 (Settings › Models' hashes, when one was read) and what their header or Civitai says. */
export interface SetLook {
  sha256?(folder: string, file: string): string | undefined;
  info?(folder: string, file: string): ModelInfo | undefined;
}

const NOUN: Record<string, string> = {
  vae: "VAE", text_encoders: "text encoder", loras: "LoRA", latent_upscale_models: "upscaler", diffusion_models: "model",
  checkpoints: "checkpoint", vae_approx: "tiny VAE",
};
const nounOf = (folder: string) => NOUN[folder] ?? "file";

const tested = (sources: readonly string[] | undefined, text: string) =>
  (sources ?? []).some((s) => {
    try {
      return new RegExp(s, "i").test(text);
    } catch {
      return false;
    }
  });
const hashed = (list: readonly string[] | undefined, sha: string | undefined) => Boolean(sha && list?.some((h) => h.toUpperCase() === sha.toUpperCase()));

/** The files a render uses, against its family's declarations: one finding a file at most, in the order they are used. */
export function checkModelSet(family: Pick<Family, "name" | "loraMatch" | "line" | "wrong">, places: SetPlace[], look: SetLook = {}): SetFinding[] {
  const out: SetFinding[] = [];
  for (const p of places) {
    const sha = look.sha256?.(p.folder, p.file);
    const info = look.info?.(p.folder, p.file);
    const noun = p.lora ? "LoRA" : nounOf(p.folder);
    // where the usual file is named, and Settings › Models can fetch it, said so; a declared `instead` says its own words
    const needs = (instead?: string) =>
      instead ?? (p.usual ? `${family.name} needs ${modelStem(p.usual)}${p.offered ? " (Settings › Models has it)" : ""}` : `${family.name} needs its own`);
    const say = (text: string, black = false) => out.push({ at: p.id, file: p.file, text, black });
    const wrong = family.wrong?.find((w) => w.at.includes(p.id) && (hashed(w.sha256, sha) || tested(w.name, p.file)));
    if (wrong) {
      say(`This ${noun} is ${wrong.is}: ${needs(wrong.instead)}.`, Boolean(wrong.black));
      continue;
    }
    const version = family.line ? versionOf(family.line, p.file, sha, info) : null;
    if (version && version !== family.line!.own) {
      // a VAE of another version decodes another latent space: garbled or black frames, never a doubtful result
      if (p.lora) say(`This LoRA was trained for ${version}: on ${family.line!.own} it may do nothing.`);
      else say(`This ${noun} is ${version}'s: ${needs()}.`, p.folder === "vae");
      continue;
    }
    // a LoRA whose header (or Civitai) names another model altogether; a name alone is not enough to say so
    if (p.lora && info?.base && loraFit(family, p.file, info) < 0) say(`This LoRA was trained for ${info.base}: on ${family.name} it does nothing.`);
  }
  return out;
}

/**
 * Where each file a graph loads comes from (graphFiles, its slots told): a model input of the form whose value it is, one of
 * a LoRA list's files, else the family slot the build was handed it as. Files the recipe names itself are left out.
 */
export function setPlaces(
  family: Pick<Family, "slots">,
  inputs: readonly InputSpec[],
  input: Readonly<Record<string, unknown>>,
  files: readonly GraphFile[],
): SetPlace[] {
  const same = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
  const out: SetPlace[] = [];
  for (const f of files) {
    const model = inputs.find((i) => i.type === "model" && typeof input[i.id] === "string" && same(input[i.id] as string, f.file));
    // a graph names a file once: a LoRA in both of Wan's lists is held against each
    const lists = model ? [] : inputs.filter((i) => i.type === "loras" && Array.isArray(input[i.id]) && (input[i.id] as LoraValue[]).some((l) => same(l.file, f.file)));
    for (const list of lists) out.push({ id: list.id, folder: f.folder, file: f.file, lora: true });
    if (lists.length) continue;
    // a model input stands for the slot it starts from (its usual file); a file no input gave is the slot's it was handed as
    const slotId = model?.type === "model" ? model.slot : f.slot;
    const slot = slotId ? family.slots.find((s) => s.id === slotId) : undefined;
    if (!model && !slot) continue;
    out.push({ id: model?.id ?? slot!.id, folder: f.folder, file: f.file, ...(slot?.get ? { usual: slot.get.file, offered: true } : {}) });
  }
  return out;
}
