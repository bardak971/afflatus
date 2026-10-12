import { fileUrl, type Asset } from "./api";

/** A file into the browser's downloads: one helper for a file of the server, an item of the library, or a file made here. */

const FORMATS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac" };

/** The name an item is saved under: its own, else its id with the extension of its type. */
export const downloadName = (asset: Pick<Asset, "id" | "name" | "mime">) => asset.name || `${asset.id}.${FORMATS[asset.mime] ?? "bin"}`;

/** What is at `href`, saved as `name`. */
function saveAs(href: string, name: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
}

/** An item of the library, saved: a render comes marked as made by a model (the server's aiMark.ts). */
export const saveAsset = (asset: Pick<Asset, "id" | "name" | "mime">) => saveAs(`${fileUrl(asset.id)}?download=1`, downloadName(asset));

/** Something made in the page (a JSON file), saved. Its address is let go a moment later: at once, some browsers save nothing. */
function saveBlob(blob: Blob, name: string): void {
  const href = URL.createObjectURL(blob);
  saveAs(href, name);
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** A value as a JSON file, saved. */
export const saveJson = (value: unknown, name: string) => saveBlob(new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" }), name);
