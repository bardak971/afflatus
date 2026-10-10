import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/** Every path the model files' reader asks the disk about. */
const asked = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return { ...real, stat: (p: string, ...rest: []) => (asked.push(String(p)), real.stat(p, ...rest)) };
});
const { modelDirs } = await import("../src/modelFiles");

describe("ComfyUI's model folders on a network share", () => {
  it("are never looked at: a stat of one reaches for the share (Windows sends the account's credentials there)", async () => {
    asked.length = 0;
    expect(await modelDirs("\\\\nas\\comfy", "loras")).toEqual([]);
    expect(await modelDirs("//nas/comfy", "loras")).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("nor is one that extra_model_paths.yaml names, while the folders on this computer still are", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afflatus-comfy-"));
    try {
      mkdirSync(join(dir, "models", "loras"), { recursive: true });
      writeFileSync(join(dir, "extra_model_paths.yaml"), "nas:\n  base_path: //nas/models\n  loras: loras\n");
      asked.length = 0;
      expect(await modelDirs(dir, "loras")).toEqual([join(dir, "models", "loras")]);
      expect(asked.some((p) => /^[\\/]{2}nas/.test(p))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
