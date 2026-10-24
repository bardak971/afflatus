/** What the browser gives a secure page alone (https, or localhost), with what is done instead when the app is opened by its LAN address over http. */

/**
 * Text to the clipboard. The browser gives `navigator.clipboard` only to a secure page (https, or
 * localhost): opened by its LAN address over http, the text is copied from a hidden text box instead.
 */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // refused (no focus, no permission): the old way below
    }
  }
  const box = document.createElement("textarea");
  box.value = text;
  box.setAttribute("readonly", "");
  box.style.position = "fixed";
  box.style.opacity = "0";
  document.body.appendChild(box);
  box.select();
  const copied = document.execCommand("copy");
  box.remove();
  if (!copied) throw new Error("the browser did not let the text be copied");
}

/**
 * Whether a picture can be put on the clipboard here. Unlike text there is no old way to fall back on: opened by its LAN
 * address over http the page has no `navigator.clipboard` at all, and Copy the picture is then not offered.
 */
export const canCopyPicture = (): boolean =>
  typeof window !== "undefined" && window.isSecureContext && typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";

/**
 * A picture of the library on the clipboard, as a PNG: the one picture type every browser takes there, so a JPEG or a
 * WebP is drawn again as one first. The clipboard's item is made at once with the file still to come, as Safari lets a
 * page write only while the click that asked is being handled, and the file may take longer than that to arrive.
 */
export async function copyPicture(url: string): Promise<void> {
  const png = fetch(url).then(async (r) => {
    if (!r.ok) throw new Error(`the picture did not come (${r.status})`);
    const blob = await r.blob();
    return blob.type === "image/png" ? blob : asPng(blob);
  });
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

async function asPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((done, fail) => canvas.toBlob((b) => (b ? done(b) : fail(new Error("the picture could not be made into a PNG"))), "image/png"));
}

/** An id made in the page, for something that is only told apart from its siblings (an outfit): `crypto.randomUUID` is a secure page's alone. */
export const localId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
