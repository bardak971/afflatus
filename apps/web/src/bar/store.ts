import { create } from "zustand";

/**
 * The command bar's state that lives outside its chunk: whether it is open (the live events read the index
 * again only then), and what this browser chose for it. Small on purpose: the app's first chunk imports it.
 */

const PREVIEW_KEY = "afflatus.bar.preview";
const LEARN_KEY = "afflatus.bar.learn";

const readFlag = (key: string, fallback: boolean): boolean => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
};
const writeFlag = (key: string, on: boolean) => {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // not kept: it holds for this visit
  }
};

export const useBar = create<{
  open: boolean;
  /** What the bar opens with typed (a mode's character, from a button). */
  seed: string;
  /** The preview beside the results: Shift shows or hides it, remembered per browser. */
  preview: boolean;
  /** Learn what I use: ranking by how often and how lately, per browser. */
  learn: boolean;
  show(seed?: string): void;
  hide(): void;
  setPreview(on: boolean): void;
  setLearn(on: boolean): void;
}>((set) => ({
  open: false,
  seed: "",
  preview: readFlag(PREVIEW_KEY, true),
  learn: readFlag(LEARN_KEY, true),
  show: (seed = "") => set({ open: true, seed }),
  hide: () => set({ open: false }),
  setPreview: (preview) => {
    writeFlag(PREVIEW_KEY, preview);
    set({ preview });
  },
  setLearn: (learn) => {
    writeFlag(LEARN_KEY, learn);
    set({ learn });
  },
}));

/** The index's query key: what the live events and a change of drafts mark as old. */
export const BAR_INDEX = ["command-index"] as const;

/** "Ctrl+K", "Ctrl+Shift+P", "Alt+Space": the parts of a shortcut, as they are drawn. */
export const shortcutParts = (s: string) => s.split("+").map((p) => p.trim()).filter(Boolean);

/** The shortcut a key press is, written as the settings keep it; null for a press of a modifier alone. */
export function shortcutOf(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string | null {
  if (["Control", "Meta", "Alt", "Shift", "AltGraph", "OS"].includes(e.key)) return null;
  // the key itself by its place when it is a letter or a figure: Ctrl+K is Ctrl+K whatever the keyboard's layout shifts
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [e.ctrlKey && "Ctrl", e.metaKey && "Meta", e.altKey && "Alt", e.shiftKey && "Shift", key].filter(Boolean).join("+");
}

/** Whether a press is the bar's shortcut (Ctrl on one computer is the command key on a Mac: either works for Ctrl). */
export function isShortcut(e: KeyboardEvent, shortcut: string): boolean {
  const pressed = shortcutOf(e);
  if (!pressed) return false;
  const want = shortcut.trim() || "Ctrl+K";
  return pressed === want || pressed.replace(/^Meta\b/, "Ctrl") === want;
}
