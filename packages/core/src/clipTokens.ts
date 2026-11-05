/**
 * How many CLIP tokens a prompt takes, and how ComfyUI cuts them into chunks of 75 (SDXL and SD 1.5: each chunk is encoded
 * apart and the results are joined, so a tag cut in two by a chunk's end loses some of its sense). The count is A1111's
 * "42/75"; the chunks are ComfyUI's, which is what renders: its CLIPTextEncode tokenizes each weighted part of the prompt
 * on its own ("(red dress:1.2)" is one part) and moves a part shorter than 8 tokens whole into the next chunk rather than
 * cut it (comfy/sd1_clip.py, tokenize_with_weights).
 *
 * The exact count needs CLIP's BPE merges (`merges.txt`, the file ComfyUI ships in comfy/sd1_tokenizer); without them,
 * `estimatePieces` guesses from the words, and the caller says it is a guess.
 */

/** Tokens in one chunk: CLIP takes 77, the start and end tokens take two. */
export const CLIP_CHUNK = 75;

/**
 * An SDXL text as its CLIPTextEncode is sent it: the checkpoint's quality tags in front, then the prompt (a settled wildcard
 * can end in a separator: what is sent is what the record says). The recipes encode it and the form counts its tokens from
 * it, so that "60/75" is the chunk the render fills, quality tags and all (card #300).
 */
export const withQuality = (quality: string, prompt: string) => [quality.trim().replace(/,\s*$/, ""), prompt].filter(Boolean).join(", ");
/** A weighted part of this many tokens or more is cut at a chunk's end; a shorter one goes whole into the next chunk. */
const LONG_PART = 8;
/** The merges CLIP's tokenizer reads from its file (the first line is a header): 49152 − 256 − 2. */
const MERGES = 48894;

/** ComfyUI's escaped brackets, kept out of the weight parsing as it keeps them (escape_important). */
const ESC_CLOSE = "\0\u0001";
const ESC_OPEN = "\0\u0002";

/** The top-level groups of a text: a bracketed one with its brackets, the text between as it is (parse_parentheses). */
function groups(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let depth = 0;
  for (const c of text) {
    if (c === "(") {
      if (depth === 0) {
        if (current) out.push(current);
        current = "(";
      } else current += c;
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) {
        out.push(`${current})`);
        current = "";
      } else current += c;
    } else current += c;
  }
  if (current) out.push(current);
  return out;
}

/** Python's float() on a weight: digits with a point or an exponent, spaces around allowed. */
const WEIGHT = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/;

/** The parts of a prompt as ComfyUI weighs them, their brackets and weights taken out (token_weights). */
function weightedParts(text: string): string[] {
  const out: string[] = [];
  for (const g of groups(text)) {
    if (g.length >= 2 && g.startsWith("(") && g.endsWith(")")) {
      let inner = g.slice(1, -1);
      const colon = inner.lastIndexOf(":");
      if (colon > 0 && WEIGHT.test(inner.slice(colon + 1))) inner = inner.slice(0, colon);
      out.push(...weightedParts(inner));
    } else out.push(g);
  }
  return out;
}

/** A prompt's parts as ComfyUI tokenizes them, each on its own: weights and brackets out, `\(` and `\)` back as brackets. */
export function promptParts(text: string): string[] {
  const escaped = text.replaceAll("\\)", ESC_CLOSE).replaceAll("\\(", ESC_OPEN);
  return weightedParts(escaped).map((p) => p.replaceAll(ESC_CLOSE, ")").replaceAll(ESC_OPEN, "(")).filter((p) => p !== "");
}

/** CLIP's split of a cleaned text into the pieces BPE works on: words, single digits, runs of other signs. */
const PIECE = /'s|'t|'re|'ve|'m|'ll|'d|\p{L}+|\p{N}|[^\s\p{L}\p{N}]+/gu;

/** A text as CLIP's tokenizer reads it: spaces folded into one, trimmed, lower case. */
const cleaned = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

/** The pieces of a text that BPE is run on, each as its own word. */
export const clipPieces = (text: string): string[] => cleaned(text).match(PIECE) ?? [];

/** GPT-2's map of bytes to printable characters, which CLIP's merges are written in. */
function byteChars(): string[] {
  const keep = new Set<number>();
  for (let b = 33; b <= 126; b++) keep.add(b);
  for (let b = 161; b <= 172; b++) keep.add(b);
  for (let b = 174; b <= 255; b++) keep.add(b);
  const out: string[] = [];
  let extra = 0;
  for (let b = 0; b < 256; b++) out[b] = String.fromCodePoint(keep.has(b) ? b : 256 + extra++);
  return out;
}
const BYTE_CHARS = byteChars();
const utf8 = new TextEncoder();

/** One piece as BPE's starting symbols: its bytes as characters, the last one marked as a word's end. */
function symbols(piece: string): string[] {
  const out = [...utf8.encode(piece)].map((b) => BYTE_CHARS[b]!);
  if (out.length) out[out.length - 1] += "</w>";
  return out;
}

/**
 * CLIP's byte-pair encoding, from the text of a merges file: a counter of the tokens a piece of text (one of `clipPieces`)
 * becomes. Each piece is worked out once. `applied`, when given, collects the merges used (the tests keep only those).
 */
export function clipBpe(merges: string, applied?: Set<string>): (piece: string) => number {
  const rank = new Map<string, number>();
  const lines = merges.split(/\r?\n/);
  // the first line is the file's header ("#version: 0.2")
  for (let i = 1; i < lines.length && rank.size < MERGES; i++) {
    const line = lines[i]!.trim();
    if (line && !rank.has(line)) rank.set(line, i - 1);
  }
  const seen = new Map<string, number>();
  return (piece) => {
    const known = seen.get(piece);
    if (known !== undefined) return known;
    let word = symbols(piece);
    while (word.length > 1) {
      let best: string | null = null;
      let bestRank = Infinity;
      for (let i = 0; i < word.length - 1; i++) {
        const r = rank.get(`${word[i]} ${word[i + 1]}`);
        if (r !== undefined && r < bestRank) {
          bestRank = r;
          best = `${word[i]} ${word[i + 1]}`;
        }
      }
      if (best === null) break;
      applied?.add(best);
      const [a, b] = best.split(" ") as [string, string];
      // every place the pair is, left to right, as CLIP's tokenizer merges it
      const next: string[] = [];
      for (let i = 0; i < word.length; i++) {
        if (word[i] === a && word[i + 1] === b) {
          next.push(a + b);
          i++;
        } else next.push(word[i]!);
      }
      word = next;
    }
    seen.set(piece, word.length);
    return word.length;
  };
}

/**
 * A guess at the tokens a piece takes, without the merges: a digit or a sign is one each (CLIP keeps most signs apart); a
 * word of up to 7 letters is mostly one, a longer one about one per 5 letters. Off by a few on a long prompt of rare words.
 */
export function estimatePieces(piece: string): number {
  if (!/\p{L}/u.test(piece)) return [...piece].length;
  return piece.length <= 7 ? 1 : Math.ceil(piece.length / 5);
}

/**
 * The tokens of each chunk a prompt fills, as ComfyUI cuts them (at least one chunk, which may be empty). `count` gives
 * the tokens of one piece: `clipBpe`'s, or `estimatePieces`.
 */
export function clipChunks(text: string, count: (piece: string) => number): number[] {
  const chunks = [0];
  for (const part of promptParts(text)) {
    let left = clipPieces(part).reduce((n, p) => n + count(p), 0);
    const long = left >= LONG_PART;
    while (left > 0) {
      const room = CLIP_CHUNK - chunks[chunks.length - 1]!;
      if (left <= room) {
        chunks[chunks.length - 1]! += left;
        break;
      }
      // a long part fills this chunk and goes on in the next; a short one goes whole into the next
      if (long) {
        chunks[chunks.length - 1]! += room;
        left -= room;
      }
      chunks.push(0);
    }
  }
  return chunks;
}
