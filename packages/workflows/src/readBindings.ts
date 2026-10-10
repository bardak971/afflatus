// The bindings of a workflow shared from Afflatus, read without zod: the web's Workflows screen checks a file's bindings
// before it shows them, and zod would add some 90 kB to its bundle for this one check. The server checks them again with
// the schema in types.ts when the workflow is saved; a test holds the two readers to the same answers.
import type { Bindings } from "./types";

/** Reads a value of one shape, or throws: the readers below are put together as the schema in types.ts is. */
type Reader<T> = (v: unknown) => T;

class Unreadable extends Error {}
const fail = (): never => {
  throw new Unreadable();
};

const str: Reader<string> = (v) => (typeof v === "string" ? v : fail());
const num: Reader<number> = (v) => (typeof v === "number" && Number.isFinite(v) ? v : fail());
const bool: Reader<boolean> = (v) => (typeof v === "boolean" ? v : fail());
const oneOf = <T extends string>(...values: T[]): Reader<T> => (v) => (values.includes(v as T) ? (v as T) : fail());
const optional = <T>(r: Reader<T>): Reader<T | undefined> => (v) => (v === undefined ? undefined : r(v));
const withDefault = <T>(r: Reader<T>, d: () => T): Reader<T> => (v) => (v === undefined ? d() : r(v));
// read by index, not by map: map steps over the holes of a sparse array, which the schema refuses
const list = <T>(r: Reader<T>): Reader<T[]> => (v) => (Array.isArray(v) ? Array.from({ length: v.length }, (_, i) => r(v[i])) : fail());
const either = <A, B>(a: Reader<A>, b: Reader<B>): Reader<A | B> => (v) => {
  try {
    return a(v);
  } catch {
    return b(v);
  }
};
/** An object with these fields; others are dropped, as zod's objects drop them. */
const object = <T extends Record<string, unknown>>(shape: { [K in keyof T]: Reader<T[K]> }): Reader<T> => (v) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail();
  const out: Record<string, unknown> = {};
  for (const [k, r] of Object.entries(shape) as [string, Reader<unknown>][]) {
    const value = r((v as Record<string, unknown>)[k]);
    if (value !== undefined || k in v) out[k] = value;
  }
  return out as T;
};

type Target = Bindings["controls"][number]["target"];
const target: Reader<Target> = object({ node: str, input: str });
const captions = object({ on: str, off: str });
const media = { target, detach: list(target), required: bool };
const image = object(media);
const slot = object({ ...media, id: str, label: str });

const control: Reader<Bindings["controls"][number]> = object({
  id: str,
  label: str,
  target,
  kind: oneOf("number", "toggle", "choice", "text"),
  default: either(either(num, bool), str),
  min: optional(num),
  max: optional(num),
  step: optional(num),
  choices: optional(object({ node: str, input: str })),
  file: optional(bool),
  captions: optional(captions),
  also: optional(list(target)),
  front: optional(bool),
  help: optional(str),
  picks: optional(list(object({ value: num, label: str }))),
});

const toggle: Reader<Bindings["toggles"][number]> = object({
  id: str,
  label: str,
  default: bool,
  captions: optional(captions),
  effects: list(object({ nodes: list(str), activeWhen: bool, mode: oneOf("bypass", "mute", "skip") })),
  writes: withDefault(list(target), () => []),
  front: optional(bool),
  help: optional(str),
  made: optional(bool),
});

const switchGroup = object({ toggle: str, items: withDefault(list(str), () => []) });
const section: Reader<Bindings["sections"][number]> = object({
  id: str,
  label: str,
  items: withDefault(list(either(str, switchGroup)), () => []),
  help: optional(str),
});

const bindings: Reader<Bindings> = object({
  prompt: optional(target),
  negative: optional(target),
  seeds: withDefault(list(target), () => []),
  size: optional(object({ width: target, height: target, step: num, min: num, max: num })),
  length: optional(object({ target, fps: num, step: num, offset: num, min: num, max: num })),
  model: optional(object({ target, folder: str })),
  startImage: optional(image),
  endImage: optional(image),
  director: optional(object({ node: str })),
  pictures: withDefault(list(slot), () => []),
  previousVideo: optional(image),
  nextVideo: optional(image),
  sourceVideo: optional(image),
  otherVideos: withDefault(list(slot), () => []),
  sound: optional(image),
  otherSounds: withDefault(list(slot), () => []),
  loras: withDefault(list(object({ node: str, output: num, label: withDefault(str, () => ""), power: optional(bool) })), () => []),
  toggles: withDefault(list(toggle), () => []),
  sections: withDefault(list(section), () => []),
  skip: withDefault(list(object({ node: str, nodes: list(str) })), () => []),
  result: object({ node: str, kind: oneOf("image", "video", "audio"), sound: withDefault(bool, () => false) }),
  controls: withDefault(list(control), () => []),
  stages: withDefault(list(object({ node: str, label: str })), () => []),
});

/** A shared file's bindings with their defaults filled in, as the schema reads them; null when they are not bindings. */
export function readBindings(v: unknown): Bindings | null {
  try {
    return bindings(v);
  } catch (e) {
    if (e instanceof Unreadable) return null;
    throw e;
  }
}
