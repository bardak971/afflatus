import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetHuggingFace } from "../src/huggingface";
import { podSource } from "../src/podSources";
import { writeSettings } from "../src/settings";
import { get, makeApp, post, until, type TestApp } from "./helpers";

/**
 * Every model file of this computer hashed once (modelHashes.ts), and what the sites say of each: Civitai by the hash
 * itself, Hugging Face by the file's name and then its own hash of the file. A pod then fetches the file from that site.
 */

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex").toUpperCase();
const LORA = Buffer.alloc(3000, 1);
const VAE = Buffer.alloc(2000, 2);
const MINE = Buffer.alloc(1000, 3);

let t: TestApp;
let home: string;
let site: Server;
let asked: string[][];

beforeEach(async () => {
  asked = [];
  home = mkdtempSync(join(tmpdir(), "afflatus-hashes-"));
  for (const f of ["loras/style", "vae"]) mkdirSync(join(home, "models", f), { recursive: true });
  writeFileSync(join(home, "models", "loras", "style", "renamed_by_me.safetensors"), LORA);
  writeFileSync(join(home, "models", "vae", "the_vae.safetensors"), VAE);
  writeFileSync(join(home, "models", "loras", "my_face.safetensors"), MINE);
  // a pretend Civitai that knows the LoRA by its hash, and a pretend Hugging Face that has the VAE under its name
  site = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/v1/model-versions/by-hash/ids") {
      asked.push(body as string[]);
      return res.end(JSON.stringify((body as string[]).filter((h) => h === sha(LORA)).map((hash) => ({ modelVersionId: 4242, hash }))));
    }
    if (req.url?.startsWith("/api/models?")) return res.end(JSON.stringify([{ id: "someone/vaes", downloads: 10, siblings: [{ rfilename: "split/the_vae.safetensors" }] }]));
    if (req.url === "/api/models/someone/vaes/paths-info/main") return res.end(JSON.stringify([{ path: "split/the_vae.safetensors", lfs: { oid: sha(VAE).toLowerCase() } }]));
    res.end("[]");
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const at = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  vi.stubEnv("CIVITAI_URL", at);
  vi.stubEnv("HUGGINGFACE_URL", at);
  forgetHuggingFace();
  t = await makeApp();
  await writeSettings(t.db, { comfyDir: home, civitaiLookups: true });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
  await new Promise((r) => site.close(r));
});

const lookup = () => ({ db: t.db, presets: async () => [], families: () => [], comfyDir: async () => home });

describe("every model file hashed once", () => {
  it("is matched to the site that has it: Civitai by its hash, Hugging Face by its name and the same hash; else this PC", async () => {
    const before = (await get(t.app, "/api/models/hashes")).json();
    expect(before).toMatchObject({ hashed: 0, noFolder: false });
    // Hash now answers at once; the pass it started is the one run() hands back while it goes
    await post(t.app, "/api/models/hashes/run", {});
    await t.services.hashes.run();
    expect((await get(t.app, "/api/models/hashes")).json()).toMatchObject({ files: 3, hashed: 3, civitai: 1, huggingFace: 1, nowhere: 1 });
    // all the hashes in one request
    expect(asked).toHaveLength(1);
    expect(asked[0]!.sort()).toEqual([sha(LORA), sha(VAE), sha(MINE)].sort());
    // a pod gets each from where it is, whatever it is called here
    expect(await podSource(lookup(), { file: "style/renamed_by_me.safetensors", folder: "loras" })).toEqual({ kind: "civitai", version: 4242, pick: "renamed_by_me.safetensors" });
    expect(await podSource(lookup(), { file: "the_vae.safetensors", folder: "vae" })).toMatchObject({ kind: "url", url: expect.stringMatching(/someone\/vaes\/resolve\/main\/split\/the_vae\.safetensors$/) });
    expect(await podSource(lookup(), { file: "my_face.safetensors", folder: "loras" })).toMatchObject({ kind: "upload" });
    // a second pass reads nothing again and asks nothing again
    await t.services.hashes.run();
    expect(asked).toHaveLength(1);
  });

  it("hashes a file again when it changed, and forgets one gone from the disk", async () => {
    await t.services.hashes.run();
    writeFileSync(join(home, "models", "loras", "my_face.safetensors"), Buffer.alloc(1500, 4));
    const { unlinkSync } = await import("node:fs");
    unlinkSync(join(home, "models", "vae", "the_vae.safetensors"));
    await t.services.hashes.run();
    const rows = await t.db.selectFrom("model_hashes").select(["folder", "file", "sha256"]).orderBy("file").execute();
    expect(rows).toEqual([
      { folder: "loras", file: "my_face.safetensors", sha256: sha(Buffer.alloc(1500, 4)) },
      { folder: "loras", file: "style/renamed_by_me.safetensors", sha256: sha(LORA) },
    ]);
  });

  it("waits while this computer renders, and goes on after", async () => {
    let rendering = true;
    t.services.hashes.runningOn = () => rendering;
    const run = t.services.hashes.run();
    await until(async () => (await t.services.hashes.status()).paused);
    expect((await t.services.hashes.status()).hashed).toBe(0);
    rendering = false;
    await run;
    expect((await t.services.hashes.status()).hashed).toBe(3);
  });

  it("asks no site with lookups off, and says when there is no ComfyUI folder here", async () => {
    await writeSettings(t.db, { civitaiLookups: false });
    await t.services.hashes.run();
    expect(asked).toEqual([]);
    expect((await t.services.hashes.status()).hashed).toBe(3);
    await writeSettings(t.db, { comfyDir: "" });
    await t.services.hashes.run();
    expect((await t.services.hashes.status()).noFolder).toBe(true);
  });
});
