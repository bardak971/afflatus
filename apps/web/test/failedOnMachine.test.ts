import { describe, expect, it } from "vitest";
import type { Download } from "../src/api";
import { failedOnMachine } from "../src/Banners";

/** A machine's failed downloads as one banner: a pod getting its files once gave six red banners over the Queue. */
const dl = (id: string, file: string, over: Partial<Download> = {}): Download =>
  ({ id, file, folder: "loras", title: file, bytes: 0, total: 0, status: "error", error: "The download did not finish", machine: "rp-1", ...over }) as Download;

describe("a machine's failed downloads", () => {
  it("make one banner, named after the machine, listing each file", () => {
    const said = failedOnMachine([dl("a", "swap.safetensors"), dl("b", "vae.safetensors"), dl("c", "other.safetensors", { machine: "rp-2" })], "rp-1", "RTX 4090")!;
    expect(said.banner).toMatchObject({ id: "downloads:rp-1", tone: "bad", title: "2 downloads failed on RTX 4090", href: "/settings?machine=rp-1" });
    expect(said.banner.text).toContain("swap.safetensors, vae.safetensors");
    expect(said.ids).toEqual(["a", "b"]);
  });

  it("say one file by its name, and leave out what was read, what did not fail, and a volume's want of room", () => {
    const said = failedOnMachine([
      dl("a", "swap.safetensors"),
      dl("b", "read.safetensors", { seen: true }),
      dl("c", "coming.safetensors", { status: "downloading", error: undefined }),
      dl("d", "big.safetensors", { error: "its volume is full: 3 GB free, the file is 20 GB" }),
    ], "rp-1", "RTX 4090", "vol-1")!;
    expect(said.banner.title).toBe("Download of swap.safetensors failed on RTX 4090");
    expect(said.ids).toEqual(["a"]);
  });

  it("say a want of room on a machine without a volume, which has no banner of its own", () => {
    const said = failedOnMachine([dl("a", "big.safetensors", { error: "No space left on device (507)" })], "rp-1", "RTX 4090", null)!;
    expect(said.banner.title).toBe("Download of big.safetensors failed on RTX 4090");
    expect(said.ids).toEqual(["a"]);
  });

  it("is nothing when the machine has no failure to say", () => {
    expect(failedOnMachine([dl("a", "swap.safetensors", { seen: true })], "rp-1", "RTX 4090")).toBeNull();
  });
});

describe("the failed downloads of a single-machine setup's ComfyUI", () => {
  const here = (id: string, file: string, over: Partial<Download> = {}) => dl(id, file, { machine: undefined, error: "Could not reach huggingface.co.", ...over });

  it("make one banner too, its shared reason said once, not one sticky banner per file", () => {
    const said = failedOnMachine([here("a", "unet.safetensors"), here("b", "clip.safetensors"), here("c", "vae.safetensors"), dl("d", "other.safetensors")], "", null)!;
    expect(said.banner).toMatchObject({ id: "downloads:", tone: "bad", title: "3 downloads failed", text: "Could not reach huggingface.co: unet.safetensors, clip.safetensors, vae.safetensors", go: "Open the downloads" });
    expect(said.banner.href).toMatch(/find=models\.downloads/);
    expect(said.ids).toEqual(["a", "b", "c"]);
  });

  it("say each file's names first when their reasons differ", () => {
    const said = failedOnMachine([here("a", "unet.safetensors"), here("b", "clip.safetensors", { error: "The disk is full." })], "", null)!;
    expect(said.banner.text).toBe("unet.safetensors, clip.safetensors: Could not reach huggingface.co.");
  });
});
