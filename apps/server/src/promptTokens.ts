import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { clipBpe, clipChunks, estimatePieces } from "@afflatus/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isNetworkPath } from "./linked";
import type { Services } from "./services";
import { readSettings } from "./settings";

/**
 * The CLIP token count under an SDXL prompt (core clipTokens.ts). Exact with the BPE merges of ComfyUI's own tokenizer
 * (comfy/sd1_tokenizer/merges.txt, the file its CLIPTextEncode reads), when ComfyUI's folder is on this computer; else a
 * guess from the words, said as one. Nothing leaves the machine.
 */

/** The counter of the merges file read last, by its path: read once (570 kB), not at every count. */
let kept: { path: string; count: Promise<((piece: string) => number) | null> } | null = null;

function counterOf(comfyDir: string): Promise<((piece: string) => number) | null> {
  const base = comfyDir.trim();
  // a ComfyUI on a share is never reached for (see isNetworkPath): its count is a guess
  if (!base || isNetworkPath(base)) return Promise.resolve(null);
  const path = join(base, "comfy", "sd1_tokenizer", "merges.txt");
  if (kept?.path !== path) {
    const count = readFile(path, "utf8").then((text) => clipBpe(text), () => null);
    kept = { path, count };
    // a file not there now may be later (ComfyUI's folder set, an install fixed): asked again at the next count
    void count.then((c) => { if (!c && kept?.path === path) kept = null; });
  }
  return kept.count;
}

export function registerPromptTokens(app: FastifyInstance, s: Services): void {
  /** The tokens of each chunk of 75 a prompt fills, as ComfyUI cuts them; `exact` false when they are a guess. */
  app.post("/api/prompt/tokens", async (req) => {
    const { text } = z.strictObject({ text: z.string().max(20_000) }).parse(req.body);
    const count = await counterOf((await readSettings(s.db)).comfyDir);
    return { chunks: clipChunks(text, count ?? estimatePieces), exact: count !== null };
  });
}
