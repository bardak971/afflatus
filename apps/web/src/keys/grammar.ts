/**
 * The one way the app writes keys, read by the keycaps of the kit (`<Keys>`), the sheet, the menus and the tips:
 *
 * - `Ctrl+Shift+Z`: keys held together, a chord, drawn joined.
 * - `Ctrl+Shift+Z | Ctrl+Y` (or `Tab or Esc`): either one, a written "or" between them.
 * - `← →`, `I O`: a pair, keys that do the two halves of one thing, side by side.
 * - `Ctrl+click`, `Shift+drag`, `right-click`, `wheel`: a mouse move, written as text, never as caps.
 * - `{a|b|c}`: syntax to type, not keys: drawn as code.
 *
 * " + " with spaces reads as "+" ("Alt + ←" is Alt+←), so the older spelling still parses; "Ctrl++" is Ctrl and the plus key.
 */

/** Keys held together. */
type Chord = string[];
/** One way to do it: a chord, a pair of chords side by side, or a mouse move (its chord ends in the move). */
interface Way {
  pair: Chord[];
  mouse: boolean;
}
export type Parsed = { code: string } | { ways: Way[] };

/** The names a key is written with, by what it may be called (a recorded key, an older spelling, a sign). */
const ALIASES: Record<string, string> = {
  ctrl: "Ctrl", control: "Ctrl",
  meta: "Meta", cmd: "Meta", command: "Meta", "⌘": "Meta", os: "Meta", win: "Meta",
  alt: "Alt", option: "Alt", opt: "Alt", "⌥": "Alt", altgraph: "Alt",
  shift: "Shift", "⇧": "Shift",
  enter: "Enter", return: "Enter", "↵": "Enter", "⏎": "Enter",
  esc: "Esc", escape: "Esc",
  del: "Del", delete: "Del",
  backspace: "Backspace", "⌫": "Backspace",
  space: "Space", spacebar: "Space",
  tab: "Tab", home: "Home", end: "End", insert: "Insert", ins: "Insert",
  pgup: "PgUp", pageup: "PgUp", pgdn: "PgDn", pagedown: "PgDn",
  left: "←", arrowleft: "←", right: "→", arrowright: "→", up: "↑", arrowup: "↑", down: "↓", arrowdown: "↓",
  menu: "Menu", contextmenu: "Menu",
};

/** Mouse moves: written as words, never as caps. */
const MOUSE = new Set(["click", "double-click", "right-click", "middle-click", "drag", "wheel"]);

/** Single signs that are keys of their own. */
const SIGNS = /^[\-=[\]\\;',./`<>?:"@#!*&%$^~←→↑↓+_(){}]$/;

/**
 * A key's own name, or null when it is not one. Strict: a letter is written as a capital ("S", not "s"), as on
 * the keycap; lenient (a search typed by hand): any case, and "Cmd" is the same key as Ctrl, as the app's handlers treat it.
 */
function keyName(raw: string, lenient = false): string | null {
  const k = raw.trim();
  if (!k) return null;
  const alias = ALIASES[k.toLowerCase()];
  if (alias) return lenient && alias === "Meta" ? "Ctrl" : alias;
  if (/^f([1-9]|1\d|2[0-4])$/i.test(k)) return k.toUpperCase();
  if (MOUSE.has(k.toLowerCase())) return k.toLowerCase() === k || lenient ? k.toLowerCase() : null;
  if (/^[A-Z0-9]$/.test(k)) return k;
  if (/^[a-z]$/.test(k)) return lenient ? k.toUpperCase() : null;
  if (SIGNS.test(k)) return k;
  return null;
}

const isMouse = (key: string) => MOUSE.has(key);
const isModifier = (key: string) => key === "Ctrl" || key === "Shift" || key === "Alt" || key === "Meta";

/** "Ctrl+Shift+Z" → Ctrl, Shift, Z; "Ctrl++" → Ctrl, +; "+" → +. Null when a part is not a key. */
function chordOf(token: string, lenient: boolean): Chord | null {
  const raw = token.split("+");
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const part = raw[i]!;
    if (part === "") {
      // two empty parts side by side: the plus key itself ("Ctrl++", "+")
      if (raw[i + 1] === "") {
        out.push("+");
        i++;
        continue;
      }
      return null;
    }
    const name = keyName(part, lenient);
    if (!name) return null;
    out.push(name);
  }
  return out.length ? out : null;
}

/** One way: its words split on spaces, "Alt + ←" joined back into one chord, each chord read. */
function wayOf(text: string, lenient: boolean): Way | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const tokens: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const last = tokens.length - 1;
    // "Alt + ←": a lone plus between two keys holds them together; "Ctrl+ Z" too
    if (w === "+" && last >= 0 && i + 1 < words.length) {
      tokens[last] += "+" + words[++i]!;
    } else if (last >= 0 && /[^+]\+$/.test(tokens[last]!)) {
      tokens[last] += w;
    } else tokens.push(w);
  }
  if (!tokens.length) return null;
  const pair: Chord[] = [];
  for (const t of tokens) {
    const chord = chordOf(t, lenient);
    if (!chord) return null;
    pair.push(chord);
  }
  const mouse = pair.some((c) => c.some(isMouse));
  // a mouse move is the end of one chord ("Ctrl+click"), never a pair, and only modifiers are held with it
  if (mouse && (pair.length > 1 || !isMouse(pair[0]!.at(-1)!) || pair[0]!.slice(0, -1).some((k) => !isModifier(k)))) return null;
  return { pair, mouse };
}

/** A key string read with the grammar; null when it does not follow it. */
export function parseKeys(text: string, opts: { lenient?: boolean } = {}): Parsed | null {
  const s = text.trim();
  if (!s) return null;
  // syntax to type ({a|b|c}): code, not keys
  if (/^\{.*\}$/.test(s)) return { code: s };
  const ways: Way[] = [];
  for (const alt of s.split(/\s*\|\s*|\s+or\s+/)) {
    const way = wayOf(alt, Boolean(opts.lenient));
    if (!way) return null;
    ways.push(way);
  }
  return { ways };
}

/** The platform the keys are drawn for: a Mac writes Ctrl as ⌘ and Alt as ⌥. */
export const onMac = (): boolean => {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(nav.userAgentData?.platform || nav.platform || nav.userAgent || "");
};

/** How a key is printed on its cap. */
export function capText(key: string, mac: boolean): string {
  if (key === "Ctrl" || key === "Meta") return mac ? "⌘" : key === "Meta" ? "Win" : "Ctrl";
  if (key === "Alt") return mac ? "⌥" : "Alt";
  return key;
}

/**
 * A search typed in the sheet, read as keys when it is one: "s", "ctrl z", "Shift+L", "cmd z". Each word is a key
 * name; a single word may also be the start of one ("s" also finds Shift and Space, as the cap reads). Null for words.
 */
export function keyQuery(text: string): { exact: string[]; prefix: string | null } | null {
  const words = text.trim().split(/[\s+]+/).filter(Boolean);
  if (!words.length || words.length > 4) return null;
  const exact: string[] = [];
  for (const w of words) {
    const name = keyName(w, true);
    if (!name || isMouse(name)) return null;
    exact.push(name);
  }
  // one letter: also the keys whose name starts with it (S: Shift, Space)
  const prefix = words.length === 1 && /^[a-z]$/i.test(words[0]!) ? words[0]!.toLowerCase() : null;
  return { exact, prefix };
}

/**
 * A cap a key search lit: its key as the row writes it, in which way of the row and which chord of that way. Said by
 * place, not by name: "ctrl z" lights the Ctrl of Ctrl+Shift+Z, never the Ctrl of its other way, Ctrl+Y.
 */
export interface KeyHit {
  way: number;
  chord: number;
  key: string;
}

/**
 * Whether a row's keys answer a key search, and which of its caps to light: exact matches, then by the start of the
 * name. Only the chords that answer best are lit, every one of them when several answer as well.
 */
export function matchKeys(text: string, q: { exact: string[]; prefix: string | null }): { rank: number; hits: KeyHit[] } | null {
  const p = parseKeys(text);
  if (!p || "code" in p) return null;
  const same = (a: string, b: string) => a === b || ((a === "Ctrl" || a === "Meta") && (b === "Ctrl" || b === "Meta"));
  let best: { rank: number; hits: KeyHit[] } | null = null;
  const answer = (rank: number, hits: KeyHit[]) => {
    if (!best || rank < best.rank) best = { rank, hits };
    else if (rank === best.rank) best.hits.push(...hits);
  };
  p.ways.forEach((way, w) => {
    if (way.mouse) return;
    way.pair.forEach((chord, c) => {
      // every key asked for is in this chord: a direct answer (exactly that chord ranks first)
      if (q.exact.every((k) => chord.some((key) => same(key, k)))) {
        const hits = chord.filter((key) => q.exact.some((k) => same(key, k))).map((key) => ({ way: w, chord: c, key }));
        answer(chord.length === q.exact.length ? 0 : 1, hits);
      } else if (q.prefix) {
        const hit = chord.find((key) => key.length > 1 && !isMouse(key) && key.toLowerCase().startsWith(q.prefix!));
        if (hit) answer(2, [{ way: w, chord: c, key: hit }]);
      }
    });
  });
  return best;
}
