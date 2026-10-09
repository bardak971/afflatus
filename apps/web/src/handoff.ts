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

/**
 * Inpaint asked for from a picture (I in the viewer, Inpaint… on the stage): the new draft's mask is painted
 * at once, on that picture, rather than after opening Inputs and pressing "Paint the mask". Kept by the
 * picture's id until the painter has opened, so that only the form it was meant for takes it.
 */
let paintOn: string | null = null;

export function handMask(picture: string): void {
  paintOn = picture;
}
/** Whether the mask of this picture is to be painted as soon as its form shows. Read, not taken: React may draw the field twice. */
export function wantsMask(picture: string | null): boolean {
  return picture !== null && paintOn === picture;
}
export function dropMask(): void {
  paintOn = null;
}
