import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { updateCommands } from "../src/comfyUpdate";
import { writeSettings } from "../src/settings";
import { makeApp, referenceCatalog, type TestApp } from "./helpers";

/**
 * What a ComfyUI says of itself when Afflatus connects (/system_stats): its version and PyTorch, the families that version is
 * too old for, and what to run to update it; and the node pack's row, which restarts ComfyUI through its Manager.
 */
describe("the ComfyUI check", () => {
  let fake: FakeComfy;
  let t: TestApp;
  const folders: string[] = [];
  afterEach(async () => {
    await t?.close();
    await fake?.close();
    for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true });
  });
  const folder = () => {
    const f = mkdtempSync(join(tmpdir(), "afflatus-comfy-"));
    folders.push(f);
    return f;
  };

  it("says an old ComfyUI's version, its PyTorch, the families it is too old for, and the commands for its git checkout", async () => {
    fake = await startFakeComfy({ catalog: referenceCatalog() });
    fake.version = "0.3.10";
    fake.pytorch = "2.4.0+cu121";
    t = await makeApp({ comfyUrl: fake.url });
    const dir = folder();
    mkdirSync(join(dir, ".git"));
    await writeSettings(t.db, { comfyDir: dir });
    const [m] = (await t.app.inject({ method: "GET", url: "/api/machines" })).json() as Array<{ version: string; pytorch: string; tooOld: { needs: string; families: Array<{ id: string }> } | null; update: string | null }>;
    expect(m).toMatchObject({ version: "0.3.10", pytorch: "2.4.0+cu121" });
    expect(m!.tooOld!.families.map((f) => f.id)).toEqual(expect.arrayContaining(["h3", "ltx25"]));
    expect(m!.tooOld!.families.map((f) => f.id)).not.toContain("sdxl");
    expect(m!.update).toContain("git pull");
    expect(m!.update).toContain("pip install -r requirements.txt");
    // the first launch's probe says the same before it is added
    const probe = (await t.app.inject({ method: "POST", url: "/api/setup/probe", payload: { url: fake.url } })).json() as { tooOld: { needs: string } | null; pytorch: string };
    expect(probe).toMatchObject({ pytorch: "2.4.0+cu121", tooOld: { needs: "0.37.0" } });
  });

  it("says nothing more of a ComfyUI that runs every family", async () => {
    fake = await startFakeComfy({ catalog: referenceCatalog() });
    fake.version = "0.42.5";
    fake.pytorch = "2.10.0+cu130";
    t = await makeApp({ comfyUrl: fake.url });
    const [m] = (await t.app.inject({ method: "GET", url: "/api/machines" })).json() as Array<{ tooOld: unknown; update: unknown; pytorch: string }>;
    expect(m).toMatchObject({ tooOld: null, update: null, pytorch: "2.10.0+cu130" });
  });

  it.each([true, false])("offers the restart on the node pack's row only where ComfyUI-Manager can do it (Manager: %s)", async (manager) => {
    fake = await startFakeComfy({ catalog: referenceCatalog(), manager });
    t = await makeApp({ comfyUrl: fake.url });
    const dir = folder();
    mkdirSync(join(dir, "custom_nodes", "afflatus-nodes"), { recursive: true });
    writeFileSync(join(dir, "custom_nodes", "afflatus-nodes", "__init__.py"), "");
    await writeSettings(t.db, { comfyDir: dir });
    const pack = (await t.app.inject({ method: "GET", url: "/api/comfy/node-pack" })).json() as { written: boolean; loaded: boolean; manager: boolean | null };
    expect(pack).toMatchObject({ written: true, loaded: false, manager });
    if (manager) {
      expect((await t.app.inject({ method: "POST", url: "/api/comfy/restart", payload: {} })).statusCode).toBe(200);
      expect(fake.reboots).toBe(1);
    }
  });
});

describe("what to run to update a ComfyUI", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const f of made.splice(0)) rmSync(f, { recursive: true, force: true });
  });
  const root = () => {
    const f = mkdtempSync(join(tmpdir(), "afflatus-update-"));
    made.push(f);
    return f;
  };

  it("runs the portable's update script, a checkout's pull with its own venv's Python, and says nothing for anything else", async () => {
    const portable = root();
    mkdirSync(join(portable, "ComfyUI"));
    mkdirSync(join(portable, "update"));
    writeFileSync(join(portable, "update", "update_comfyui.bat"), "");
    expect(await updateCommands(join(portable, "ComfyUI"), true)).toBe(`"${join(portable, "update", "update_comfyui.bat")}"`);

    const checkout = root();
    mkdirSync(join(checkout, ".git"));
    mkdirSync(join(checkout, "venv", "Scripts"), { recursive: true });
    writeFileSync(join(checkout, "venv", "Scripts", "python.exe"), "");
    expect(await updateCommands(checkout, true)).toBe(`cd /d "${checkout}"\ngit pull\n"${join(checkout, "venv", "Scripts", "python.exe")}" -m pip install -r requirements.txt`);
    expect(await updateCommands(checkout, false)).toBe(`cd "${checkout}"\ngit pull\npython3 -m pip install -r requirements.txt`);

    expect(await updateCommands(root(), true)).toBeNull();
    expect(await updateCommands("", true)).toBeNull();
  });
});
