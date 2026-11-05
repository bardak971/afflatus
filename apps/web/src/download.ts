import { downloadName } from "@afflatus/core";
import { api, failure, fileUrl, raw, type Asset } from "./api";

/** A file into the browser's downloads: one helper for a file of the server, an item of the library, or a file made here. */

/** What is at `href`, saved as `name`. */
function saveAs(href: string, name: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
}

/** An item of the library, saved: a render comes marked as made by a model (the server's aiMark.ts). */
export const saveAsset = (asset: Pick<Asset, "id" | "name" | "mime">) => saveAs(`${fileUrl(asset.id)}?download=1`, downloadName(asset));

/**
 * Several items of the library as one zip, renders marked as one by one: the server is handed the ids and gives an address
 * the browser follows as a link, so the zip is written to the disk as it comes, never held in the page.
 */
export async function saveZip(ids: string[]): Promise<void> {
  const { href } = await api.zipAssets(ids);
  // no name of the page's own: the server's (how many items, when) is the one the file is saved under
  saveAs(href, "");
}

/** Something made in the page (a JSON file), saved. Its address is let go a moment later: at once, some browsers save nothing. */
function saveBlob(blob: Blob, name: string): void {
  const href = URL.createObjectURL(blob);
  saveAs(href, name);
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** A value as a JSON file, saved. */
export const saveJson = (value: unknown, name: string) => saveBlob(new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" }), name);

/**
 * A file the server makes on asking (a CSV of a Queue tab), saved under the name it gives: fetched rather than followed as
 * a link, so that a refusal (signed out, a bad window) is said as a failure instead of saved as the file.
 */
export async function saveFromServer(path: string, fallbackName: string): Promise<void> {
  const res = await raw("GET", path);
  if (!res.ok) throw await failure(res);
  const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? fallbackName;
  saveBlob(await res.blob(), name);
}
