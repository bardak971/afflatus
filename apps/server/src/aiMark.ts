import { crc32 } from "node:zlib";
import type { Db } from "./db";
import type { AssetRow } from "./timelineModel";

/**
 * The mark that says a file was made by a model, put on what leaves Afflatus from a render: a download of a picture or a
 * video of the library, a timeline export holding a render, the files of the zip for a video editor. What the user brought
 * in (an imported photo, a film of their own, a copy or a cut of one) is never marked. The library's own files stay as
 * ComfyUI wrote them: the mark is added on the way out, so measures, digests and latents keep reading the same bytes.
 *
 * Pictures carry the IPTC "digital source type" in XMP, the field platforms read for AI labels, and a plain comment;
 * videos carry the comment (ffmpeg's `comment`, MP4's ©cmt). The EU AI Act (Art. 50) asks for a machine-readable mark.
 */
export const AI_COMMENT = "AI-generated (Afflatus)";

/** IPTC's term for media made by a trained model. */
export const AI_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";

/** The options an ffmpeg command that writes a video adds to mark it. */
export const aiVideoArgs = ["-metadata", `comment=${AI_COMMENT}`];

const XMP_KEY = "XML:com.adobe.xmp";

/** The XMP packet of the mark: IPTC's digital source type. A JPEG and a WebP carry it too (pictureWords.ts). */
export const xmpPacket = () =>
  `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
  `<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" Iptc4xmpExt:DigitalSourceType="${AI_SOURCE_TYPE}"/>` +
  `</rdf:RDF></x:xmpmeta><?xpacket end="r"?>`;

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Whether the bytes start as a PNG does. */
export const isPng = (buf: Buffer) => buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);

/**
 * A PNG's chunks in order, up to its IEND (given too), each with where it starts and ends and its data: the one walk the
 * mark, the stripping of texts and the reader (embedded.ts) make. A chunk cut short is given with `end` past the bytes and
 * the data that is there, and the walk stops after it. For bytes isPng took.
 */
export function* pngChunks(buf: Buffer): Generator<{ type: string; at: number; end: number; data: Buffer }> {
  for (let at = 8; at + 12 <= buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    const end = at + 12 + length;
    yield { type, at, end, data: buf.subarray(at + 8, at + 8 + length) };
    if (type === "IEND" || end > buf.length) return;
    at = end;
  }
}

/**
 * A text chunk: tEXt for plain ASCII, the one every reader takes; anything else (an accent, another script) iTXt,
 * uncompressed and in UTF-8. tEXt is Latin-1 by the standard, which PIL (so A1111) follows and other readers do not
 * (they read UTF-8): a "café" there reads right in only half of them, iTXt in all.
 */
function textChunk(key: string, text: string): Buffer {
  return /^[\x00-\x7f]*$/.test(text)
    ? chunk("tEXt", Buffer.from(`${key}\0${text}`, "latin1"))
    : chunk("iTXt", Buffer.concat([Buffer.from(`${key}\0\0\0\0\0`, "latin1"), Buffer.from(text, "utf8")]));
}

/**
 * A PNG with the mark: an XMP packet (iTXt) and a comment (tEXt) put just before its end, its pictures untouched. A PNG
 * holds one XMP packet at most, so one that has its own keeps it and gets the comment alone. Anything that is not a whole
 * PNG comes back as it was. `texts` go in beside the mark (the generation parameters, pngInfo.ts), each keyword only when
 * the file has no text of that name already: a file holds one "parameters", and the one it came with is kept.
 */
export function markPng(bytes: Uint8Array, texts: Record<string, string> = {}): Uint8Array {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!isPng(buf)) return bytes;
  let end = -1;
  let hasXmp = false;
  const had = new Set<string>();
  for (const c of pngChunks(buf)) {
    if (c.type === "IEND") {
      end = c.at;
      break;
    }
    if (c.type === "tEXt" || c.type === "iTXt" || c.type === "zTXt") {
      const nul = c.data.indexOf(0);
      if (nul > 0) had.add(c.data.toString("latin1", 0, nul));
    }
    if (c.type === "iTXt" && c.data.toString("latin1", 0, XMP_KEY.length + 1) === `${XMP_KEY}\0`) hasXmp = true;
    if (c.type === "tEXt" && c.data.toString("latin1", 0, 8) === "Comment\0" && c.data.toString("latin1", 8) === AI_COMMENT) return bytes;
  }
  if (end < 0) return bytes;
  const added = [
    // iTXt: keyword, no compression, no language, no translated keyword, the text in UTF-8
    ...(hasXmp ? [] : [chunk("iTXt", Buffer.concat([Buffer.from(`${XMP_KEY}\0\0\0\0\0`, "latin1"), Buffer.from(xmpPacket(), "utf8")]))]),
    chunk("tEXt", Buffer.from(`Comment\0${AI_COMMENT}`, "latin1")),
    ...Object.entries(texts).filter(([key, text]) => text && !had.has(key)).map(([key, text]) => textChunk(key, text)),
  ];
  return new Uint8Array(Buffer.concat([buf.subarray(0, end), ...added, buf.subarray(end)]));
}

/**
 * The chunks that carry words rather than the picture: texts (ComfyUI's own "prompt" and "workflow", the whole graph with
 * every model's and LoRA's sub-folder, upload names and an imported workflow's paths; a tool's XMP, which can hold a
 * document's path) and EXIF (a camera's place and serial). None of them changes a pixel.
 */
const WORDS = new Set(["tEXt", "zTXt", "iTXt", "eXIf"]);

/**
 * A PNG without any of the words it came with (WORDS), its pictures untouched, so that what leaves says only what
 * Afflatus puts in on purpose (markPng's mark, pngInfo.ts's texts). Anything that is not a whole PNG comes back as it was.
 */
export function withoutTexts(bytes: Uint8Array): Uint8Array {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!isPng(buf)) return bytes;
  const kept: Buffer[] = [buf.subarray(0, 8)];
  let dropped = false;
  for (const c of pngChunks(buf)) {
    // a chunk cut short is not a PNG this can read: left whole rather than half-cleaned
    if (c.end > buf.length) return bytes;
    if (WORDS.has(c.type)) dropped = true;
    else kept.push(buf.subarray(c.at, c.end));
    if (c.type === "IEND") return dropped ? new Uint8Array(Buffer.concat(kept)) : bytes;
  }
  return bytes;
}

/** How far back a copy of a copy is followed: further is a loop, or a chain nobody makes. */
const MAX_DEPTH = 8;

/**
 * Whether a file of the library came out of a render: a render itself, or a frame, a cut or an edit of one (followed
 * back through what it was taken from). An export says it at its making (aiVideoArgs), from the clips it holds, and is
 * not marked again on its way out.
 */
export async function fromRender(db: Db, asset: Pick<AssetRow, "origin" | "source_id">): Promise<boolean> {
  let at: Pick<AssetRow, "origin" | "source_id"> | undefined = asset;
  for (let depth = 0; at && depth < MAX_DEPTH; depth++) {
    if (at.origin === "generated") return true;
    if (!(at.origin === "frame" || at.origin === "cut" || at.origin === "edited") || !at.source_id) return false;
    at = await db.selectFrom("assets").select(["origin", "source_id"]).where("id", "=", at.source_id).executeTakeFirst();
  }
  return false;
}
