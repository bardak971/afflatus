import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

/**
 * Answers compressed for a browser that takes it: the API's JSON and the web app's own files (scripts, styles, the page),
 * with node's zlib (Brotli, else gzip). Over the LAN or a tunnel a first load is about a fifth of its size. Never pictures,
 * videos or sounds (compressed already), a part of a file (a Range read of a video), the live events (a stream that never
 * ends), or a small answer (the header costs more than it saves).
 */

/** The smallest answer worth compressing. */
const AT_LEAST = 1024;
/** What compresses: text of any kind, JSON, scripts, SVG and XML. */
const TEXT = /^(text\/(?!event-stream)|application\/(json|javascript|xml|manifest\+json)|image\/svg\+xml)/i;
/** The web app's built files, named by their content: compressed once, well, and kept, up to so many bytes. */
const KEPT_UP_TO = 64 * 1024 * 1024;

const br = promisify(brotliCompress);
const gz = promisify(gzip);

export type Encoding = "br" | "gzip";

/** What the browser takes, Brotli first: none when it takes neither (or refuses both with q=0). */
export function encodingFor(accept: string | undefined): Encoding | null {
  if (!accept) return null;
  const taken = new Map<string, number>();
  for (const part of accept.toLowerCase().split(",")) {
    const [name = "", ...params] = part.trim().split(";");
    const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
    taken.set(name.trim(), q === undefined ? 1 : Number(q));
  }
  const ok = (name: string) => (taken.get(name) ?? taken.get("*") ?? 0) > 0;
  return ok("br") ? "br" : ok("gzip") ? "gzip" : null;
}

/**
 * Bytes compressed: Brotli at `quality` (4 for an answer made now; 9 for a file kept, within a tenth of its best and twenty
 * times as fast: 11 took half a second for the main script, holding zlib's threads, and the disk reads behind them, that long),
 * or gzip at its usual level.
 */
async function compress(bytes: Buffer, how: Encoding, quality = 4): Promise<Buffer> {
  return how === "br"
    ? br(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT } })
    : gz(bytes);
}

async function bytesOf(payload: unknown): Promise<Buffer | null> {
  if (typeof payload === "string") return Buffer.from(payload);
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Readable) {
    const parts: Buffer[] = [];
    for await (const chunk of payload) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    return Buffer.concat(parts);
  }
  return null;
}

/** Adds "Accept-Encoding" to what the answer says it varies by, once. */
function varyByEncoding(reply: FastifyReply): void {
  const was = reply.getHeader("vary");
  const list = (Array.isArray(was) ? was.join(",") : String(was ?? "")).split(",").map((v) => v.trim()).filter(Boolean);
  if (list.includes("*") || list.some((v) => v.toLowerCase() === "accept-encoding")) return;
  void reply.header("vary", [...list, "Accept-Encoding"].join(", "));
}

export function registerCompression(app: FastifyInstance): void {
  // the built files, by path, size and time: a rebuilt bundle has new names, and a file changed in place another time
  const kept = new Map<string, Buffer>();
  let keptBytes = 0;
  const keep = (key: string, bytes: Buffer) => {
    if (keptBytes + bytes.length > KEPT_UP_TO) return;
    kept.set(key, bytes);
    keptBytes += bytes.length;
  };

  app.addHook("onSend", async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    if (req.method === "HEAD" || payload === null || payload === undefined) return payload;
    if (reply.statusCode === 204 || reply.statusCode === 206 || reply.statusCode === 304 || req.headers.range) return payload;
    if (reply.getHeader("content-encoding") || reply.getHeader("content-range")) return payload;
    const type = String(reply.getHeader("content-type") ?? "");
    if (!TEXT.test(type)) return payload;
    const length = Number(reply.getHeader("content-length") ?? (typeof payload === "string" ? Buffer.byteLength(payload) : Buffer.isBuffer(payload) ? payload.length : NaN));
    // a stream of no known length (none here but the live events, which never end) is left as it is
    if (!Number.isFinite(length) || length < AT_LEAST) return payload;
    varyByEncoding(reply);
    const how = encodingFor(req.headers["accept-encoding"]);
    if (!how) return payload;
    // a built file named by its content is kept compressed: read and compressed once
    const lasting = String(reply.getHeader("cache-control") ?? "").includes("immutable") && payload instanceof Readable;
    const key = `${how}\n${req.url.split("?")[0]}\n${length}\n${String(reply.getHeader("last-modified") ?? "")}`;
    let out = lasting ? kept.get(key) : undefined;
    if (out) (payload as Readable).destroy();
    else {
      const bytes = await bytesOf(payload);
      if (!bytes) return payload;
      out = await compress(bytes, how, lasting ? 9 : 4);
      if (lasting) keep(key, out);
    }
    void reply.header("content-encoding", how);
    void reply.header("content-length", out.length);
    return out;
  });
}
