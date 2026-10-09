import { parseKeys } from "../../keys/grammar";
import { BAR_DEFAULT, PLACES } from "../../keys/table";

/**
 * The keys refused as the command bar's shortcut: every chord the app uses with Ctrl, Alt or the command key, and
 * every function key it uses, read from the key table (keys/table.ts, itself read off the handlers), plus the text
 * boxes' and the browser's own. The bar listens in the capture phase and stops what it hears, so a shortcut on one
 * of these would take the key from the screen that uses it. Named as `shortcutOf` names a press, the command key
 * read as Ctrl.
 */

/** The table's names for the keys that `shortcutOf` names otherwise. */
const NAMES: Record<string, string> = { "←": "ArrowLeft", "→": "ArrowRight", "↑": "ArrowUp", "↓": "ArrowDown", Del: "Delete", Esc: "Escape", PgUp: "PageUp", PgDn: "PageDown", Menu: "ContextMenu" };
const MODS = ["Ctrl", "Alt", "Shift"];

/** A chord of the table as `shortcutOf` names it ("Ctrl+Shift+Z", "Alt+ArrowLeft"), the command key as Ctrl. */
function named(chord: string[]): string {
  const held = new Set(chord.slice(0, -1).map((k) => (k === "Meta" ? "Ctrl" : k)));
  const key = chord.at(-1)!;
  return [...MODS.filter((m) => held.has(m)), NAMES[key] ?? key].join("+");
}

/** What the table's places do with each chord held with Ctrl, Alt or the command key, or on a function key. */
function fromTable(): Record<string, { use: string; bar: boolean }[]> {
  const out: Record<string, { use: string; bar: boolean }[]> = {};
  for (const place of PLACES) {
    for (const group of place.groups) {
      for (const row of group.rows) {
        if (row.mouse || row.bar) continue;
        const parsed = parseKeys(row.keys);
        if (!parsed || "code" in parsed) continue;
        for (const way of parsed.ways) {
          if (way.mouse) continue;
          for (const chord of way.pair) {
            const key = chord.at(-1)!;
            if (!chord.some((k) => k === "Ctrl" || k === "Alt" || k === "Meta") && !/^F\d+$/.test(key)) continue;
            (out[named(chord)] ??= []).push({ use: `${row.does} (${place.name})`, bar: place.id === "bar" });
          }
        }
      }
    }
  }
  return out;
}

/** The text boxes' and the browser's own keys, which no handler of the app lists. */
const OUTSIDE: Record<string, string> = {
  "Ctrl+C": "Copy in a text box",
  "Ctrl+V": "Paste in a text box",
  "Ctrl+X": "Cut in a text box",
  "Ctrl+A": "Select all in a text box",
  "Ctrl+Z": "Undo in a text box",
  "Ctrl+W": "the browser's Close tab",
  "Ctrl+T": "the browser's New tab",
  "Ctrl+N": "the browser's New window",
  "Ctrl+R": "the browser's Reload",
  "Ctrl+L": "the browser's address bar",
  F5: "the browser's Reload",
  F11: "the browser's Full screen",
  F12: "the browser's developer tools",
};

/** Every refused shortcut and what it is used by: the app's first (at most two uses said), then the rest. */
export const RESERVED: Record<string, string> = (() => {
  const out: Record<string, string> = { ...OUTSIDE };
  for (const [key, uses] of Object.entries(fromTable())) {
    if (key === BAR_DEFAULT) continue;
    // the bar's own keys are reserved too, but said by what the screens do with them when a screen uses them
    const screens = uses.filter((u) => !u.bar);
    const said = [...new Set((screens.length ? screens : uses).map((u) => u.use))];
    out[key] = said.slice(0, 2).join(", ") + (said.length > 2 ? ", …" : "");
  }
  return out;
})();

/**
 * Why a shortcut (as `shortcutOf` names it) cannot be the bar's, or null when it is free. `code` is the key's place:
 * Alt changes what some keyboards type on [ and ], which the timeline reads by place too.
 */
export function refusal(shortcut: string, code?: string): string | null {
  let s = shortcut.replace(/^Ctrl\+Meta\b/, "Ctrl").replace(/^Meta\b/, "Ctrl");
  if (s.startsWith("Alt+") && !s.startsWith("Alt+Shift") && (code === "BracketLeft" || code === "BracketRight")) s = code === "BracketLeft" ? "Alt+[" : "Alt+]";
  const taken = RESERVED[s];
  if (!taken) return null;
  const shown = shortcut.replace(/^Meta\b/, "⌘");
  return taken.startsWith("the browser's") ? `${shown} is ${taken}: pick another` : `${shown} is used by ${taken}: pick another`;
}
