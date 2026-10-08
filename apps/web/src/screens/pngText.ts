/** A zlib stream unpacked by the browser: a PNG's compressed text chunks (zTXt, compressed iTXt). */
async function inflate(data: Uint8Array): Promise<string> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Response(stream).text();
}

/** The text chunks of a PNG (tEXt, zTXt and iTXt, compressed or not): ComfyUI writes the workflow into one named "workflow". */
export async function pngText(bytes: Uint8Array): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
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
        out[key] = compressed ? await inflate(body).catch(() => "") : new TextDecoder().decode(body);
      }
    }
    if (type === "IEND") break;
    p += 12 + len;
  }
  return out;
}
