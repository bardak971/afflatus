import { fromRgba, resample, toRgba, type Plane } from "./raster";

/**
 * The mask's way in and out of the browser: a picture (a mask painted before, one a click found) read into a plane, and
 * the plane made a PNG. The sums are raster.ts's; only the canvas is here.
 */

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("the image could not be opened"));
    img.src = src;
  });
}

/** A mask picture read at the plane's size, by its red channel (as the recipes read it). */
export async function planeFrom(src: string, w: number, h: number): Promise<Plane> {
  const img = await loadImage(src);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  return fromRgba(ctx.getImageData(0, 0, w, h).data, w, h);
}

/** The plane as a PNG of `w` × `h` (the picture's own size): grey, white where masked. */
export async function pngOf(plane: Plane, w: number, h: number): Promise<Blob> {
  const full = resample(plane, w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.putImageData(new ImageData(toRgba(full) as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  if (!blob) throw new Error("the mask could not be saved");
  return blob;
}
