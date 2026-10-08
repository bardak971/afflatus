import { afterEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { makeApp, referenceCatalog, type TestApp } from "./helpers";

/** Installing a workflow's missing node packs through ComfyUI-Manager's queue. */
describe("missing node packs", () => {
  let fake: FakeComfy;
  let t: TestApp;
  afterEach(async () => {
    await t?.close();
    await fake?.close();
  });

  const start = async (init: Parameters<typeof startFakeComfy>[0]) => {
    fake = await startFakeComfy({ catalog: referenceCatalog(), ...init });
    t = await makeApp({ comfyUrl: fake.url });
  };

  it("queues one install per pack, from the workflow's word first and Manager's map second, and reads where each stands", async () => {
    await start({
      manager: true,
      mappings: {
        "https://github.com/someone/ComfyUI-Thing": [["Thing", "FaceDetailer"], { title_aux: "Thing" }],
        "comfyui-impact-pack": [["FaceDetailer", "SAMLoader"], { title_aux: "Impact" }],
        "https://gist.githubusercontent.com/x/y/raw/z/nodes.py": [["Lone"], { title_aux: "a gist" }],
      },
      packsFail: ["broken-pack"],
    });
    const res = await t.app.inject({
      method: "POST", url: "/api/workflows/packs",
      payload: { classes: ["FaceDetailer", "SAMLoader", "Thing", "Lone", "Lost", "Broken"], packs: { Broken: "broken-pack", SAMLoader: "comfyui-impact-pack" } },
    });
    expect(res.statusCode).toBe(200);
    const started = res.json() as { jobs: Array<{ pack: string; id: string }>; unknown: string[]; skipped: string[] };
    // the registry id wins over the repository that also offers FaceDetailer; the gist cannot be queued; Lost is nobody's
    expect(started.jobs.map((j) => j.pack).sort()).toEqual(["broken-pack", "comfyui-impact-pack", "https://github.com/someone/ComfyUI-Thing"]);
    expect(started.unknown).toEqual(["Lost"]);
    expect(started.skipped).toEqual(["https://gist.githubusercontent.com/x/y/raw/z/nodes.py"]);
    // what Manager was asked: a registry pack at latest, a repository as nightly
    expect(fake.packs).toEqual(expect.arrayContaining([
      { id: "comfyui-impact-pack", version: "latest", selected_version: "latest", mode: "cache", channel: "default" },
      { id: "someone/ComfyUI-Thing", version: "nightly", selected_version: "nightly", repository: "https://github.com/someone/ComfyUI-Thing", mode: "cache", channel: "default" },
    ]));
    const status = await t.app.inject({ method: "GET", url: `/api/workflows/packs?ids=${started.jobs.map((j) => j.id).join(",")},never-queued` });
    const items = (status.json() as { items: Array<{ id: string; state: string; message?: string }>; installed: number }).items;
    // two of the three installs went through: what a restart would load
    expect(status.json().installed).toBe(2);
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    const of = (pack: string) => by[started.jobs.find((j) => j.pack === pack)!.id]!;
    expect(of("comfyui-impact-pack").state).toBe("done");
    expect(of("https://github.com/someone/ComfyUI-Thing").state).toBe("done");
    expect(of("broken-pack")).toMatchObject({ state: "failed", message: expect.stringContaining("Cannot resolve install target") });
    expect(by["never-queued"]).toMatchObject({ state: "pending" });
  });

  it("takes Manager's word over the workflow's, and never a repository the workflow names", async () => {
    await start({ manager: true, mappings: { "comfyui-impact-pack": [["FaceDetailer"], { title_aux: "Impact" }] } });
    const res = await t.app.inject({
      method: "POST", url: "/api/workflows/packs",
      payload: { classes: ["FaceDetailer", "Odd"], packs: { FaceDetailer: "some-other-pack", Odd: "https://github.com/someone/ComfyUI-Odd" } },
    });
    expect(res.statusCode).toBe(200);
    const started = res.json() as { jobs: Array<{ pack: string }>; unknown: string[] };
    expect(started.jobs.map((j) => j.pack)).toEqual(["comfyui-impact-pack"]);
    expect(started.unknown).toEqual(["Odd"]);
    expect(fake.packs.some((p) => "repository" in p)).toBe(false);
  });

  it("restarts ComfyUI through Manager once the packs are in, and the next read sees the new node types", async () => {
    await start({
      manager: true,
      mappings: { "comfyui-impact-pack": [["PretendDetailer"], { title_aux: "Impact" }] },
      afterReboot: { PretendDetailer: { input: { required: { image: ["IMAGE"] } }, output: ["IMAGE"], output_name: ["IMAGE"], display_name: "PretendDetailer", output_node: false } },
    });
    const graph = { "1": { class_type: "PretendDetailer", inputs: {} }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "x" } } };
    const before = await t.app.inject({ method: "POST", url: "/api/workflows/inspect", payload: { graph } });
    expect(before.json().missingNodes).toEqual(["PretendDetailer"]);
    await t.app.inject({ method: "POST", url: "/api/workflows/packs", payload: { classes: ["PretendDetailer"], packs: {} } });
    const restarted = await t.app.inject({ method: "POST", url: "/api/comfy/restart" });
    expect(restarted.statusCode).toBe(200);
    expect(fake.reboots).toBe(1);
    // what was learned of ComfyUI before is not kept: the node list is read again
    const after = await t.app.inject({ method: "POST", url: "/api/workflows/inspect", payload: { graph } });
    expect(after.json().missingNodes).toEqual([]);
  });

  it("will not restart ComfyUI without Manager", async () => {
    await start({ manager: false });
    const res = await t.app.inject({ method: "POST", url: "/api/comfy/restart" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/by hand/);
    expect(fake.reboots).toBe(0);
  });

  it("says so when ComfyUI has no Manager, and queues nothing for node types nobody knows", async () => {
    await start({ manager: false });
    const res = await t.app.inject({ method: "POST", url: "/api/workflows/packs", payload: { classes: ["FaceDetailer"], packs: { FaceDetailer: "comfyui-impact-pack" } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/no ComfyUI-Manager/);
    const none = await t.app.inject({ method: "POST", url: "/api/workflows/packs", payload: { classes: ["Lost"], packs: {} } });
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ jobs: [], unknown: ["Lost"], skipped: [] });
  });
});
