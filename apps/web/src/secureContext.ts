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

/** An id made in the page, for something that is only told apart from its siblings (an outfit): `crypto.randomUUID` is a secure page's alone. */
export const localId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
