import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chooseRoute, MANAGER_BIG, MANAGER_HF } from "../src/downloads";
import { DOWNLOADS_DISABLED, fetchToFile, folderPlaces, modelRoot, onThisMachine, placeIn, placesOf, Refused, sizeText, type FetchTo } from "../src/modelDownload";
import { until } from "./helpers";

/** A file of 3 MB whose every byte depends on where it is: a piece out of place shows. It starts as a safetensors file does. */
const SIZE = 3 * 2 ** 20;
const FILE = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) FILE[i] = (i * 31 + (i >> 12)) & 255;
FILE.writeBigUInt64LE(2n, 0);
FILE.write("{}", 8);
const SHA = createHash("sha256").update(FILE).digest("hex");

/** What each request asked: its path, its Range, and the key it carried. */
let asked: Array<{ host: string; url: string; range?: string; auth?: string }>;
let cuts: number;
let site: Server;
let other: Server;
let siteUrl: string;
let otherUrl: string;
let dir: string;

/** Sends the file from `from`, and cuts the connection after `cutAfter` bytes of it when that is set. */
function send(res: import("node:http").ServerResponse, from: number, partial: boolean, cutAfter?: number) {
  const body = FILE.subarray(from);
  res.writeHead(partial ? 206 : 200, { "content-type": "application/octet-stream", "content-length": body.length, ...(partial ? { "content-range": `bytes ${from}-${SIZE - 1}/${SIZE}` } : {}) });
  if (cutAfter === undefined) return res.end(body);
  // closed the polite way: every byte written reaches the other end before the connection ends
  res.write(body.subarray(0, cutAfter), () => res.socket?.end());
}

const from = (range?: string) => Number(/^bytes=(\d+)-$/.exec(range ?? "")?.[1] ?? 0);

beforeEach(async () => {
  asked = [];
  cuts = 0;
  dir = mkdtempSync(join(tmpdir(), "afflatus-fetch-"));
  const handler = (host: string) => (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const range = req.headers.range;
    asked.push({ host, url: req.url ?? "", range, auth: req.headers.authorization });
    const at = from(range);
    // resumes, but cuts the connection twice, a third of the way and two thirds of the way
    if (req.url === "/cut-twice") return cuts < 2 ? (cuts++, send(res, at, at > 0, Math.floor(SIZE / 3))) : send(res, at, at > 0);
    // never resumes: each answer is the whole file, the first one cut half way
    if (req.url === "/no-range") return cuts < 1 ? (cuts++, send(res, 0, false, SIZE / 2)) : send(res, 0, false);
    if (req.url === "/fails") {
      res.writeHead(503);
      return res.end();
    }
    // a first part, then nothing more for a long while: a download to stop
    if (req.url === "/slow") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": SIZE });
      return res.write(FILE.subarray(0, 100_000));
    }
    // as Hugging Face: the size and SHA-256 on the first answer, which sends on to where the bytes are
    if (req.url === "/hf" || req.url === "/hf-wrong") {
      res.writeHead(302, { location: `${otherUrl}/bytes`, "x-linked-size": String(SIZE), "x-linked-etag": `"${req.url === "/hf" ? SHA : "0".repeat(64)}"` });
      return res.end();
    }
    if (req.url === "/bytes" || req.url === "/plain") return send(res, at, at > 0);
    // another service's answer, a zip, under a model's name
    if (req.url === "/zip") {
      const zip = Buffer.from("PK\x03\x04 not a model at all");
      res.writeHead(200, { "content-type": "application/zip", "content-length": zip.length });
      return res.end(zip);
    }
    // Civitai's refusals, as it says them (card #163): a paid version, a key it does not take
    const json = (status: number, body: object) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(body));
    };
    if (req.url?.startsWith("/api/download/models/88") || req.url?.startsWith("/api/download/models/90")) return json(403, { error: "Early Access", message: "This asset is in Early Access. You can use Buzz access it now!" });
    if (req.url === "/api/v1/model-versions/88") return json(200, { id: 88, paidAccess: { permanent: false, endsAt: "2026-11-05T09:00:00.000Z" } });
    if (req.url?.startsWith("/api/download/models/89")) return json(401, { error: "Unauthorized", message: "The creator of this asset requires you to be logged in to download it" });
    // a file its creator closed (card #206): a 401 too, key or none
    if (req.url?.startsWith("/api/download/models/91")) return json(401, { error: "Unauthorized", message: "The creator of this asset has disabled downloads on this file" });
    if (req.url?.startsWith("/api/download/models/92")) return json(401, { error: "Unauthorized", message: "This file is under review" });
    if (req.url === "/login") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<html>sign in</html>");
    }
    res.writeHead(404);
    res.end();
  };
  site = createServer(handler("site"));
  other = createServer(handler("other"));
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
});
afterEach(async () => {
  site.closeAllConnections();
  other.closeAllConnections();
  await new Promise((r) => site.close(r));
  await new Promise((r) => other.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const fetchTo = (path: string, over: Partial<FetchTo> = {}) => {
  const notes: string[] = [];
  const dest = join(dir, "model.safetensors");
  const done = fetchToFile({
    source: `${siteUrl}${path}`, headers: {}, allow: [siteUrl, otherUrl], dest, signal: new AbortController().signal,
    onBytes: () => {}, onRetry: (n) => notes.push(n), backoffMs: 5, free: async () => 100 * 2 ** 30, ...over,
  });
  return { done, notes, dest };
};

describe("Afflatus downloading a model file itself", () => {
  it("picks up from the byte it had after each cut, and the file is the same, byte for byte", async () => {
    const { done, notes, dest } = fetchTo("/cut-twice");
    await expect(done).resolves.toMatchObject({ bytes: SIZE, sha256: SHA });
    expect(readFileSync(dest).equals(FILE)).toBe(true);
    // asked again from the byte it had on disk after each cut (a little before where the site cut: fetch lets the last
    // piece it held go when the connection ends early); a wrong place would have spoiled the file above
    const starts = asked.map((a) => from(a.range));
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBeGreaterThan(0);
    expect(starts[1]).toBeLessThanOrEqual(Math.floor(SIZE / 3));
    expect(starts[2]).toBeGreaterThan(starts[1]!);
    expect(starts).toHaveLength(3);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/cut at .*trying again from \d+ MB \(2 of 5\)/);
    expect(readdirSync(dir)).toEqual(["model.safetensors"]);
  });

  it("starts over when the site ignores Range", async () => {
    const { done, notes, dest } = fetchTo("/no-range");
    await expect(done).resolves.toMatchObject({ bytes: SIZE, sha256: SHA });
    expect(asked).toHaveLength(2);
    expect(from(asked[1]!.range)).toBeGreaterThan(0);
    expect(notes.at(-1)).toMatch(/does not resume downloads: starting over/);
    expect(readFileSync(dest).equals(FILE)).toBe(true);
  });

  it("gives up after so many tries in a row that gain nothing, with why, and leaves nothing", async () => {
    const { done } = fetchTo("/fails", { attempts: 3 });
    await expect(done).rejects.toThrow(/failed 3 times in a row \(the site answered 503\)/);
    await expect(done).rejects.toBeInstanceOf(Refused);
    expect(asked).toHaveLength(3);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("writes to a .part, never to the file's name, until all of it is there; a stop removes the .part", async () => {
    const stop = new AbortController();
    const { done, dest } = fetchTo("/slow", { signal: stop.signal });
    await until(() => existsSync(`${dest}.part`) && readFileSync(`${dest}.part`).length === 100_000);
    // what ComfyUI would list: nothing of a model's name while it comes
    expect(readdirSync(dir)).toEqual(["model.safetensors.part"]);
    stop.abort();
    await expect(done).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a file the disk has no room for, before writing a byte of it", async () => {
    const { done } = fetchTo("/plain", { free: async () => 10 * 2 ** 20 });
    await expect(done).rejects.toThrow(/Not enough free space for it: the file is 3 MB, and the disk of .* has 10 MB free/);
    expect(asked).toHaveLength(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("sends a key to the host first asked only, never on to where it sends", async () => {
    const { done } = fetchTo("/hf", { headers: { Authorization: "Bearer k-123" } });
    await done;
    expect(asked.map((a) => [a.host, a.url, a.auth])).toEqual([["site", "/hf", "Bearer k-123"], ["other", "/bytes", undefined]]);
  });

  it("checks the SHA-256 Hugging Face gives, and keeps nothing of a file that does not match it", async () => {
    await expect(fetchTo("/hf").done).resolves.toMatchObject({ sha256: SHA });
    rmSync(join(dir, "model.safetensors"));
    await expect(fetchTo("/hf-wrong").done).rejects.toThrow(/came damaged: its SHA-256/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a .safetensors that is not one, before naming it", async () => {
    await expect(fetchTo("/zip").done).rejects.toThrow(/not a safetensors file/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("says a host it cannot reach at once, by name and reason, instead of trying five times and calling it a cut", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const at = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise((r) => closed.close(r));
    const { done, notes } = fetchTo("", { source: `${at}/x.safetensors`, allow: [at] });
    await expect(done).rejects.toThrow(`Could not reach ${at.slice(7)} (ECONNREFUSED)`);
    await expect(done).rejects.toBeInstanceOf(Refused);
    expect(notes).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    // nothing came is said as nothing, never as "1 MB"
    expect(sizeText(0)).toBe("0 MB");
    expect(sizeText(1)).toBe("1 MB");
  });

  describe("Civitai's own reason for a refusal (card #163)", () => {
    beforeEach(() => void (process.env.CIVITAI_URL = siteUrl));
    afterEach(() => void delete process.env.CIVITAI_URL);

    it("says a paid version (Early Access) as paid, with its page and when it ends, not as a missing key", async () => {
      const key = { Authorization: "Bearer k-123456789" };
      const until = fetchTo("/api/download/models/88?fileId=1", { headers: key }).done;
      await expect(until).rejects.toThrow(`This version is paid on Civitai (Early Access until 2026-11-05): unlock it with Buzz on its page (${siteUrl}/model-versions/88), or pick another version.`);
      await expect(until).rejects.toBeInstanceOf(Refused);
      // paid for good: Civitai's version says no end (here, it does not answer at all)
      await expect(fetchTo("/api/download/models/90", { headers: key }).done).rejects.toThrow(/^This version is paid on Civitai \(Early Access\): unlock it with Buzz/);
      // never tried again: Buzz is not waited for
      expect(asked.filter((a) => a.url.startsWith("/api/download/models/88"))).toHaveLength(1);
    });

    it("says a 401 without a key as before, and with one as the key refused", async () => {
      await expect(fetchTo("/api/download/models/89").done).rejects.toThrow("The site refused the download. For Civitai, save a key in Settings › Models › Civitai API key: some files need an account.");
      await expect(fetchTo("/api/download/models/89", { headers: { Authorization: "Bearer k-123456789" } }).done).rejects.toThrow(/^Civitai refused the API key \(expired, revoked or mistyped\)/);
    });

    it("says a file whose creator disabled downloads as such, key or none, never as the key refused (card #206)", async () => {
      await expect(fetchTo("/api/download/models/91", { headers: { Authorization: "Bearer k-123456789" } }).done).rejects.toThrow(DOWNLOADS_DISABLED);
      await expect(fetchTo("/api/download/models/91").done).rejects.toThrow(DOWNLOADS_DISABLED);
      // a 401 saying another thing than the key or an account: in Civitai's words
      await expect(fetchTo("/api/download/models/92", { headers: { Authorization: "Bearer k-123456789" } }).done).rejects.toThrow("Civitai refused the download (Unauthorized: This file is under review).");
    });
  });

  it("says when the site refuses (a sign-in page), without trying again", async () => {
    await expect(fetchTo("/login").done).rejects.toThrow(/The site refused the download/);
    expect(asked).toHaveLength(1);
  });
});

describe("where Afflatus may write a model", () => {
  it("takes the first path ComfyUI lists for the folder that is there and writable, and only one of those", async () => {
    const loras = join(dir, "loras");
    mkdirSync(loras);
    const listed = { loras: [join(dir, "missing"), loras], unet: [loras] };
    expect(await modelRoot(listed, "loras", "http://127.0.0.1:8188", "")).toBe(await realpath(loras));
    // ComfyUI's older name is read for the newer one
    expect(await modelRoot(listed, "diffusion_models", "http://127.0.0.1:8188", "")).not.toBeNull();
    // a folder ComfyUI does not list is nowhere Afflatus writes
    expect(await modelRoot(listed, "vae", "http://127.0.0.1:8188", "")).toBeNull();
    // a ComfyUI on another machine: its paths are its own disk's, not this one's
    expect(await modelRoot(listed, "loras", "http://192.0.2.10:8188", "")).toBeNull();
    // a path on a network share is never written
    expect(await modelRoot({ loras: ["\\\\nas\\models\\loras"] }, "loras", "http://127.0.0.1:8188", "")).toBeNull();
  });

  it("takes ComfyUI's own models/<folder> first, though ComfyUI lists its older name and another app's folder first (card #59)", async () => {
    // the owner's ComfyUI as it answered on 2026-10-24: unet before diffusion_models, A1111's folders (extra_model_paths.yaml) first
    const comfy = join(dir, "ComfyUI");
    const a1111 = join(dir, "sd.webui", "models");
    for (const d of ["models/unet", "models/diffusion_models", "models/checkpoints", "models/loras", "custom_nodes"]) mkdirSync(join(comfy, d), { recursive: true });
    for (const d of ["Stable-diffusion", "Lora", "LyCORIS"]) mkdirSync(join(a1111, d), { recursive: true });
    const listed = {
      custom_nodes: [join(comfy, "custom_nodes")],
      diffusion_models: [join(comfy, "models", "unet"), join(comfy, "models", "diffusion_models"), join(dir, "Krea2")],
      checkpoints: [join(a1111, "Stable-diffusion"), join(comfy, "models", "checkpoints")],
      loras: [join(a1111, "Lora"), join(a1111, "LyCORIS"), join(comfy, "models", "loras")],
    };
    const local = "http://127.0.0.1:8188";
    expect(await modelRoot(listed, "diffusion_models", local, "")).toBe(await realpath(join(comfy, "models", "diffusion_models")));
    expect(await modelRoot(listed, "checkpoints", local, "")).toBe(await realpath(join(comfy, "models", "checkpoints")));
    expect(await modelRoot(listed, "loras", local, "")).toBe(await realpath(join(comfy, "models", "loras")));
    // the order the menu offers them in, each said short under ComfyUI's folder
    expect(placesOf(listed.loras, "loras", comfy).map((p) => [p.kind, p.shown])).toEqual([["own", join("models", "loras")], ["other", join(a1111, "Lora")], ["other", join(a1111, "LyCORIS")]]);
    expect(placesOf(listed.diffusion_models, "diffusion_models", comfy).map((p) => p.kind)).toEqual(["own", "older", "other"]);
    // its own folder not there: the older name, then the others
    rmSync(join(comfy, "models", "diffusion_models"), { recursive: true });
    expect(await modelRoot(listed, "diffusion_models", local, "")).toBe(await realpath(join(comfy, "models", "unet")));
    // the place chosen, while ComfyUI lists it; never one it does not
    expect(await modelRoot(listed, "loras", local, "", join(a1111, "Lora"))).toBe(await realpath(join(a1111, "Lora")));
    expect(await modelRoot(listed, "loras", local, "", join(dir, "elsewhere"))).toBe(await realpath(join(comfy, "models", "loras")));
    // what the page is told: each place, whether it can be written, the one chosen and where a download goes
    const told = await folderPlaces(listed, local, "", { loras: join(a1111, "Lora") }, "manager");
    expect(told.loras).toMatchObject({ chosen: join(a1111, "Lora"), goes: join(a1111, "Lora") });
    expect(told.diffusion_models!.goes).toBe(join("models", "unet"));
    expect(told.diffusion_models!.places.map((p) => p.ok)).toEqual([false, true, false]);
    expect(told.custom_nodes).toBeUndefined();
  });

  it("reads a pod's Linux paths as Linux paths, and a models/<folder> as ComfyUI's own when its folder is not said", () => {
    const pod = ["/workspace/extra/loras", "/workspace/ComfyUI/models/loras"];
    expect(placesOf(pod, "loras", "/workspace/ComfyUI").map((p) => [p.kind, p.shown])).toEqual([["own", "models/loras"], ["other", "/workspace/extra/loras"]]);
    expect(placesOf(pod, "loras", null).map((p) => p.kind)).toEqual(["own", "other"]);
  });

  it("takes a ComfyUI on another machine's paths only inside the folder set in Settings, and never custom_nodes", async () => {
    const comfy = join(dir, "comfy");
    const inside = join(comfy, "models", "loras");
    const outside = join(dir, "elsewhere");
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside);
    const remote = "http://192.0.2.10:8188";
    expect(await modelRoot({ loras: [outside, inside] }, "loras", remote, comfy)).toBe(await realpath(inside));
    expect(await modelRoot({ loras: [outside] }, "loras", remote, comfy)).toBeNull();
    // the same paths of a ComfyUI on this machine are its own
    expect(await modelRoot({ loras: [outside] }, "loras", "http://127.0.0.1:8188", comfy)).toBe(await realpath(outside));
    expect(await modelRoot({ custom_nodes: [inside] }, "custom_nodes", "http://127.0.0.1:8188", comfy)).toBeNull();
  });

  it("counts as this machine only a loopback or own address, or localhost, never a host name that starts with 127.", () => {
    for (const url of ["http://127.0.0.1:8188", "http://127.1.2.3:8188", "http://127.1:8188", "http://[::1]:8188", "http://localhost:8188"]) {
      expect(onThisMachine(url), url).toBe(true);
    }
    for (const url of ["http://127.example.net:8188", "http://127.0.0.1.nip.io:8188", "http://192.0.2.10:8188", "not a url"]) {
      expect(onThisMachine(url), url).toBe(false);
    }
  });

  it("counts an IPv4 address said the IPv6 way as that address: loopback, this machine's own, or another", () => {
    for (const url of ["http://[::ffff:127.0.0.1]:8188", "http://[::ffff:7f00:1]:8188", "http://[0:0:0:0:0:ffff:7f00:1]:8188"]) {
      expect(onThisMachine(url), url).toBe(true);
    }
    // one of this machine's own IPv4 addresses, mapped (none on a machine with only loopback)
    const own = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal);
    if (own) expect(onThisMachine(`http://[::ffff:${own.address}]:8188`), own.address).toBe(true);
    for (const url of ["http://[::ffff:192.0.2.10]:8188", "http://[::ffff:c000:20a]:8188", "http://[::ffff:1:7f00:1]:8188"]) {
      expect(onThisMachine(url), url).toBe(false);
    }
  });

  it("keeps a sub-folder inside the folder, and refuses one whose link leads out of it", async () => {
    const root = join(dir, "loras");
    mkdirSync(root);
    const real = await realpath(root);
    expect(await placeIn(real, "wan/high", "a.safetensors")).toBe(join(real, "wan", "high", "a.safetensors"));
    await expect(placeIn(real, "../outside", "a.safetensors")).rejects.toThrow(/not a models folder/);
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    // a junction needs no rights on Windows, and is a link anywhere else
    symlinkSync(elsewhere, join(real, "out"), "junction");
    await expect(placeIn(real, "out", "a.safetensors")).rejects.toThrow(/leads out of the models folder/);
  });
});

describe("who downloads a file", () => {
  const base = { headers: {}, total: 0 };
  it("is Afflatus when it can write the folder, then the node pack, then ComfyUI-Manager", () => {
    expect(chooseRoute({ ...base, root: "/m/loras", pack: true, source: "https://civitai.com/api/download/models/1" })).toEqual({ via: "afflatus", root: "/m/loras" });
    expect(chooseRoute({ ...base, root: null, pack: true, source: "https://civitai.com/api/download/models/1" })).toEqual({ via: "pack" });
  });
  it("hands Manager a public Hugging Face address itself, since it streams that one to disk", () => {
    const hf = "https://huggingface.co/Comfy-Org/x/resolve/main/a.safetensors";
    expect(chooseRoute({ ...base, root: null, pack: false, source: hf })).toEqual({ via: "manager", direct: hf, note: MANAGER_HF });
    // with a key, it goes through Afflatus: the key never reaches ComfyUI
    expect(chooseRoute({ ...base, root: null, pack: false, source: hf, headers: { Authorization: "Bearer x" } })).toEqual({ via: "manager", note: undefined });
  });
  it("warns that Manager holds a file over 1 GB in memory, otherwise", () => {
    expect(chooseRoute({ ...base, root: null, pack: false, source: "https://civitai.com/x", total: 7 * 2 ** 30 })).toEqual({ via: "manager", note: MANAGER_BIG });
    expect(chooseRoute({ ...base, root: null, pack: false, source: "https://civitai.com/x", total: 200 * 2 ** 20 })).toEqual({ via: "manager", note: undefined });
  });
});
