import { useEffect, useRef } from "react";
import { api, type Asset } from "./api";
import { plural } from "./format";
import { projectForNew } from "./project";
import type { Banner } from "./store";

/**
 * Ctrl+V with pictures, videos or sounds on the clipboard (a screenshot, a picture copied in a browser, files copied in
 * Explorer or Finder): the files go where the user is, one rule in this order. Typing in a text field: the browser's own
 * text paste, untouched, and a file is ignored there. A picker open: added to the library and picked, as From your computer.
 * A media slot holding the keyboard's focus: as a drop on it. The library shown: into the folder it shows. Anywhere else:
 * the project's library, said in a banner (PasteHere.tsx). Read from the `paste` event, never `navigator.clipboard.read()`:
 * the event gives the files to a page over http on the LAN too, and asks no permission.
 */

export type MediaKind = "image" | "video" | "audio";

/** A place Ctrl+V hands files to, while it is drawn (usePasteTarget). */
export interface PasteTarget {
  /** "picker": an open picker, first; "slot": a media slot, while the focus is inside `el`; "library": the library shown. */
  level: "picker" | "slot" | "library";
  /** The element the place is drawn in: for a slot, what must hold the focus; for a picker, its dialog. */
  el?(): HTMLElement | null;
  /** Takes the files. False: not for it (the focus is on a part of it that takes nothing), the next place is asked. */
  take(files: File[], focused: Element | null): boolean | void;
}

const targets: PasteTarget[] = [];

/** Makes a place a paste target while it is drawn (null: not now). The newest of a level is asked first. */
export function usePasteTarget(target: PasteTarget | null): void {
  const latest = useRef(target);
  latest.current = target;
  const level = target?.level;
  useEffect(() => {
    if (!level) return;
    const t: PasteTarget = { level, el: () => latest.current?.el?.() ?? null, take: (files, focused) => latest.current?.take(files, focused) };
    targets.push(t);
    return () => void targets.splice(targets.indexOf(t), 1);
  }, [level]);
}

const newest = (level: PasteTarget["level"]) => targets.filter((t) => t.level === level).reverse();

/** Where the user types text: an input that takes text, a text area, an editable element. */
export function typingIn(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "file", "submit", "reset", "color", "image"].includes(el.type);
}

/**
 * A screenshot or a picture copied from a page comes as "image.png": named after the moment it was pasted, as the library
 * lists it by name. A file copied in Explorer or Finder keeps its own name.
 */
function named(f: File, at: Date): File {
  const ext = /^image\.(png|jpe?g|webp|gif)$/i.exec(f.name)?.[1];
  if (!ext) return f;
  const stamp = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")} ${String(at.getHours()).padStart(2, "0")}.${String(at.getMinutes()).padStart(2, "0")}.${String(at.getSeconds()).padStart(2, "0")}`;
  return new File([f], `Pasted ${stamp}.${ext.toLowerCase()}`, { type: f.type, lastModified: f.lastModified });
}

/** The files on a pasted clipboard: its file list, else its items that are files (a browser that lists them there only). */
export function pastedFiles(data: DataTransfer, at = new Date()): File[] {
  const files = data.files.length ? [...data.files] : [...data.items].filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter((f): f is File => Boolean(f));
  return files.map((f) => named(f, at));
}

/**
 * The `paste` event, wherever it happens: the files handed to the first place that takes them, `elsewhere` when none is
 * shown. Text, and a paste with no file, are left to the browser.
 */
export function onPaste(e: ClipboardEvent, elsewhere: (files: File[]) => void): void {
  const data = e.clipboardData;
  if (!data || e.defaultPrevented) return;
  const files = pastedFiles(data);
  if (!files.length) return;
  const focused = document.activeElement;
  if (typingIn(focused)) {
    // text pasted into a field stays the browser's; a file there is no surprise upload, unless the field is an open
    // picker's own search (it has the focus as the picker opens)
    if (data.types.includes("text/plain")) return;
    const picker = newest("picker")[0];
    if (!picker?.el?.()?.contains(focused)) {
      e.preventDefault();
      return;
    }
  }
  e.preventDefault();
  for (const t of newest("picker")) if (t.take(files, focused) !== false) return;
  for (const t of newest("slot")) {
    const el = t.el?.();
    if (el && focused && el.contains(focused) && t.take(files, focused) !== false) return;
  }
  for (const t of newest("library")) if (t.take(files, focused) !== false) return;
  elsewhere(files);
}

/** What a file is, by its type: a picture, a video, a sound, or null (none of them). */
export const kindOfFile = (f: { type: string }): MediaKind | null => {
  const k = f.type.split("/")[0];
  return k === "image" || k === "video" || k === "audio" ? k : null;
};

const KINDS = { image: "images", video: "videos", audio: "audio files" } as const;
const AN = { image: "an image", video: "a video", audio: "an audio file" } as const;

/**
 * The files a place takes (of its kind, as many as it has room for), and what is said of the rest: the first one refused
 * and what the place takes, and how many were left for want of room. `label`: the place's name.
 */
export function sortPasted(files: File[], kind: MediaKind, label: string, room = 1): { taken: File[]; said: string | null } {
  const fit = files.filter((f) => kindOfFile(f) === kind);
  const wrong = files.find((f) => kindOfFile(f) !== kind);
  const taken = fit.slice(0, Math.max(0, room));
  const said = [
    wrong && `${label} takes ${KINDS[kind]}: ${wrong.name} is ${kindOfFile(wrong) ? AN[kindOfFile(wrong)!] : "none of them"}${files.length - fit.length > 1 ? ` (${files.length - fit.length} files left out)` : ""}.`,
    fit.length > taken.length && (taken.length ? `${label} had room for ${taken.length}: the first ${taken.length} of ${fit.length} were added.` : `${label} is full.`),
  ].filter(Boolean).join(" ");
  return { taken, said: said || null };
}

/**
 * Files pasted into the library: into `folder`, else the project's root folder (the folder new uploads go to), one after
 * another with the progress said, each found in the library first (a picture copied from Afflatus comes back as itself).
 * One banner says what came in and opens it; `open` gets the items and the folder.
 */
export async function pasteIntoLibrary(files: File[], o: { folder: string | null; name: string; say(b: Banner): void; open(items: Asset[]): void }): Promise<void> {
  const id = `paste:${Date.now()}`;
  const media = files.filter((f) => kindOfFile(f));
  const left = files.length - media.length;
  const leftOut = left ? `Left out: ${plural(left, "file")} that ${left === 1 ? "is" : "are"} no image, video or audio file.` : null;
  if (!media.length) {
    o.say({ id, tone: "bad", title: `Nothing pasted into ${o.name}`, text: leftOut ?? undefined });
    return;
  }
  const added: Asset[] = [];
  const found: Asset[] = [];
  const failed: string[] = [];
  for (const [i, f] of media.entries()) {
    o.say({ id, tone: "good", title: media.length > 1 ? `Pasting ${i + 1} of ${media.length} into ${o.name}…` : `Pasting into ${o.name}…`, text: f.name });
    try {
      const a = await api.upload(f, { ...(o.folder ? { folder: o.folder } : {}), project: projectForNew(), reuse: true });
      (a.found ? found : added).push(a);
    } catch (err) {
      failed.push(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const items = [...added, ...found];
  const title = !items.length ? `Nothing pasted into ${o.name}` : added.length ? `${added.length > 1 ? `${added.length} files pasted` : "Pasted"} into ${o.name}` : "Already in your library";
  o.say({
    id, tone: failed.length ? "bad" : "good", title,
    text: [
      found.length > 0 && (found.length === 1 ? `${found[0]!.name || "It"} was there already: that item is used, not a copy.` : `${found.length} were there already: those items are used, not copies.`),
      failed.length > 0 && `${failed.length} failed · ${failed[0]}`,
      leftOut,
    ].filter(Boolean).join(" ") || undefined,
    ...(items.length ? { href: "/", go: "Open", act: () => o.open(items) } : {}),
  });
}
