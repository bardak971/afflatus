import type { NodeCatalog } from "@studai/core";

/** Reading one input's entry in ComfyUI's node catalog: [type, options?]. */

export const specOf = (catalog: NodeCatalog, classType: string, input: string): unknown =>
  catalog[classType]?.input.required?.[input] ?? catalog[classType]?.input.optional?.[input];
/** The input's type; a list of choices in the type position (older nodes) reads as "COMBO". */
export const typeOf = (spec: unknown): string => (Array.isArray(spec) ? (Array.isArray(spec[0]) ? "COMBO" : String(spec[0])) : "");
export const optsOf = (spec: unknown): Record<string, unknown> => (Array.isArray(spec) && spec[1] && typeof spec[1] === "object" ? (spec[1] as Record<string, unknown>) : {});

/** An input the editor shows as a field to type in or pick from, rather than only a socket. */
export function isWidget(spec: unknown): boolean {
  const o = optsOf(spec);
  return ["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"].includes(typeOf(spec)) && !o.forceInput && !o.rawLink;
}
