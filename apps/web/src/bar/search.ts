/**
 * The bar's render search, read by fixed rules from what is typed (docs/command-bar.md, "Searching renders"): keys and
 * their values (`video:`, `lora:dasiwa_v2`, `prompt:"red bicycle"`, `since:3d`, `kept`), a `-` in front to leave out, and
 * the words left, which look in a render's name and its prompt. Pure, run at every keystroke; what the keys mean to the
 * server is said in `toQuery`.
 */

/** The keys of a render search, as typed. */
export const SEARCH_KEYS = ["image", "video", "sound", "prompt", "lora", "model", "draft", "in", "since", "sort", "bin", "kept"] as const;
export type SearchKey = (typeof SEARCH_KEYS)[number];

/** Keys that take no value: the kind of render, the bin, kept. */
const FLAGS = new Set<SearchKey>(["image", "video", "sound", "bin", "kept"]);
/** Keys written bare, without their colon: `kept`, `-kept`. (`expiring` is said for -kept.) */
const BARE: Record<string, { key: SearchKey; not: boolean }> = { kept: { key: "kept", not: false }, expiring: { key: "kept", not: true } };

export const isFlag = (k: SearchKey) => FLAGS.has(k);

/** What each key is for, in a few words: the key rows the bar offers ("lo" → lora:). */
export const KEY_SAID: Record<SearchKey, string> = {
  image: "Pictures", video: "Videos", sound: "Sounds", prompt: "In what was written", lora: "Made with a LoRA", model: "Made with a model",
  draft: "Made from a draft", in: "In a project or folder", since: "Made since", sort: "In another order", bin: "In the bin", kept: "Kept (-kept: not kept)",
};

export interface Token {
  key: SearchKey;
  /** As typed, quotes taken off; "" for a flag, or a key with nothing after it yet. */
  value: string;
  /** Written with a `-` in front: left out. */
  not: boolean;
  /** Not typed as a key: a bare word read as one (a model's name: `klein` → model:klein), shown with a dashed chip. */
  guessed?: true;
  /** Where it is in the line, for its chip. */
  start: number;
  end: number;
}

export interface Parsed {
  tokens: Token[];
  /** The words left, in order, quotes kept around a phrase. */
  words: string;
  /** What the end of the line is in the middle of: a key's name ("lo"), or a key's value ("lora:da"); null when a space ends it. */
  typing: { key: SearchKey; value: string } | { prefix: string } | null;
}

/** One piece of the line: a word, or a phrase in quotes, with where it is. */
interface Piece { text: string; start: number; end: number }

/** The line cut at spaces, a quoted phrase kept whole (its quotes in `text`), an unclosed quote running to the end. */
function pieces(line: string): Piece[] {
  const out: Piece[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === " ") {
      i++;
      continue;
    }
    const start = i;
    let quoted = false;
    while (i < line.length && (quoted || line[i] !== " ")) {
      if (line[i] === '"') quoted = !quoted;
      i++;
    }
    out.push({ text: line.slice(start, i), start, end: i });
  }
  return out;
}

const unquote = (s: string) => s.replace(/^"|"$/g, "");

/**
 * The tokens and words of a line. `models`: the words that name a model family ("klein", "h3"): one typed bare is read
 * as model: (guessed), so that "red bicycle klein" finds Klein's red bicycles.
 */
export function parseSearch(line: string, models: readonly string[] = []): Parsed {
  const tokens: Token[] = [];
  const words: string[] = [];
  const all = pieces(line);
  const known = new Set(models.map((m) => m.toLowerCase()));
  for (const p of all) {
    const not = p.text.startsWith("-") && p.text.length > 1;
    const body = not ? p.text.slice(1) : p.text;
    const colon = /^([a-z]+):(.*)$/i.exec(body);
    const key = colon ? (colon[1]!.toLowerCase() as SearchKey) : null;
    if (key && (SEARCH_KEYS as readonly string[]).includes(key)) {
      tokens.push({ key, value: isFlag(key) ? "" : unquote(colon![2]!), not, start: p.start, end: p.end });
      // a flag's colon can be followed by words at once ("video:harbor"): they are words
      if (isFlag(key) && colon![2]) words.push(colon![2]);
      continue;
    }
    const bare = BARE[body.toLowerCase()];
    if (bare) {
      tokens.push({ key: bare.key, value: "", not: not !== bare.not, start: p.start, end: p.end });
      continue;
    }
    if (!not && known.has(body.toLowerCase())) {
      tokens.push({ key: "model", value: body.toLowerCase(), not: false, guessed: true, start: p.start, end: p.end });
      continue;
    }
    words.push(p.text);
  }
  return { tokens, words: words.join(" "), typing: typingOf(line, all) };
}

/** What the end of the line is in the middle of (no space after it): a key's name begun, or a key's value. */
function typingOf(line: string, all: Piece[]): Parsed["typing"] {
  const last = all.at(-1);
  if (!last || last.end < line.length) return null;
  const body = last.text.replace(/^-/, "");
  const colon = /^([a-z]+):(.*)$/i.exec(body);
  if (colon) {
    const key = colon[1]!.toLowerCase();
    if ((SEARCH_KEYS as readonly string[]).includes(key) && !isFlag(key as SearchKey)) return { key: key as SearchKey, value: unquote(colon[2]!) };
    return null;
  }
  return /^[a-z]{2,}$/i.test(body) && SEARCH_KEYS.some((k) => k.startsWith(body.toLowerCase()) && k !== body.toLowerCase()) ? { prefix: body.toLowerCase() } : null;
}

/** Whether a line searches renders: it has a key (`video:`, `kept`). A plain line is searched as before. */
export const isRenderSearch = (p: Parsed) => p.tokens.some((t) => !t.guessed);

/** The keys a name begun fits ("lo" → lora:), in their usual order. */
export const keysFor = (prefix: string): SearchKey[] => SEARCH_KEYS.filter((k) => k.startsWith(prefix.toLowerCase()));

/** The line with its last piece (what is being typed) replaced, a space after it (not after a key, whose value is typed next): a key or a value chosen from a list. */
export function completeLast(line: string, piece: string): string {
  const all = pieces(line);
  const last = all.at(-1);
  const head = last && last.end === line.length ? line.slice(0, last.start) : line.endsWith(" ") || !line ? line : `${line} `;
  return piece.endsWith(":") ? `${head}${piece}` : `${head}${piece} `;
}

/** A value written so it reads back as one piece: quoted when it holds a space. */
export const valueText = (v: string) => (/\s/.test(v) ? `"${v}"` : v);

/** The line without one token (board 4's "without since:today"). */
export function without(line: string, t: Pick<Token, "start" | "end">): string {
  return `${line.slice(0, t.start)}${line.slice(t.end)}`.replace(/\s+/g, " ").trim();
}

const DAY = 24 * 60 * 60_000;
/** `since:` read: today, yesterday, 3d, 2w, 1m (months of 30 days), a date; the moment it means, or null when it means none. */
export function sinceOf(v: string, now = Date.now()): Date | null {
  const s = v.toLowerCase().trim();
  if (s === "today") return new Date(new Date(now).setHours(0, 0, 0, 0));
  if (s === "yesterday") return new Date(new Date(now - DAY).setHours(0, 0, 0, 0));
  const m = /^(\d{1,3})\s*(h|d|w|m)$/.exec(s);
  if (m) return new Date(now - Number(m[1]) * { h: DAY / 24, d: DAY, w: 7 * DAY, m: 30 * DAY }[m[2] as "h" | "d" | "w" | "m"]);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** The orders `sort:` takes, as the library's list says them. */
export const SORTS = { newest: "newest", oldest: "oldest", name: "name", size: "size" } as const;
