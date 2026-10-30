import type { AddedLora, InputSpec, StartCondition } from "@afflatus/core";

/**
 * A LoRA the recipe adds itself, shown as a row of a LoRA list (card #160): the row, and the two inputs it is drawn with,
 * its file (blank: the slot's) and its weight (the recipe's own when it has one already: Wan's high-noise turbo strength,
 * LTX's distilled LoRA strength). Left as they start, the render is the one it was before they were.
 */
export interface AddedSpec {
  /** The LoRA list it is a row of. */
  list?: string;
  label: string;
  note: string;
  toggle?: string;
  /** The file input's id, label and note, its slot and the names of the files made for it. */
  file: { id: string; label: string; note: string; slot: string; match: string[] };
  /** The weight input: a new one (with its label and default), or the recipe's own, already among its inputs (`own`). */
  weight: { id: string; own: true } | { id: string; label: string; note: string; default: number };
  slots?: AddedLora["slots"];
  when?: StartCondition;
  /** Shown when this setting is: the toggle, else always. */
  showWhen?: InputSpec["showWhen"];
}

/** The row, for the list's `added`. */
export const addedRow = (a: AddedSpec): AddedLora => ({
  label: a.label, note: a.note, ...(a.toggle ? { toggle: a.toggle } : {}), file: a.file.id, weight: a.weight.id,
  slots: a.slots ?? [{ slot: a.file.slot }], ...(a.when ? { when: a.when } : {}),
});

/** Its file input, and its weight input when it is a new one: both drawn in the row, kept per model like the toggle. */
export function addedInputs(a: AddedSpec): InputSpec[] {
  const list = a.list ?? "loras";
  const shown = a.showWhen ?? a.toggle;
  const common = { advanced: true as const, perModel: true as const, inList: list, ...(shown ? { showWhen: shown } : {}) };
  return [
    { id: a.file.id, type: "model", label: a.file.label, folder: "loras", slot: a.file.slot, blank: true, match: a.file.match, note: a.file.note, ...common },
    ...("own" in a.weight ? [] : [{ id: a.weight.id, type: "number", label: a.weight.label, min: -4, max: 4, step: 0.05, default: a.weight.default, note: a.weight.note, ...common } satisfies InputSpec]),
  ];
}

/** A recipe's inputs with the row put in its LoRA list (the last of its `added`). */
export const withRow = (inputs: InputSpec[], a: AddedSpec): InputSpec[] =>
  inputs.map((i) => (i.id === (a.list ?? "loras") && i.type === "loras" ? { ...i, added: [...(i.added ?? []), addedRow(a)] } : i));

/** The inputs that say a weight drawn in a row: in the row from now on, not a field of their own. */
export const intoRow = (inputs: InputSpec[], ids: Record<string, string>): InputSpec[] =>
  inputs.map((i) => (ids[i.id] ? { ...i, inList: ids[i.id] } : i));

/** A recipe's inputs with the LoRAs of its lists added only while `cond` holds too (an operation that loads no model without it). */
export const rowsWhile = (inputs: InputSpec[], cond: StartCondition): InputSpec[] =>
  inputs.map((i) => (i.type === "loras" && i.added ? { ...i, added: i.added.map((a) => ({ ...a, when: a.when ? { all: [a.when, cond] } : cond })) } : i));
