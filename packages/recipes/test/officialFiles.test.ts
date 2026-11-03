import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isOfficialFile, isOfficialName, officialGet, type PresetFile } from "@afflatus/core";
import { families, familyById } from "../src/index";

const PRESETS = join(__dirname, "..", "..", "..", "presets");
const shipped = readdirSync(PRESETS).filter((n) => n.endsWith(".json")).map((n) => ({ at: n, files: (JSON.parse(readFileSync(join(PRESETS, n), "utf8")) as { files?: PresetFile[] }).files ?? [] }));

/**
 * A family's official file, as the server fetches it whatever the settings (a Download pressed, a pod's fetch) and as the
 * web offers its Download: one test for both, by address and name, whatever the folder it is wanted in.
 */
describe("a family's official file", () => {
  const checkpoint = familyById("ltx")!.slots.find((s) => s.id === "checkpoint")!.get!;

  it("is its address and its name, whatever its folder, sub-folder or case; not another address", () => {
    expect(isOfficialFile(families, { url: checkpoint.url, file: checkpoint.file })).toBe(true);
    expect(isOfficialFile(families, { url: checkpoint.url, file: `LTX/${checkpoint.file.toUpperCase()}` })).toBe(true);
    expect(isOfficialFile(families, { url: `${checkpoint.url}?x`, file: checkpoint.file })).toBe(false);
    expect(isOfficialFile(families, { url: checkpoint.url, file: "other.safetensors" })).toBe(false);
    expect(isOfficialFile(families, { file: checkpoint.file })).toBe(false);
    expect(isOfficialName(families, `sub/${checkpoint.file}`)).toBe(true);
    // ComfyUI on Windows lists a sub-folder with a backslash: the planner sent such a name to a pod, whose fetch refused it
    expect(isOfficialFile(families, { url: checkpoint.url, file: `LTX\\${checkpoint.file}` })).toBe(true);
    expect(isOfficialName(families, `sub\\deeper\\${checkpoint.file}`)).toBe(true);
    expect(isOfficialName(families, "zz-test-nothing.safetensors")).toBe(false);
  });

  it("is so for every shipped preset's file at a family's address: the planner gives it that address, the fetch takes it (LTX 2.3 distilled's, in diffusion_models, was refused)", () => {
    const gets = families.flatMap((f) => f.slots.flatMap((s) => (s.get ? [s.get] : [])));
    const atOfficial = shipped.flatMap((p) => p.files.filter((f) => f.url && gets.some((g) => g.url === f.url)).map((f) => ({ preset: p.at, ...f })));
    expect(atOfficial.length).toBeGreaterThan(0);
    for (const f of atOfficial) expect(isOfficialFile(families, f), `${f.preset}: ${f.folder}/${f.file}`).toBe(true);
    expect(atOfficial).toContainEqual(expect.objectContaining({ preset: "ltx23-distilled.json", folder: "diffusion_models" }));
  });
});

/**
 * A pickle (.pt, .pth, .ckpt, .bin, .pkl) runs code as it loads (Ultralytics takes a .pt with weights_only off): a family's
 * own one is fetched at a commit, never a branch its repository's owner (or a stolen account) can move, and with the bytes
 * it must have, which Afflatus and the node pack check before naming the file (the 2026-11-02 review, M7).
 */
describe("a family's pickle", () => {
  const gets = families.flatMap((f) => f.slots.flatMap((s) => (s.get ? [{ family: f.id, slot: s.id, ...s.get }] : [])));
  const pickles = gets.filter((g) => /\.(pt|pth|ckpt|bin|pkl)$/i.test(g.file));

  it("is fetched at a commit and with its SHA-256", () => {
    expect(pickles.map((g) => g.slot)).toEqual(expect.arrayContaining(["faceDetector", "handDetector", "faceSeg", "faceSam"]));
    for (const g of pickles) {
      expect(g.url, `${g.family} ${g.slot}`).toMatch(/^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//);
      expect(g.sha256, `${g.family} ${g.slot}`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("hands its SHA-256 on with its address", () => {
    const face = pickles.find((g) => g.slot === "faceDetector")!;
    expect(officialGet(families, { url: face.url, file: face.file })?.sha256).toBe(face.sha256);
    expect(officialGet(families, { url: face.url, file: "other.pt" })).toBeUndefined();
    expect(officialGet(families, { file: face.file })).toBeUndefined();
  });
});
