import { AI_COMMENT, isPng, markPng, withoutTexts, xmpPacket } from "./aiMark";

/**
 * The words a JPEG or a WebP carries, as they leave Afflatus: the same treatment as a PNG's (aiMark.ts), without a picture
 * library and without touching a pixel. A JPEG holds them in APPn segments and COM (EXIF with a camera's GPS and serial,
 * A1111's "parameters" in EXIF UserComment, XMP, Photoshop's IPTC) and sometimes past its end (a phone's trailer, the
 * pictures of an MPF file); a WebP in its EXIF and XMP chunks. Dropped, they leave only what Afflatus puts in on purpose
 * (review 2026-11-05b N3): the mark on a render, and its parameters while Settings says so.
 */

const JPEG_SOI = 0xd8;
const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP14 = 0xee;
const COM = 0xfe;

/** Whether the bytes start as a JPEG does. */
export const isJpeg = (buf: Buffer) => buf.length >= 4 && buf[0] === 0xff && buf[1] === JPEG_SOI && buf[2] === 0xff;
/** Whether the bytes are a RIFF WebP. */
export const isWebp = (buf: Buffer) => buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP";

/**
 * A JPEG's segments in order up to its first scan (SOS, given too, the walk stopping after it), each with its marker, where
 * it starts and ends and its data (after the length): the one walk the reader (embedded.ts) and the stripping make. A
 * segment cut short is given with `end` past the bytes, and the walk stops after it; so it does at a byte that is no marker.
 * For bytes isJpeg took.
 */
export function* jpegSegments(buf: Buffer): Generator<{ marker: number; at: number; end: number; data: Buffer }> {
  for (let pos = 2; pos + 4 <= buf.length && buf[pos] === 0xff; ) {
    const marker = buf[pos + 1]!;
    // fill bytes before a marker
    if (marker === 0xff) {
      pos++;
      continue;
    }
    const end = pos + 2 + buf.readUInt16BE(pos + 2);
    yield { marker, at: pos, end, data: buf.subarray(pos + 4, Math.min(end, buf.length)) };
    if (marker === JPEG_SOS || end > buf.length) return;
    pos = end;
  }
}

/**
 * A JPEG's segments before its first scan, then `scan`: where the scan starts (its SOS segment), and `end`: just past the
 * EOI that closes the picture, the scan's entropy-coded bytes walked (a 0xFF there is always followed by 0x00 or a restart
 * marker), so that a progressive file's later tables and scans are stepped over by their lengths. Null for anything this
 * cannot walk whole: a segment cut short, a stray byte, no end.
 */
export function jpegLayout(buf: Buffer): { segments: Array<{ marker: number; at: number; end: number; data: Buffer }>; scan: number; end: number } | null {
  if (!isJpeg(buf)) return null;
  const segments = [...jpegSegments(buf)];
  const sos = segments.pop();
  if (!sos || sos.marker !== JPEG_SOS || sos.end > buf.length) return null;
  const scan = sos.at;
  for (let pos = scan; pos + 2 <= buf.length; ) {
    if (buf[pos] !== 0xff) return null;
    if (buf[pos + 1] === JPEG_EOI) return { segments, scan, end: pos + 2 };
    if (pos + 4 > buf.length) return null;
    // a segment (the first SOS, a progressive file's tables, the next SOS): its length, then the entropy-coded bytes after it
    pos += 2 + buf.readUInt16BE(pos + 2);
    while (pos + 1 < buf.length && !(buf[pos] === 0xff && buf[pos + 1] !== 0 && (buf[pos + 1]! < 0xd0 || buf[pos + 1]! > 0xd7))) pos++;
  }
  return null;
}

/**
 * A WebP's chunks in order after its header, each with its id, where it starts and ends (its padding byte in) and its data:
 * the one walk the reader (embedded.ts) and the stripping make. A chunk cut short is given with `end` past the bytes and the
 * data that is there, and the walk stops after it. For bytes isWebp took.
 */
export function* webpChunks(buf: Buffer): Generator<{ id: string; at: number; end: number; data: Buffer }> {
  for (let pos = 12; pos + 8 <= buf.length; ) {
    const len = buf.readUInt32LE(pos + 4);
    const end = pos + 8 + len + (len % 2);
    yield { id: buf.toString("latin1", pos, pos + 4), at: pos, end, data: buf.subarray(pos + 8, Math.min(pos + 8 + len, buf.length)) };
    if (pos + 8 + len > buf.length) return;
    pos = end;
  }
}

/**
 * The EXIF orientation (tag 0x0112) of a TIFF block (EXIF's body, "Exif\0\0" in front or not), or null. Kept when the rest
 * goes: a phone photo stored on its side is turned upright by it, and dropping it would turn the download.
 */
function orientationOf(exif: Buffer): number | null {
  const t = exif.toString("latin1", 0, 6) === "Exif\0\0" ? exif.subarray(6) : exif;
  if (t.length < 8) return null;
  const le = t.toString("latin1", 0, 2) === "II";
  if (!le && t.toString("latin1", 0, 2) !== "MM") return null;
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const ifd = le ? t.readUInt32LE(4) : t.readUInt32BE(4);
  if (ifd + 2 > t.length) return null;
  for (let i = 0, n = u16(ifd); i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) return null;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** The longest an EXIF block may be in a JPEG's APP1 (its 16-bit length, the "Exif\0\0" and the length's own bytes out). */
const EXIF_MOST = 0xffff - 2 - 6;

/**
 * A TIFF block (big-endian, as EXIF allows) holding only what is asked: the orientation (when it turns the picture) and a
 * UserComment, where A1111 writes its "parameters" for JPEG and WebP (and embedded.ts reads them back). The comment is
 * ASCII when it can be (half the size), else UNICODE in UTF-16. Null when there is nothing to hold; the comment left out
 * when it would not fit a JPEG's segment.
 */
export function exifBlock(o: { orientation?: number | null; comment?: string }): Buffer | null {
  const ascii = o.comment !== undefined && /^[\x00-\x7f]*$/.test(o.comment);
  let comment = o.comment ? Buffer.concat([Buffer.from(ascii ? "ASCII\0\0\0" : "UNICODE\0", "latin1"), ascii ? Buffer.from(o.comment, "latin1") : Buffer.from(o.comment, "utf16le").swap16()]) : null;
  const turned = o.orientation && o.orientation !== 1 ? o.orientation : null;
  // header 8, IFD0 2 + 12 a tag + 4, the EXIF IFD 2 + 12 + 4, then the comment
  if (comment && 8 + 2 + 24 + 4 + 18 + comment.length > EXIF_MOST) comment = null;
  if (!turned && !comment) return null;
  const tags = (turned ? 1 : 0) + (comment ? 1 : 0);
  const ifd0 = 8;
  const exifIfd = ifd0 + 2 + tags * 12 + 4;
  const at = exifIfd + 18;
  const t = Buffer.alloc(comment ? at + comment.length : exifIfd);
  t.write("MM\0*", 0, "latin1");
  t.writeUInt32BE(ifd0, 4);
  t.writeUInt16BE(tags, ifd0);
  let e = ifd0 + 2;
  if (turned) {
    // Orientation, SHORT, one value, held in the entry itself
    t.writeUInt16BE(0x0112, e);
    t.writeUInt16BE(3, e + 2);
    t.writeUInt32BE(1, e + 4);
    t.writeUInt16BE(turned, e + 8);
    e += 12;
  }
  if (comment) {
    // the EXIF IFD's pointer (LONG), then that IFD with UserComment (UNDEFINED) pointing at the text
    t.writeUInt16BE(0x8769, e);
    t.writeUInt16BE(4, e + 2);
    t.writeUInt32BE(1, e + 4);
    t.writeUInt32BE(exifIfd, e + 8);
    t.writeUInt16BE(1, exifIfd);
    t.writeUInt16BE(0x9286, exifIfd + 2);
    t.writeUInt16BE(7, exifIfd + 4);
    t.writeUInt32BE(comment.length, exifIfd + 6);
    t.writeUInt32BE(at, exifIfd + 10);
    comment.copy(t, at);
  }
  return t;
}

/** A JPEG segment of this marker and data. */
function segment(marker: number, data: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}

const XMP_NS = "http://ns.adobe.com/xap/1.0/\0";

/**
 * What a JPEG keeps of its segments: the picture's own (its tables, frame, restart interval), JFIF's APP0, the colour
 * profile (APP2's ICC_PROFILE, which changes how it looks) and Adobe's APP14 (how its colours are coded). Everything else
 * is words: APP1's EXIF and XMP, APP2's MPF and FlashPix, APP3 to APP13 (Photoshop's IPTC, Ducky…), APP15 and COM.
 */
const keptSegment = (marker: number, data: Buffer) =>
  marker < APP0 || (marker > 0xef && marker !== COM) || marker === APP0 || marker === APP14 || (marker === APP2 && data.toString("latin1", 0, 12) === "ICC_PROFILE\0");

/**
 * A JPEG without the words it came with, past its end included, its pictures untouched; with the mark (XMP and a comment)
 * and the comment's "parameters" in EXIF when asked; the orientation kept. Anything this cannot walk whole comes back as
 * it was.
 */
function jpegOut(bytes: Uint8Array, o: { mark: boolean; parameters?: string }): Uint8Array {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const layout = jpegLayout(buf);
  if (!layout) return bytes;
  const exif = layout.segments.find((s) => s.marker === APP1 && s.data.toString("latin1", 0, 6) === "Exif\0\0");
  const orientation = exif ? orientationOf(exif.data) : null;
  const kept = layout.segments.filter((s) => keptSegment(s.marker, s.data));
  // JFIF's APP0 stays first, as its standard wants; the new segments go right after it
  const lead = kept[0]?.marker === APP0 ? 1 : 0;
  const block = exifBlock({ orientation, comment: o.mark ? o.parameters : undefined });
  const added = [
    ...(block ? [segment(APP1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), block]))] : []),
    ...(o.mark ? [segment(APP1, Buffer.from(XMP_NS + xmpPacket(), "utf8")), segment(COM, Buffer.from(AI_COMMENT, "latin1"))] : []),
  ];
  return new Uint8Array(Buffer.concat([
    buf.subarray(0, 2),
    ...kept.slice(0, lead).map((s) => buf.subarray(s.at, s.end)),
    ...added,
    ...kept.slice(lead).map((s) => buf.subarray(s.at, s.end)),
    buf.subarray(layout.scan, layout.end),
  ]));
}

/** A RIFF chunk of this id and data, padded to an even length. */
function riffChunk(id: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(id, 0, "latin1");
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, ...(data.length % 2 ? [Buffer.alloc(1)] : [])]);
}

/** The picture's chunks of a WebP, and its colour profile: everything else (EXIF, XMP, a tool's own) is words. */
const WEBP_KEPT = new Set(["VP8X", "VP8 ", "VP8L", "ALPH", "ANIM", "ANMF", "ICCP"]);
const VP8X_XMP = 0x04;
const VP8X_EXIF = 0x08;
const VP8X_ALPHA = 0x10;

/**
 * The VP8X chunk a plain WebP (one VP8 or VP8L, no VP8X) needs to hold EXIF or XMP: its canvas read off the bitstream
 * (VP8: 14 bits each after the start code; VP8L: 14 bits each after its signature, then the alpha bit). Null when the
 * bitstream is not one this reads.
 */
function vp8xFor(chunks: ReadonlyArray<{ id: string; data: Buffer }>): Buffer | null {
  const lossy = chunks.find((c) => c.id === "VP8 ");
  const lossless = chunks.find((c) => c.id === "VP8L");
  let w: number;
  let h: number;
  let alpha = false;
  if (lossy && lossy.data.length >= 10 && lossy.data[3] === 0x9d && lossy.data[4] === 0x01 && lossy.data[5] === 0x2a) {
    w = lossy.data.readUInt16LE(6) & 0x3fff;
    h = lossy.data.readUInt16LE(8) & 0x3fff;
  } else if (lossless && lossless.data.length >= 5 && lossless.data[0] === 0x2f) {
    const bits = lossless.data.readUInt32LE(1);
    w = (bits & 0x3fff) + 1;
    h = ((bits >>> 14) & 0x3fff) + 1;
    alpha = ((bits >>> 28) & 1) === 1;
  } else return null;
  const v = Buffer.alloc(10);
  v[0] = alpha ? VP8X_ALPHA : 0;
  v.writeUIntLE(w - 1, 4, 3);
  v.writeUIntLE(h - 1, 7, 3);
  return v;
}

/**
 * A WebP without the words it came with, its pictures untouched; with the mark (XMP) and the "parameters" in EXIF when
 * asked; the orientation kept. VP8X's flags say what is left. Anything this cannot walk whole comes back as it was.
 */
function webpOut(bytes: Uint8Array, o: { mark: boolean; parameters?: string }): Uint8Array {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!isWebp(buf)) return bytes;
  const chunks = [...webpChunks(buf)];
  // a chunk cut short is not a WebP this can read: left whole rather than half-cleaned
  if (chunks.some((c) => c.data.length < buf.readUInt32LE(c.at + 4))) return bytes;
  const exif = chunks.find((c) => c.id === "EXIF");
  const block = exifBlock({ orientation: exif ? orientationOf(exif.data) : null, comment: o.mark ? o.parameters : undefined });
  const xmp = o.mark ? Buffer.from(xmpPacket(), "utf8") : null;
  const kept = chunks.filter((c) => WEBP_KEPT.has(c.id));
  let head = kept.find((c) => c.id === "VP8X")?.data;
  if (!head && (block || xmp)) {
    const made = vp8xFor(kept);
    // a bitstream this does not read: the words still go, without the mark rather than with a wrong canvas
    if (made) head = made;
  }
  const vp8x = head ? Buffer.concat([Buffer.from([(head[0]! & ~(VP8X_EXIF | VP8X_XMP)) | (block ? VP8X_EXIF : 0) | (xmp ? VP8X_XMP : 0)]), head.subarray(1)]) : null;
  const body = Buffer.concat([
    ...(vp8x ? [riffChunk("VP8X", vp8x)] : []),
    // each written again with its padding byte, which a file's last chunk sometimes lacks
    ...kept.filter((c) => c.id !== "VP8X").map((c) => riffChunk(c.id, c.data)),
    // EXIF and XMP go last, as the container's order wants, and only where a VP8X says they are there
    ...(vp8x && block ? [riffChunk("EXIF", block)] : []),
    ...(vp8x && xmp ? [riffChunk("XMP ", xmp)] : []),
  ]);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(body.length + 4, 4);
  riff.write("WEBP", 8, "latin1");
  return new Uint8Array(Buffer.concat([riff, body]));
}

/** The kinds of picture whose words are dealt with on the way out; any other file leaves as it is stored. */
export const WORDED_PICTURES = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * A picture of the library as it leaves, by what its bytes are: without the words it came with, then, for a render, with
 * the mark and `texts` (a PNG takes them all, a JPEG or a WebP its "parameters" in EXIF, as A1111 writes it). Anything else
 * comes back as it was.
 */
export function pictureOut(bytes: Uint8Array, o: { mark: boolean; texts?: Record<string, string> }): Uint8Array {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isPng(buf)) return o.mark ? markPng(withoutTexts(bytes), o.texts) : withoutTexts(bytes);
  const asked = { mark: o.mark, parameters: o.texts?.parameters };
  if (isJpeg(buf)) return jpegOut(bytes, asked);
  if (isWebp(buf)) return webpOut(bytes, asked);
  return bytes;
}
