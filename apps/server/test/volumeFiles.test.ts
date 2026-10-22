import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeComfy, startFakeRunpod, startFakeS3, type FakeComfy, type FakeRunpod, type FakeS3 } from "@afflatus/comfy/testing";
import { get, makeApp, makeFake, post, referenceCatalog, type TestApp } from "./helpers";

/**
 * The volume viewer (volumeFiles.ts) against a pretend RunPod and a pretend S3: a volume's models folder listed through the
 * pod on it, or with no pod through S3 (the S3 key's access key being the account's id, which RunPod tells), or as last
 * listed; what each file is (its sets, its last render, whether this PC has it); and files deleted, never one a render needs now.
 */

const KEY = "rpa_test_key_0123456789";
const USER = "user_2abcTEST";
const GB = 1_000_000_000;
let home: FakeComfy;
let runpod: FakeRunpod;
let s3: FakeS3;
let t: TestApp;

beforeEach(async () => {
  home = await makeFake();
  runpod = await startFakeRunpod({ key: KEY, pods: [], volumes: [{ id: "vol-ro", name: "afflatus-models", size: 100, dataCenter: "EU-RO-1" }, { id: "vol-tx", name: "far", size: 50, dataCenter: "US-TX-3" }] });
  s3 = await startFakeS3({
    user: USER,
    volumes: {
      "vol-ro": {
        "comfyui/models/checkpoints/illustrious.safetensors": { size: 6.9 * GB, modified: "2026-10-10T08:00:00.000Z" },
        "comfyui/models/loras/zz-test style.safetensors": { size: 0.22 * GB },
        "comfyui/models/upscale_models/sub/4x.pth": { size: 0.07 * GB },
        "comfyui/models/loras/": { size: 0 },
        "comfyui/models/.s3compat_uploads/part1": { size: 5 },
        "comfyui/custom_nodes/afflatus-nodes/__init__.py": { size: 100 },
      },
    },
  });
  vi.stubEnv("RUNPOD_API_URL", runpod.url);
  vi.stubEnv("RUNPOD_S3_URL", s3.url);
  vi.stubEnv("RUNPOD_PROXY", "http://127.0.0.1:{id}");
  runpod.userId = USER;
  t = await makeApp({ comfyUrl: home.url });
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY } });
});
afterEach(async () => {
  await t.close();
  // the envs unstubbed last: a RunPod call still under way until the close (a hunt's round, a poll) read them
  // again and, without them, went to RunPod itself
  vi.unstubAllEnvs();
  await Promise.all([home, runpod, s3].map((x) => x.close().catch(() => {})));
});

// the secret alone: the access key is the account's user id, which RunPod tells with the API key
const withKey = () => t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodS3Secret: "rps_secret_0123456789" } });
type View = { source: string; why: string | null; canDelete: boolean; readBy: string | null; files: Array<{ key: string; folder: string; name: string; bytes: number | null; usedAt: string | null; here: boolean; inUse: boolean; sets: unknown[]; comfy: string | null }> };
const files = async () => (await get(t.app, "/api/runpod/volumes/vol-ro/files")).json() as View;

describe("reading a volume", () => {
  it("says what is missing without an S3 key, and nothing is asked of S3", async () => {
    const view = await files();
    expect(view).toMatchObject({ source: "none", files: [] });
    expect(view.why).toMatch(/No S3 API key/);
    expect(s3.calls).toEqual([]);
  });

  it("says why under pretend sites with no pretend S3, rather than failing or asking RunPod's own", async () => {
    await withKey();
    vi.stubEnv("RUNPOD_S3_URL", "");
    const res = await get(t.app, "/api/runpod/volumes/vol-ro/files");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: "none", files: [] });
    expect(res.json().why).toMatch(/S3 API is not asked here/);
    expect(s3.calls).toEqual([]);
  });

  it("lists the models folder only: each file's folder, name and bytes; ComfyUI itself and RunPod's upload parts left out", async () => {
    await withKey();
    const view = await files();
    expect(view.source).toBe("s3");
    expect(view.files.map((f) => [f.folder, f.name, f.bytes])).toEqual([
      ["checkpoints", "illustrious.safetensors", 6.9 * GB],
      ["loras", "zz-test style.safetensors", 0.22 * GB],
      ["upscale_models", "sub/4x.pth", 0.07 * GB],
    ]);
    expect(s3.calls.every((c) => c.startsWith("GET /vol-ro?") && c.includes("prefix=comfyui%2Fmodels%2F"))).toBe(true);
    // the tile then says the models' bytes, and the count of files as the volume's holdings
    const tile = (await get(t.app, "/api/runpod/volumes")).json().volumes[0];
    expect(tile.listed.bytes).toBe(6.9 * GB + 0.22 * GB + 0.07 * GB);
    expect(tile.holds).toMatchObject({ count: 3, seenBy: "S3" });
  });

  it("shows what the last pod listed where RunPod's S3 API is not (as RunPod says it), names only, and deletes nothing there", async () => {
    await withKey();
    await t.db.insertInto("volume_files").values({ volume_id: "vol-tx", files: JSON.stringify(["loras|style.safetensors"]), seen_at: "2026-10-14T10:00:00.000Z", seen_by: "A40", used_at: null, noticed_at: "2026-10-01T00:00:00.000Z", fill_note: null }).execute();
    const view = (await get(t.app, "/api/runpod/volumes/vol-tx/files")).json() as View;
    expect(view).toMatchObject({ source: "kept", canDelete: false, files: [{ folder: "loras", name: "style.safetensors", bytes: null }] });
    expect(view.why).toMatch(/does not serve US-TX-3.*deploy a pod on it/);
    expect((await post(t.app, "/api/runpod/volumes/vol-tx/files/delete", { keys: ["comfyui/models/loras/style.safetensors"] })).statusCode).toBe(409);
    expect(s3.calls).toEqual([]);
  });

  it("reads every page of a long listing", async () => {
    await withKey();
    s3.pageSize = 1;
    expect((await files()).files).toHaveLength(3);
    expect(s3.calls.filter((c) => c.includes("continuation-token")).length).toBeGreaterThanOrEqual(3);
  });

  it("says a refused key as such", async () => {
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodS3User: "user_someoneelse", runpodS3Secret: "rps_secret_0123456789" } });
    const res = await get(t.app, "/api/runpod/volumes/vol-ro/files");
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/refused the S3 key/);
  });

  it("says when a render on one of the volume's pods last used a file, and which file one running now needs", async () => {
    await withKey();
    const now = new Date().toISOString();
    await t.db.insertInto("rent_sessions").values({ id: "s1", machine_id: "rp-gone", pod: "gone", rate: 0.4, started_at: now, ended_at: now, seen_at: now, gpu: null, up_at: null, idle_minutes: 10, busy_at: null, pulled_at: null, packs_from: null, packs_to: null, boot_packs: null, start_failed: null, volume: "vol-ro" }).execute();
    const row = (id: string, status: string, finished: string | null) => ({ id, owner_id: "local", recipe_id: "sdxl.text-to-picture", label: "x", inputs: JSON.stringify({ prompt: "a cat", checkpoint: "illustrious.safetensors" }), status, priority: 0, created_at: now, updated_at: now, finished_at: finished, machine_id: "rp-gone" });
    await t.db.insertInto("jobs").values([row("j1", "done", "2026-10-12T10:00:00.000Z"), row("j2", "done", "2026-10-14T10:00:00.000Z")] as never).execute();
    let view = await files();
    expect(view.files.find((f) => f.folder === "checkpoints")).toMatchObject({ usedAt: "2026-10-14T10:00:00.000Z", inUse: false });
    expect(view.files.find((f) => f.folder === "loras")?.usedAt).toBeNull();
    await t.db.insertInto("jobs").values(row("j3", "running", null) as never).execute();
    view = await files();
    expect(view.files.find((f) => f.folder === "checkpoints")?.inUse).toBe(true);
  });

  it("knows a file this PC has by its name and size", async () => {
    await withKey();
    await t.db.insertInto("model_hashes").values({ folder: "loras", file: "styles/zz-test style.safetensors", size: 0.22 * GB, mtime: 1, sha256: "a".repeat(64), hashed_at: "2026-10-01", civitai_version: null, hf_url: null, matched_at: null }).execute();
    await t.db.insertInto("model_hashes").values({ folder: "checkpoints", file: "illustrious.safetensors", size: 1, mtime: 1, sha256: "b".repeat(64), hashed_at: "2026-10-01", civitai_version: null, hf_url: null, matched_at: null }).execute();
    const view = await files();
    expect(view.files.find((f) => f.folder === "loras")?.here).toBe(true);
    // the same name with another size is another file
    expect(view.files.find((f) => f.folder === "checkpoints")?.here).toBe(false);
  });
});

describe("deleting", () => {
  const del = (keys: string[]) => post(t.app, "/api/runpod/volumes/vol-ro/files/delete", { keys });

  it("is refused without an S3 key", async () => {
    expect((await del(["comfyui/models/loras/zz-test style.safetensors"])).statusCode).toBe(409);
  });

  it("deletes files of the models folder, keeps the holdings in step, and never touches anything else", async () => {
    await withKey();
    await files();
    const res = await del(["comfyui/models/loras/zz-test style.safetensors", "comfyui/custom_nodes/afflatus-nodes/__init__.py", "comfyui/models/../custom_nodes/x.py", "comfyui/models/loras/"]);
    expect(res.json().deleted).toEqual(["comfyui/models/loras/zz-test style.safetensors"]);
    expect(res.json().kept.map((k: { key: string }) => k.key)).toEqual(["comfyui/custom_nodes/afflatus-nodes/__init__.py", "comfyui/models/../custom_nodes/x.py", "comfyui/models/loras/"]);
    expect(s3.calls.filter((c) => c.startsWith("DELETE"))).toEqual(["DELETE /vol-ro/comfyui/models/loras/zz-test style.safetensors"]);
    expect(s3.volumes.get("vol-ro")!.has("comfyui/custom_nodes/afflatus-nodes/__init__.py")).toBe(true);
    expect((await get(t.app, "/api/runpod/volumes")).json().volumes[0].holds.count).toBe(2);
  });

  it("keeps a file a render running on the volume needs, and says a failed delete", async () => {
    await withKey();
    const now = new Date().toISOString();
    await t.db.insertInto("rent_sessions").values({ id: "s1", machine_id: "rp-a", pod: "a", rate: 0.4, started_at: now, ended_at: null, seen_at: now, gpu: null, up_at: null, idle_minutes: 10, busy_at: null, pulled_at: null, packs_from: null, packs_to: null, boot_packs: null, start_failed: null, volume: "vol-ro" }).execute();
    await t.db.insertInto("jobs").values({ id: "j1", owner_id: "local", recipe_id: "sdxl.text-to-picture", label: "x", inputs: JSON.stringify({ prompt: "a cat", checkpoint: "illustrious.safetensors" }), status: "running", priority: 0, created_at: now, updated_at: now, machine_id: "rp-a" } as never).execute();
    s3.failDelete.add("comfyui/models/upscale_models/sub/4x.pth");
    const res = await del(["comfyui/models/checkpoints/illustrious.safetensors", "comfyui/models/upscale_models/sub/4x.pth"]);
    expect(res.json()).toEqual({ deleted: [], kept: [
      { key: "comfyui/models/checkpoints/illustrious.safetensors", why: "a render running on the volume needs it now" },
      { key: "comfyui/models/upscale_models/sub/4x.pth", why: expect.stringMatching(/internal error/) },
    ] });
  });
});

describe("through the pod running on the volume", () => {
  let disk: string;
  let pod: FakeComfy;
  beforeEach(async () => {
    disk = mkdtempSync(join(tmpdir(), "afflatus-volume-"));
    for (const f of ["loras", "checkpoints"]) mkdirSync(join(disk, f));
    writeFileSync(join(disk, "loras", "zz-test style.safetensors"), Buffer.alloc(2000, 1));
    writeFileSync(join(disk, "checkpoints", "illustrious.safetensors"), Buffer.alloc(5000, 1));
    pod = await startFakeComfy({ catalog: referenceCatalog(), models: { loras: [] }, folderPaths: { loras: [join(disk, "loras")], checkpoints: [join(disk, "checkpoints")] }, hideFolderPaths: true });
    pod.packVersion = "0.21.0";
    const now = new Date().toISOString();
    runpod.pods.push({ pulled: true, id: new URL(pod.url).port, name: "zz-test-pod", status: "RUNNING", rate: 0.44, gpu: "NVIDIA A40", dataCenterId: "EU-RO-1", ports: ["8188/http"], diskGb: 0, env: {}, startedAt: now, upAt: now, comfy: pod, volumeId: "vol-ro" });
    expect((await post(t.app, "/api/runpod/add", { pod: new URL(pod.url).port })).statusCode).toBe(200);
  });
  afterEach(async () => {
    await pod.close();
  });

  it("lists and deletes with no S3 key: the pod's node pack says the files with their sizes, and removes one", async () => {
    const view = await files();
    expect(view).toMatchObject({ source: "pod", canDelete: true, readBy: "zz-test-pod" });
    expect(view.files.map((f) => [f.key, f.comfy, f.bytes]).sort()).toEqual([
      ["comfyui/models/checkpoints/illustrious.safetensors", "checkpoints", 5000],
      ["comfyui/models/loras/zz-test style.safetensors", "loras", 2000],
    ]);
    const res = await post(t.app, "/api/runpod/volumes/vol-ro/files/delete", { keys: ["comfyui/models/loras/zz-test style.safetensors", "comfyui/models/loras/not-there.safetensors"] });
    expect(res.json().deleted).toEqual(["comfyui/models/loras/zz-test style.safetensors"]);
    expect(res.json().kept.map((k: { key: string }) => k.key)).toEqual(["comfyui/models/loras/not-there.safetensors"]);
    expect(existsSync(join(disk, "loras", "zz-test style.safetensors"))).toBe(false);
    expect(s3.calls).toEqual([]);
    // kept with its sizes: the tile says them, and its Files show them once the pod is gone
    const tile = (await get(t.app, "/api/runpod/volumes")).json().volumes[0];
    expect(tile).toMatchObject({ listed: { bytes: 5000 }, holds: { count: 1, seenBy: "zz-test-pod" } });
  });

  it("falls back on S3 when the pod's node pack is too old to list", async () => {
    pod.packVersion = "0.20.0";
    await withKey();
    expect((await files()).source).toBe("s3");
  });
});

describe("the S3 key", () => {
  it("is never given to the page (a backup leaves it out: backup.test.ts)", async () => {
    await withKey();
    const settings = (await get(t.app, "/api/settings")).json();
    expect(settings).toMatchObject({ hasRunpodS3Secret: true });
    expect(JSON.stringify(settings)).not.toContain("rps_secret");
  });
});
