/**
 * How much a PNG's compressed text may unpack to, per chunk and in all. A stranger's file can carry a
 * few kilobytes that unpack to gigabytes (a "decompression bomb"); a ComfyUI workflow is far smaller
 * than this, and a chunk past it is not read. The server reads with the same limits (embedded.ts).
 */
export const TEXT_CHUNK_MAX = 1 << 20;
export const TEXT_TOTAL_MAX = 4 << 20;

/** A zlib stream unpacked by the browser: a PNG's compressed text chunks (zTXt, compressed iTXt). Throws past `max` bytes, having stopped reading there. */
async function inflate(data: Uint8Array, max: number): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      // the rest is never unpacked: cancelling stops the decompressor where it is
      await reader.cancel().catch(() => {});
      throw new Error("compressed text past the limit");
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The text chunks of a PNG (tEXt, zTXt and iTXt, compressed or not): ComfyUI writes the workflow into one named "workflow". */
export async function pngText(bytes: Uint8Array): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let left = TEXT_TOTAL_MAX;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const latin = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  let p = 8;
  while (p + 8 <= bytes.length) {
    const len = view.getUint32(p);
    const type = latin(p + 4, p + 8);
    const data = bytes.subarray(p + 8, p + 8 + len);
    if (type === "tEXt" || type === "iTXt" || type === "zTXt") {
      const zero = data.indexOf(0);
      if (zero > 0) {
        const key = latin(p + 8, p + 8 + zero);
        let q = zero + 1;
        // zTXt: a compression method byte, then the compressed text; iTXt: a compressed flag and method, a language and a translated key
        let compressed = type === "zTXt";
        if (type === "zTXt") q += 1;
        if (type === "iTXt") {
          compressed = data[q] === 1;
          q += 2;
          q = data.indexOf(0, q) + 1;
          q = data.indexOf(0, q) + 1;
        }
        const body = data.subarray(q);
        if (compressed) {
          const text = await inflate(body, Math.min(TEXT_CHUNK_MAX, left)).catch(() => null);
          left -= text?.length ?? 0;
          out[key] = text ? new TextDecoder().decode(text) : "";
        } else out[key] = new TextDecoder().decode(body);
      }
    }
    if (type === "IEND") break;
    p += 12 + len;
  }
  return out;
}
