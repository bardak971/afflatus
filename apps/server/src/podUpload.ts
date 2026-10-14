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
  const piece = o.piece ?? PIECE;
  const attempts = o.attempts ?? 5;
  const backoff = o.backoffMs ?? 2000;
  const json = { "Content-Type": "application/json" };
  const started = await o.client.raw("/afflatus/upload", { method: "POST", headers: json, body: JSON.stringify({ folder: o.folder, filename: o.file.replace(/\\/g, "/"), total }), signal: AbortSignal.timeout(30_000) });
  if (!started.ok) throw new Error(`The pod's node pack refused the upload (${started.status}: ${(await started.text()).slice(0, 200)})`);
  const { id } = (await started.json()) as { id: string };
  const at = `/afflatus/upload/${encodeURIComponent(id)}`;
  const state = async (): Promise<State | null> => {
    const res = await o.client.raw(at, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    return res?.ok ? ((await res.json().catch(() => null)) as State | null) : null;
  };
  const file = await open(o.path, "r");
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
        why = `${res.status}: ${(await res.text()).slice(0, 200)}`;
      } catch (err) {
        if (o.signal.aborted) throw new Error("stopped");
        why = (err as Error).message;
      }
      // the piece did not arrive whole (or did, and its answer was lost): the pack says where the upload is
      const s = await state();
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
