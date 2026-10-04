/**
 * One thing handed from a screen to the next: a preset chosen in the Prompt kit, applied by Studio's
 * form once it is open. Not kept: a reload drops it.
 */
let preset: string | null = null;

export function handPreset(id: string): void {
  preset = id;
}
/** The preset handed over, once; null when none was. */
export function takePreset(): string | null {
  const id = preset;
  preset = null;
  return id;
}
