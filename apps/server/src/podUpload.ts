import { open, stat } from "node:fs/promises";
import type { ComfyClient } from "@afflatus/comfy";

/**
 * A model file sent from this computer to a ComfyUI that cannot fetch it anywhere (a rented pod, for a LoRA of your own):
 * through the node pack's upload (0.14.0, uploads.py), a piece at a time at the byte the upload is at. A piece that does
 * not arrive is sent again from where the pack says it is, so a connection that drops costs one piece, not the file.
 */

/** The first node pack that takes an upload. */
export const PACK_UPLOADS = "0.14.0";
/** How much one piece holds: the pack takes up to 64 MB. */
export const PIECE = 32 * 2 ** 20;

export interface UploadOptions {
  client: Pick<ComfyClient, "raw">;
  /** The file on this computer. */
  path: string;
  /** Where it goes on the pod: ComfyUI's model folder and its name there (with a sub-folder when it has one). */
  folder: string;
  file: string;
  signal: AbortSignal;
  onBytes?: (bytes: number, total: number) => void;
  piece?: number;
  /** Tries in a row that gain nothing before it is given up, and the first wait between them. */
  attempts?: number;
  backoffMs?: number;
}

type State = { state: "uploading" | "done" | "error" | "stopped"; bytes: number; total: number; error?: string | null };

/** Send the file; resolves once the pack has named it. Throws with what went wrong, the pack's upload then removed. */
export async function uploadFile(o: UploadOptions): Promise<void> {
  const total = (await stat(o.path)).size;
  // opened before the pod is asked: a file that cannot be read leaves no upload behind there
  const file = await open(o.path, "r");
  const piece = o.piece ?? PIECE;
  const attempts = o.attempts ?? 5;
  const backoff = o.backoffMs ?? 2000;
  const json = { "Content-Type": "application/json" };
  let id: string;
  try {
    const started = await o.client.raw("/afflatus/upload", { method: "POST", headers: json, body: JSON.stringify({ folder: o.folder, filename: o.file.replace(/\\/g, "/"), total }), signal: AbortSignal.timeout(30_000) });
    if (!started.ok) throw new Error(`The pod's node pack refused the upload (${started.status}: ${(await started.text()).slice(0, 200)})`);
    ({ id } = (await started.json()) as { id: string });
  } catch (err) {
    await file.close();
    throw err;
  }
  const at = `/afflatus/upload/${encodeURIComponent(id)}`;
  // the pack keeps an upload in memory: a ComfyUI restarted under it (its node packs loaded) answers 404 for it from then on,
  // and no try of this one can gain anything. Said so that the file is sent again from the start (podFiles.ts PASSING)
  const forgotten = () => new Error("The pod's node pack no longer knows the upload (its ComfyUI restarted): it is sent again");
  const state = async (): Promise<State | "forgotten" | null> => {
    const res = await o.client.raw(at, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (res?.status === 404) return "forgotten";
    return res?.ok ? ((await res.json().catch(() => null)) as State | null) : null;
  };
  let bytes = 0;
  let fails = 0;
  try {
    while (bytes < total) {
      if (o.signal.aborted) throw new Error("stopped");
      const size = Math.min(piece, total - bytes);
      const buf = Buffer.alloc(size);
      const { bytesRead } = await file.read(buf, 0, size, bytes);
      if (bytesRead !== size) throw new Error("the file changed on this computer while it was sent");
      const before = bytes;
      let why: string;
      let gone = false;
      try {
        const res = await o.client.raw(`${at}?offset=${bytes}`, {
          method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: buf,
          signal: AbortSignal.any([o.signal, AbortSignal.timeout(300_000)]),
        });
        if (res.ok) {
          const s = (await res.json()) as State;
          bytes = s.bytes;
          o.onBytes?.(bytes, total);
          fails = 0;
          continue;
        }
        gone = res.status === 404;
        why = `${res.status}: ${(await res.text()).slice(0, 200)}`;
      } catch (err) {
        if (o.signal.aborted) throw new Error("stopped");
        why = (err as Error).message;
      }
      // the piece did not arrive whole (or did, and its answer was lost): the pack says where the upload is
      const s = gone ? "forgotten" : await state();
      if (s === "forgotten") throw forgotten();
      if (s?.state === "done") {
        o.onBytes?.(total, total);
        return;
      }
      if (s && s.state !== "uploading") throw new Error(`The pod's node pack ended the upload: ${s.error ?? s.state}`);
      if (s) bytes = s.bytes;
      fails = bytes > before ? 0 : fails + 1;
      if (fails >= attempts) throw new Error(`The upload failed ${attempts} times in a row (${why})`);
      await new Promise((r) => setTimeout(r, backoff * 2 ** (fails - 1)));
    }
  } catch (err) {
    void o.client.raw(at, { method: "DELETE", signal: AbortSignal.timeout(10_000) }).catch(() => {});
    throw err;
  } finally {
    await file.close();
  }
}
