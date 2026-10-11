import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { zipOf, crc32 } from "../src/zip";
import { zipNames } from "./zipKit";
import { get, makeApp, referenceCatalog, type TestApp } from "./helpers";

describe("a zip made here", () => {
  it("holds the files it was given, by name, and its checksums are the standard ones", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const zip = zipOf([{ name: "afflatus-nodes/__init__.py", data: new TextEncoder().encode("print(1)\n".repeat(50)) }, { name: "afflatus-nodes/LICENSE", data: new Uint8Array([1, 2, 3]) }]);
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(zipNames(zip)).toEqual(["afflatus-nodes/__init__.py", "afflatus-nodes/LICENSE"]);
  });
});

describe("the node pack handed out", () => {
  let fake: FakeComfy;
  let t: TestApp;
  it("is a zip of the pack's files, and the status says when Afflatus cannot write the pack itself", async () => {
    fake = await startFakeComfy({ catalog: referenceCatalog(), models: {} });
    t = await makeApp({ comfyUrl: fake.url });
    try {
      const res = await get(t.app, "/api/comfy/node-pack.zip");
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/zip");
      const names = zipNames(new Uint8Array(res.rawPayload));
      expect(names).toContain("afflatus-nodes/__init__.py");
      expect(names).toContain("afflatus-nodes/latent_io.py");
      expect(names).toContain("afflatus-nodes/continuation_nodes.py");
      expect(names).toContain("afflatus-nodes/LICENSE");
      expect(names).toContain("afflatus-nodes/LICENSE-continuation");
      // no ComfyUI folder set: it cannot be written from here
      expect((await get(t.app, "/api/comfy/node-pack")).json()).toMatchObject({ written: false, canWrite: false });
    } finally {
      await t.close();
      await fake.close().catch(() => {});
    }
  });

  it("is loaded only when the running ComfyUI says this version of it or a newer one", async () => {
    fake = await startFakeComfy({ catalog: referenceCatalog(), models: {} });
    t = await makeApp({ comfyUrl: fake.url });
    try {
      const toml = await readFile(fileURLToPath(new URL("../../../comfy-nodes/afflatus-nodes/pyproject.toml", import.meta.url)), "utf-8");
      const version = /^version\s*=\s*"([^"]+)"/m.exec(toml)![1]!;
      const status = async () => (await get(t.app, "/api/comfy/node-pack")).json() as { loaded: boolean; version: string; running: string | null };
      // no pack loaded: /afflatus/version is not there
      expect(await status()).toMatchObject({ loaded: false, version, running: null });
      // an older copy still loaded (written since, ComfyUI not restarted): its newest nodes are missing
      fake.packVersion = "0.5.0";
      expect(await status()).toMatchObject({ loaded: false, running: "0.5.0" });
      fake.packVersion = version;
      expect(await status()).toMatchObject({ loaded: true, running: version });
      // a newer one (another Afflatus wrote it) has every node this one needs; parts compare as numbers
      fake.packVersion = version.replace(/^(\d+)\.(\d+)/, (_m, a: string, b: string) => `${a}.${Number(b) + 10}`);
      expect((await status()).loaded).toBe(true);
    } finally {
      await t.close();
      await fake.close().catch(() => {});
    }
  });
});
