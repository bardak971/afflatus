import type { NodeCatalog, NodeInfo } from "@afflatus/core";

/** Reading one input's entry in ComfyUI's node catalog: [type, options?]. */

/** The catalog's entry for a kind of node: its own entries only (a kind named "constructor" is not Object's). */
export const infoOf = (catalog: NodeCatalog, classType: string): NodeInfo | undefined => (Object.hasOwn(catalog, classType) ? catalog[classType] : undefined);
/** A record's own value for a key a file names (never a member of its prototype). */
export const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);
/** Whether this ComfyUI has a kind of node. */
export const hasKind = (catalog: NodeCatalog, classType: string): boolean => Object.hasOwn(catalog, classType);

export const specOf = (catalog: NodeCatalog, classType: string, input: string): unknown => {
  const info = infoOf(catalog, classType);
  const own = (group: Record<string, unknown> | undefined) => (group && Object.hasOwn(group, input) ? group[input] : undefined);
  return own(info?.input.required) ?? own(info?.input.optional);
};
/** The input's type; a list of choices in the type position (older nodes) reads as "COMBO". */
export const typeOf = (spec: unknown): string => (Array.isArray(spec) ? (Array.isArray(spec[0]) ? "COMBO" : String(spec[0])) : "");
export const optsOf = (spec: unknown): Record<string, unknown> => (Array.isArray(spec) && spec[1] && typeof spec[1] === "object" ? (spec[1] as Record<string, unknown>) : {});

/** A choice that brings fields of its own (SaveVideo's format → its codec → its encoding): "format.codec" and so on. */
const DYNAMIC = "COMFY_DYNAMICCOMBO_V3";
/** The types the editor shows as a field to type in or pick from (an upload button among them), rather than only a socket. */
const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", "IMAGEUPLOAD", DYNAMIC]);
export const isWidgetType = (type: string): boolean => WIDGET_TYPES.has(type);

/** An input the editor shows as a field to type in or pick from, rather than only a socket. */
export function isWidget(spec: unknown): boolean {
  const o = optsOf(spec);
  return isWidgetType(typeOf(spec)) && !o.forceInput && !o.rawLink;
}

type Option = { key: string; inputs?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } };
/** The options of a dynamic choice, each with the fields it brings. */
const dynamicOptions = (spec: unknown): Option[] => (typeOf(spec) === DYNAMIC ? ((optsOf(spec).options as Option[] | undefined) ?? []) : []);
/** The fields the picked option of a dynamic choice brings, in the editor's order. */
export const dynamicFields = (spec: unknown, picked: unknown): Array<[string, unknown]> => {
  const o = dynamicOptions(spec).find((x) => x.key === picked);
  return Object.entries({ ...o?.inputs?.required, ...o?.inputs?.optional }).filter(([, sub]) => isWidget(sub));
};
/** What the editor puts in a field it has no saved value for: its declared default, or a dynamic choice's first option. */
export const defaultOf = (spec: unknown): unknown => optsOf(spec).default ?? dynamicOptions(spec)[0]?.key;

/** A file name a loader takes, as opposed to a prompt or a number. */
export const MODEL_FILE = /\.(safetensors|sft|gguf|ckpt|pt|pth|bin|onnx|engine)$/i;

/**
 * A node that runs a pass of sampling: ComfyUI's samplers by their kind, a pack's sampler that takes a step count
 * (WanVideoSampler), and a node that runs a schedule with a model over a latent or a picture (SamplerCustomAdvanced's
 * kin, UltimateSDUpscaleCustomSample, SUPIR_sample). A scheduler or a detailer has steps too, but samples for another
 * node or after the passes; the helpers that only hand a sampler, a schedule or settings on (KSamplerSelect, rgthree's
 * KSampler Config and Context, Impact's KSamplerProvider) sample nothing, whatever their name. Progress counts steps
 * where they sit all the same (recipe.ts).
 */
const SAMPLER_HELPER = /Select|Config|Scheduler|Provider|Context|Detailer|Metadata|Saver/i;
export const isSamplingPass = (node: { class_type: string; inputs: Record<string, unknown> }): boolean => {
  if (SAMPLER_HELPER.test(node.class_type)) return false;
  if (/KSampler|SamplerCustom/.test(node.class_type)) return true;
  const keys = Object.keys(node.inputs);
  const has = (re: RegExp) => keys.some((k) => re.test(k));
  if (/Sampler/i.test(node.class_type) && has(/^steps$/)) return true;
  return has(/^(steps|sigmas|custom_sigmas)$/) && has(/^(model|guider)$|^(?!upscale_)\w+_model$/) && has(/^(latent_image|latents?|samples|images?)$/);
};

/** Names a file can carry that would reach an object's prototype when used as a key: never an id or a socket name. */
export const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
