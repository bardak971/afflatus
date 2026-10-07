import type { NodeCatalog } from "@afflatus/core";

/** Reading one input's entry in ComfyUI's node catalog: [type, options?]. */

export const specOf = (catalog: NodeCatalog, classType: string, input: string): unknown =>
  catalog[classType]?.input.required?.[input] ?? catalog[classType]?.input.optional?.[input];
/** The input's type; a list of choices in the type position (older nodes) reads as "COMBO". */
export const typeOf = (spec: unknown): string => (Array.isArray(spec) ? (Array.isArray(spec[0]) ? "COMBO" : String(spec[0])) : "");
export const optsOf = (spec: unknown): Record<string, unknown> => (Array.isArray(spec) && spec[1] && typeof spec[1] === "object" ? (spec[1] as Record<string, unknown>) : {});

/** An input the editor shows as a field to type in or pick from, rather than only a socket. */
export function isWidget(spec: unknown): boolean {
  const o = optsOf(spec);
  return ["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", DYNAMIC].includes(typeOf(spec)) && !o.forceInput && !o.rawLink;
}

/** A choice that brings fields of its own (SaveVideo's format → its codec → its encoding): "format.codec" and so on. */
export const DYNAMIC = "COMFY_DYNAMICCOMBO_V3";
type Option = { key: string; inputs?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } };
/** The options of a dynamic choice, each with the fields it brings. */
export const dynamicOptions = (spec: unknown): Option[] => (typeOf(spec) === DYNAMIC ? ((optsOf(spec).options as Option[] | undefined) ?? []) : []);
/** The fields the picked option of a dynamic choice brings, in the editor's order. */
export const dynamicFields = (spec: unknown, picked: unknown): Array<[string, unknown]> => {
  const o = dynamicOptions(spec).find((x) => x.key === picked);
  return Object.entries({ ...o?.inputs?.required, ...o?.inputs?.optional }).filter(([, sub]) => isWidget(sub));
};
