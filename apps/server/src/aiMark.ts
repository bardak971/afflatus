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

const xmpPacket = () =>
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

/**
 * A PNG with the mark: an XMP packet (iTXt) and a comment (tEXt) put just before its end, its pictures untouched. A PNG
 * holds one XMP packet at most, so one that has its own keeps it and gets the comment alone. Anything that is not a whole
 * PNG comes back as it was.
 */
export function markPng(bytes: Uint8Array): Uint8Array {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return bytes;
  let at = 8;
  let end = -1;
  let hasXmp = false;
  while (at + 12 <= buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    if (type === "IEND") {
      end = at;
      break;
    }
    if (type === "iTXt" && buf.toString("latin1", at + 8, at + 8 + XMP_KEY.length + 1) === `${XMP_KEY}\0`) hasXmp = true;
    if (type === "tEXt" && buf.toString("latin1", at + 8, at + 8 + 8) === "Comment\0" && buf.toString("latin1", at + 16, at + 8 + length) === AI_COMMENT) return bytes;
    at += 12 + length;
  }
  if (end < 0) return bytes;
  const added = [
    // iTXt: keyword, no compression, no language, no translated keyword, the text in UTF-8
    ...(hasXmp ? [] : [chunk("iTXt", Buffer.concat([Buffer.from(`${XMP_KEY}\0\0\0\0\0`, "latin1"), Buffer.from(xmpPacket(), "utf8")]))]),
    chunk("tEXt", Buffer.from(`Comment\0${AI_COMMENT}`, "latin1")),
  ];
  return new Uint8Array(Buffer.concat([buf.subarray(0, end), ...added, buf.subarray(end)]));
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
