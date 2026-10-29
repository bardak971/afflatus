import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASIDE_DIR, asideRoot, binEntry, binHolds, erase, moveBack, moveOut, type BinFinder } from "../src/modelBin";

/**
 * Where Delete puts a model file (modelBin.ts): moved, never erased. A stand-in bin folder here: no test writes into a real
 * Recycle Bin, nor touches a file outside its own temporary folder.
 */

let home: string;
let bin: string;
let file: string;
const roomy: BinFinder = async () => ({ dir: bin, room: 10_000 });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "afflatus-bin-"));
  bin = join(home, "$Recycle.Bin", "S-1-5-21-0");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, "models", "loras", "style"), { recursive: true });
  file = join(home, "models", "loras", "style", "zz-test lora.safetensors");
  writeFileSync(file, Buffer.alloc(1000, 7));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const aside = () => asideRoot(join(home, "models", "loras"), [join(home, "models", "loras"), join(home, "models", "vae")]);
const out = (want: "bin" | "aside", finder: BinFinder = roomy) => moveOut(file, { want, size: 1000, folder: "loras", file: "style/zz-test lora.safetensors", aside: aside(), bin: finder, at: Date.UTC(2026, 9, 29, 12) });

describe("a model file deleted", () => {
  it("goes to the bin as Windows keeps it: its $R file and its $I entry (version 2: size, time, the path it had)", async () => {
    const m = await out("bin");
    expect(m).toMatchObject({ place: "bin", why: null });
    expect(existsSync(file)).toBe(false);
    const names = readdirSync(bin).sort();
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^\$I[A-Z0-9]{6}\.safetensors$/);
    expect(names[1]).toBe(names[0]!.replace("$I", "$R"));
    expect(readFileSync(m.stored)).toEqual(Buffer.alloc(1000, 7));
    const entry = readFileSync(m.info!);
    expect(entry.readBigInt64LE(0)).toBe(2n);
    expect(entry.readBigInt64LE(8)).toBe(1000n);
    // 29 Oct 2026 12:00 UTC as a FILETIME
    expect(entry.readBigInt64LE(16)).toBe((BigInt(Date.UTC(2026, 9, 29, 12)) + 11_644_473_600_000n) * 10_000n);
    const chars = entry.readUInt32LE(24);
    expect(entry.subarray(28).toString("utf16le")).toBe(`${file}\0`);
    expect(chars).toBe(file.length + 1);
    expect(await binHolds(bin)).toBe(1000);
    // restored by Explorer: its $R gone, its $I left behind, which holds nothing
    rmSync(m.stored);
    expect(await binHolds(bin)).toBe(0);
  });

  it("goes to the set-aside folder, never erased, when the bin has no room, has none, or is set to erase at once", async () => {
    const full = await out("bin", async () => ({ dir: bin, room: 999 }));
    expect(full).toMatchObject({ place: "aside", why: expect.stringContaining("no room") });
    expect(full.stored).toBe(join(home, "models", ASIDE_DIR, "loras", "style", "zz-test lora.safetensors"));
    expect(readFileSync(full.stored)).toEqual(Buffer.alloc(1000, 7));
    await moveBack({ stored: full.stored, info: full.info, was: file });
    const nuke = await out("bin", async () => ({ none: "C:\\'s Recycle Bin is set to erase files at once" }));
    expect(nuke).toMatchObject({ place: "aside", why: "C:\\'s Recycle Bin is set to erase files at once" });
    expect(existsSync(nuke.stored)).toBe(true);
    expect(readdirSync(bin)).toEqual([]);
  });

  it("is put back where it was, its bin entry gone; never over a file there again", async () => {
    const m = await out("bin");
    await moveBack({ stored: m.stored, info: m.info, was: file });
    expect(readFileSync(file)).toEqual(Buffer.alloc(1000, 7));
    expect(readdirSync(bin)).toEqual([]);
    const again = await out("aside");
    writeFileSync(file, "another");
    await expect(moveBack({ stored: again.stored, info: null, was: file })).rejects.toThrow(/again/);
    expect(existsSync(again.stored)).toBe(true);
  });

  it("is erased by Empty only, the set-aside folder removed once empty", async () => {
    const m = await out("aside");
    await erase({ stored: m.stored, info: null });
    expect(existsSync(m.stored)).toBe(false);
    expect(existsSync(join(home, "models", ASIDE_DIR))).toBe(false);
    // a file gone already counts as erased
    await expect(erase({ stored: m.stored, info: null })).resolves.toBeUndefined();
  });

  it("is set aside out of every model folder: above one that holds another's", () => {
    expect(asideRoot(join(home, "models", "loras"), [join(home, "models", "loras")])).toBe(join(home, "models", ASIDE_DIR));
    // an A1111 layout giving a folder the models directory itself: one level up
    expect(asideRoot(join(home, "models", "loras"), [join(home, "models", "loras"), join(home, "models")])).toBe(join(home, ASIDE_DIR));
  });

  it("writes an entry Explorer reads: the path in UTF-16, its length with the ending zero", () => {
    const e = binEntry("C:\\é\\x.safetensors", 5);
    expect(e.length).toBe(28 + 2 * "C:\\é\\x.safetensors\0".length);
  });
});
