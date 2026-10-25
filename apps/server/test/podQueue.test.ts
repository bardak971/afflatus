import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeComfy, startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { RIFE_GET } from "@afflatus/recipes";
import { newId, now, OWNER } from "../src/db";
import { readSettings, writeSettings } from "../src/settings";
import { CHECKPOINT, complete, get, job, makeApp, makeFake, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * A deployed pod that lacks a job's model file (queue.ts with podFiles.ts): the job may still go there, its file sent
 * first, when that is where it ends soonest; where this computer is sooner it stays home and the file is sent ahead; a
 * file that cannot be had keeps the job off the pod, and never keeps the pod billed.
 */

const KEY = "rpa_test_key_0123456789";
let home: FakeComfy;
let pod: FakeComfy;
let runpod: FakeRunpod;
let t: TestApp;
let comfyDir: string;
let podDisk: string;

beforeEach(async () => {
  home = await makeFake();
  podDisk = mkdtempSync(join(tmpdir(), "afflatus-poddisk-"));
  mkdirSync(join(podDisk, "checkpoints"));
  runpod = await startFakeRunpod({
    key: KEY, bootMs: 50, pods: [],
    spawn: async () => {
      // a fresh pod: another checkpoint only, the pack that takes uploads, its model folders on a disk of its own
      pod = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: ["other.safetensors"], upscale_models: [] }, folderPaths: { checkpoints: [join(podDisk, "checkpoints")] }, hideFolderPaths: true });
      pod.packVersion = "0.14.0";
      return pod;
    },
  });
  vi.stubEnv("RUNPOD_API_URL", runpod.url);
  vi.stubEnv("RUNPOD_PROXY", "http://127.0.0.1:{id}");
  // this computer's ComfyUI folder: it has the job's checkpoint, which no site is known for, so it is sent from here
  comfyDir = mkdtempSync(join(tmpdir(), "afflatus-comfydir-"));
  mkdirSync(join(comfyDir, "models", "checkpoints"), { recursive: true });
  writeFileSync(join(comfyDir, "models", "checkpoints", CHECKPOINT), Buffer.alloc(120_000, 5));
  t = await makeApp({ comfyUrl: home.url });
  t.services.rented.everyMs = 60_000;
  t.services.rented.imageCheck = async () => true;
  t.services.podFiles.uploadBackoffMs = 10;
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY, downloadModels: true, civitaiLookups: true } });
  await writeSettings(t.db, { comfyDir });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  // the envs unstubbed last: a RunPod call still under way until the close (a hunt's round, a poll) read them
  // again and, without them, went to RunPod itself
  vi.unstubAllEnvs();
  await Promise.all([home, runpod, pod].map((x) => x?.close().catch(() => {})));
});

/** A pod deployed and up, as a machine of Afflatus. */
async function deployed(more: Record<string, unknown> = {}): Promise<string> {
  const res = await post(t.app, "/api/runpod/deploy", { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 60, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15, ...more });
  expect(res.statusCode).toBe(200);
  const id = res.json().id as string;
  await until(() => runpod.pods[0]?.status === "RUNNING");
  await until(async () => (await t.services.rented.poll(), !(await readSettings(t.db)).machines.find((m) => m.id === id)?.rented?.deployedAt));
  return id;
}
const row = (id: string) => t.db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const enqueue = async (over: Record<string, unknown> = {}) => (await post(t.app, "/api/jobs", job(over))).json().ids[0] as string;
const homeId = async () => (await readSettings(t.db)).machines[0]!.id;

/** A take at 24 fps whose render's own frames are kept beside it at 12 fps: an interpolated one, whose finish runs RIFE again. */
async function interpolatedTake(): Promise<string> {
  const id = newId();
  const at = now();
  const made = (fps: number) => {
    const file = join(comfyDir, `zz-test-${fps}.mp4`);
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=128x96:rate=${fps}:duration=1`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
    if (r.status !== 0) throw new Error(String(r.stderr));
    return readFileSync(file);
  };
  await t.services.storage.put(`assets/${id}`, made(24));
  await t.services.storage.put(`raw/${id}`, made(12));
  await t.db.insertInto("assets").values({
    id, owner_id: OWNER, kind: "video", origin: "generated", name: "zz-test take", file_key: `assets/${id}`, raw_key: `raw/${id}`, thumb_key: null, mime: "video/mp4", bytes: 4,
    width: 128, height: 96, duration_ms: 1000, fps: 24, has_sound: 0, folder_id: null, generation_id: null, kept_at: at, deleted_at: null, created_at: at,
  } as never).execute();
  return id;
}

describe("a job whose model file a pod lacks", () => {
  it("goes to the pod when that is where it ends soonest: its file is sent first, then it runs there", async () => {
    const id = await deployed();
    // this computer paused: the pod is the only place it can run
    await post(t.app, "/api/queue/pause", { machine: await homeId() });
    const a = await enqueue();
    await until(() => pod.prompts.size === 1, 15_000);
    expect(pod.packUploaded.length).toBeGreaterThan(0);
    expect(t.services.podFiles.view(id)).toEqual([expect.objectContaining({ file: CHECKPOINT, state: "ready", tier: "need", via: "upload", jobs: [a] })]);
    // the pod's row lists what it got
    expect((await t.services.queue.status()).machines.find((m) => m.id === id)?.rented).toMatchObject({ files: [expect.objectContaining({ file: CHECKPOINT, state: "ready" })] });
    complete(pod, [...pod.prompts.keys()][0]!);
    await until(async () => (await row(a)).status === "done");
    expect((await row(a)).machine_id).toBe(id);
    expect(home.prompts.size).toBe(0);
  });

  it("stays home when home is sooner, and its file is sent to the pod ahead, for later", async () => {
    const id = await deployed();
    const a = await enqueue();
    await until(() => home.prompts.size === 1);
    await until(() => t.services.podFiles.view(id)[0]?.state === "ready", 15_000);
    expect(t.services.podFiles.view(id)[0]).toMatchObject({ file: CHECKPOINT, tier: "ahead", jobs: [] });
    expect(pod.prompts.size).toBe(0);
    complete(home, [...home.prompts.keys()][0]!);
    await until(async () => (await row(a)).status === "done");
    expect((await row(a)).machine_id).toBe(await homeId());
  });

  it("that cannot be had: kept off the pod, and a job pinned there does not keep the pod billed", async () => {
    const id = await deployed();
    await post(t.app, "/api/queue/pause", { machine: await homeId() });
    // a file no site is known for, and this computer has none either
    const a = await enqueue({ checkpoint: "nowhere.safetensors" });
    home.models.checkpoints = [CHECKPOINT, "other.safetensors", "nowhere.safetensors"];
    await post(t.app, `/api/setup/rescan?machine=${await homeId()}`, {});
    expect((await post(t.app, `/api/jobs/${a}/machine`, { machine: id })).statusCode).toBe(200);
    await until(() => t.services.podFiles.view(id)[0]?.state === "failed", 15_000);
    expect(t.services.podFiles.view(id)[0]!.error).toContain("no site is known");
    await new Promise((r) => setTimeout(r, 100));
    expect(pod.prompts.size).toBe(0);
    // nothing the pod can ever run: no work, so its idle time runs
    expect(await t.services.queue.wants(id)).toBe(false);
    const waiting = (await t.services.queue.status()).waiting.find((w) => w.id === a);
    expect(waiting?.lacks?.[id]?.files).toEqual([{ file: "nowhere.safetensors", folder: "checkpoints" }]);
    expect(waiting?.lacks?.[id]?.failed).toContain("no site is known");
  });

  // card #93: #81's test pod sat 33 min billed with its job planned there after its file failed and was put on the pod by other
  // means (the hold itself, a failed entry of a file it no longer lacks, is podFiles.test's)
  it("that could not be had, then is on the pod after all: the job runs there", async () => {
    const id = await deployed();
    await post(t.app, "/api/queue/pause", { machine: await homeId() });
    const a = await enqueue({ checkpoint: "nowhere.safetensors" });
    home.models.checkpoints = [CHECKPOINT, "other.safetensors", "nowhere.safetensors"];
    await post(t.app, `/api/setup/rescan?machine=${await homeId()}`, {});
    expect((await post(t.app, `/api/jobs/${a}/machine`, { machine: id })).statusCode).toBe(200);
    await until(() => t.services.podFiles.view(id)[0]?.state === "failed", 15_000);
    // put on the pod by other means (its pack's own download route): in its folder, among its loader's choices, its folders read again
    writeFileSync(join(podDisk, "checkpoints", "nowhere.safetensors"), Buffer.alloc(10, 1));
    ((pod.catalog.CheckpointLoaderSimple!.input.required!.ckpt_name as unknown[])[0] as string[]).push("nowhere.safetensors");
    await post(t.app, `/api/setup/rescan?machine=${id}`, {});
    // its old failed entry, of a file it no longer lacks, holds it no more
    await until(() => pod.prompts.size === 1, 15_000);
    complete(pod, [...pod.prompts.keys()][0]!);
    await until(async () => (await row(a)).status === "done");
    expect((await row(a)).machine_id).toBe(id);
  });

  it("waiting for another job to end is no work for a pod: it does not keep it billed", async () => {
    const id = await deployed();
    await post(t.app, "/api/queue/pause", { machine: await homeId() });
    // a job that waits for another (a clip after the one it continues) whose own start is not possible now
    const first = await enqueue({ checkpoint: "nowhere.safetensors" });
    const second = await enqueue();
    await t.db.updateTable("jobs").set({ depends_on: first }).where("id", "=", second).execute();
    await t.db.updateTable("jobs").set({ pin_machine: await homeId() }).where("id", "=", first).execute();
    expect(await t.services.queue.wants(id)).toBe(false);
  });

  it("is no work for a pod the plan sends it away from", async () => {
    const id = await deployed();
    // renders known to take a second (as learned renders would say): this computer's running one ends in a second
    (t.services.queue as unknown as { expected: () => Promise<number> }).expected = async () => 1_000;
    // this computer busy with one job, a second waiting: home is still sooner than the pod with its file to come
    const a = await enqueue();
    await until(() => home.prompts.size === 1);
    // the file the first job's sending ahead put on the pod is taken off it again, and the pod looked at again
    await until(() => t.services.podFiles.view(id)[0]?.state !== "fetching");
    t.services.podFiles.forget(id);
    rmSync(join(podDisk, "checkpoints", CHECKPOINT), { force: true });
    await post(t.app, `/api/setup/rescan?machine=${id}`, {});
    // its file takes ten minutes to reach the pod
    t.services.queue.podFetch!.untilThere = async () => 10 * 60_000;
    const b = await enqueue({ prompt: "a dog" });
    // the plan sends it home (its file would take longer to reach the pod than home takes): the pod has no work
    expect(await t.services.queue.wants(id)).toBe(false);
    // its row says the pod could take it, once sent its file, and how long that takes
    const waitingB = (await t.services.queue.status()).waiting.find((w) => w.id === b);
    expect(waitingB).toMatchObject({ machine: await homeId(), fetch: { [id]: { files: [{ file: CHECKPOINT, folder: "checkpoints" }], ms: 10 * 60_000 } } });
    for (const p of [...home.prompts.keys()]) complete(home, p);
    await until(async () => (await row(a)).status === "done");
    await until(() => home.prompts.size === 2);
    complete(home, [...home.prompts.keys()][1]!);
    await until(async () => (await row(b)).status === "done");
  });
});

describe("a pod's files planned from the waiting jobs", () => {
  it("never include those of a job pinned to this computer: it can never run on the pod", async () => {
    const id = await deployed();
    const a = (await post(t.app, "/api/jobs", { ...job(), machine: await homeId() })).json().ids[0] as string;
    await until(() => home.prompts.size === 1);
    // a few passes later (a free job's file is sent ahead within them: "stays home when home is sooner"), nothing came
    await new Promise((r) => setTimeout(r, 300));
    t.services.queue.nudge();
    await new Promise((r) => setTimeout(r, 300));
    expect(t.services.podFiles.view(id)).toEqual([]);
    complete(home, [...home.prompts.keys()][0]!);
    await until(async () => (await row(a)).status === "done");
  });

  it("never go to a pod paused while this computer takes everything (Use only), unless a job is pinned to the pod", async () => {
    const id = await deployed();
    await post(t.app, "/api/queue/use-only", { machine: await homeId() });
    const a = await enqueue();
    await until(() => home.prompts.size === 1);
    await new Promise((r) => setTimeout(r, 300));
    t.services.queue.nudge();
    await new Promise((r) => setTimeout(r, 300));
    expect(t.services.podFiles.view(id)).toEqual([]);
    // one pinned to the paused pod waits for it: its files come ahead, for its Resume
    await enqueue({ prompt: "a dog" }).then((b) => post(t.app, `/api/jobs/${b}/machine`, { machine: id }));
    await until(() => t.services.podFiles.view(id).some((f) => f.file === CHECKPOINT && f.tier === "ahead"), 15_000);
    complete(home, [...home.prompts.keys()][0]!);
    await until(async () => (await row(a)).status === "done");
  });

  it("include the upscaler of a job with hires fix, sent from this computer when no site is known for it", async () => {
    mkdirSync(join(comfyDir, "models", "upscale_models"), { recursive: true });
    writeFileSync(join(comfyDir, "models", "upscale_models", "zz-test-upscaler.pth"), Buffer.alloc(50_000, 7));
    home.models.upscale_models = ["zz-test-upscaler.pth"];
    await post(t.app, `/api/setup/rescan?machine=${await homeId()}`, {});
    const id = await deployed();
    await post(t.app, "/api/queue/pause", { machine: await homeId() });
    const a = await enqueue({ hires: true, hiresUpscaler: "zz-test-upscaler.pth" });
    await until(() => t.services.podFiles.view(id).length === 2, 15_000);
    expect(t.services.podFiles.view(id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: CHECKPOINT, folder: "checkpoints", tier: "need", jobs: [a] }),
      expect.objectContaining({ file: "zz-test-upscaler.pth", folder: "upscale_models", tier: "need", jobs: [a] }),
    ]));
  });

  it("include RIFE (its download) for the finish of an interpolated take, and the finish waits on the pod for it", async () => {
    // a finish is no recipe: a pod got none of its files, and Timeline 19's finish failed there for want of RIFE (2026-10-18)
    mkdirSync(join(comfyDir, "models", "frame_interpolation"), { recursive: true });
    writeFileSync(join(comfyDir, "models", "frame_interpolation", "rife49.pth"), Buffer.alloc(50_000, 7));
    home.models.frame_interpolation = ["rife49.pth"];
    mkdirSync(join(comfyDir, "models", "upscale_models"), { recursive: true });
    writeFileSync(join(comfyDir, "models", "upscale_models", "zz-test-upscaler.pth"), Buffer.alloc(50_000, 7));
    home.models.upscale_models = ["zz-test-upscaler.pth"];
    await post(t.app, `/api/setup/rescan?machine=${await homeId()}`, {});
    const id = await deployed();
    await post(t.app, "/api/queue/pause", { machine: await homeId() });
    const asset = await interpolatedTake();
    const a = await t.services.queue.enqueueCut({ asset, action: "finish", route: "model", upscaleModel: "zz-test-upscaler.pth", by: 2, startMs: 0, endMs: 1000 }, "zz-test finish");
    await until(() => t.services.podFiles.view(id).length === 2, 15_000);
    expect(t.services.podFiles.view(id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: RIFE_GET.file, folder: "frame_interpolation", tier: "need", jobs: [a] }),
      expect.objectContaining({ file: "zz-test-upscaler.pth", folder: "upscale_models", tier: "need", jobs: [a] }),
    ]));
  });

  it("are sent ahead to a pod deployed while the queue is paused, which stays up while they move and stops 10 min after they are in", async () => {
    // Pause all with this computer alone, a job waiting; then a pod deployed
    await post(t.app, "/api/queue/pause", {});
    const a = await enqueue();
    const id = await deployed();
    await until(() => t.services.podFiles.view(id)[0]?.state === "ready", 15_000);
    expect(t.services.podFiles.view(id)).toEqual([expect.objectContaining({ file: CHECKPOINT, tier: "ahead", jobs: [] })]);
    // nothing starts while paused: no work for it, its files in, nothing moving any more
    expect(pod.prompts.size + home.prompts.size).toBe(0);
    expect((await row(a)).status).toBe("queued");
    expect(await t.services.queue.wants(id)).toBe(false);
    expect(t.services.queue.fetching(id)).toBe(false);
    // while a file moves (said so here: the real one came in a moment), past its idle time it stays up, its idle time held
    const files = t.services.podFiles;
    const moving = vi.spyOn(files, "moving").mockReturnValue(true);
    const real = Date.now();
    t.services.rented.now = () => real + 11 * 60_000;
    await t.services.rented.poll();
    expect(runpod.pods[0]!.status).toBe("RUNNING");
    expect((await t.services.queue.status()).machines.find((m) => m.id === id)?.rented?.idleLeftMs).toBeNull();
    // the last file in: its idle time runs again from then, 10 min
    moving.mockReturnValue(false);
    t.services.rented.now = () => real + 20 * 60_000;
    await t.services.rented.poll();
    expect(runpod.pods[0]!.status).toBe("RUNNING");
    t.services.rented.now = () => real + 22 * 60_000;
    await t.services.rented.poll();
    expect(runpod.pods[0]?.status ?? "gone").not.toBe("RUNNING");
  });
});

describe("a pod deployed after Pause all", () => {
  it("of several machines joins paused: nothing starts on it, its files come ahead, and Resume all sends the jobs", async () => {
    const second = await makeFake();
    try {
      await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: [{ id: await homeId(), url: home.url, dir: comfyDir }, { id: "m2", url: second.url }] } });
      await post(t.app, "/api/queue/pause", {});
      const a = await enqueue();
      const id = await deployed();
      expect((await t.services.queue.status()).machines.find((m) => m.id === id)?.paused).toBe(true);
      await until(() => t.services.podFiles.view(id)[0]?.state === "ready", 15_000);
      expect(t.services.podFiles.view(id)[0]).toMatchObject({ file: CHECKPOINT, tier: "ahead" });
      await new Promise((r) => setTimeout(r, 100));
      expect(pod.prompts.size + home.prompts.size + second.prompts.size).toBe(0);
      expect((await row(a)).status).toBe("queued");
      // Resume all: every machine, the pod too, and the job goes
      await post(t.app, "/api/queue/resume", {});
      expect((await t.services.queue.status()).machines.every((m) => !m.paused)).toBe(true);
      await until(() => pod.prompts.size + home.prompts.size + second.prompts.size === 1);
    } finally {
      await second.close().catch(() => {});
    }
  }, 30_000);

  it("of one machine is held by its switch, and Resume sends the jobs", async () => {
    await post(t.app, "/api/queue/pause", {});
    const a = await enqueue();
    const id = await deployed();
    await until(() => t.services.podFiles.view(id)[0]?.state === "ready", 15_000);
    await new Promise((r) => setTimeout(r, 100));
    expect(pod.prompts.size + home.prompts.size).toBe(0);
    expect(await t.services.queue.pausedOn(id)).toBe(true);
    await post(t.app, "/api/queue/resume", {});
    expect(await t.services.queue.pausedOn(id)).toBe(false);
    await until(() => pod.prompts.size + home.prompts.size === 1);
    expect((await row(a)).status).toBe("running");
  }, 30_000);
});

describe("a deploy's files", () => {
  it("are the waiting jobs' (each once, with how many use it) and the picked set's, with what earlier deploys measured", async () => {
    await post(t.app, "/api/queue/pause", {});
    await enqueue();
    await enqueue({ prompt: "a dog" });
    const set = (await post(t.app, "/api/model-sets", { name: "LoRAs", files: [{ file: "style.safetensors", folder: "loras", url: "https://huggingface.co/o/r/resolve/main/style.safetensors", size: 300 }] })).json();
    const view = (await get(t.app, `/api/runpod/deploy/models?cloud=SECURE&set=${set.id}`)).json();
    expect(view.jobs.count).toBe(2);
    expect(view.jobs.files).toEqual([expect.objectContaining({ file: CHECKPOINT, folder: "checkpoints", via: "upload", size: 120_000, jobs: 2, first: true })]);
    expect(view.set).toEqual([expect.objectContaining({ file: "style.safetensors", via: "hf", size: 300, off: false })]);
    // nothing measured yet: the page says time and price are not known
    expect(view.speeds).toEqual({ hf: null, civitai: null, url: null, upload: null });
    expect(view.boot).toBeNull();
  });

  it("are handed to the pod at its first answer, the ones left out never fetched, and its boot time kept", async () => {
    const id = await deployed({ files: [{ file: "style.safetensors", folder: "checkpoints" }], leaveOut: [{ file: CHECKPOINT, folder: "checkpoints" }] });
    expect(t.services.podFiles.view(id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "style.safetensors", tier: "ahead" }),
      expect.objectContaining({ file: CHECKPOINT, state: "failed", error: "left out when the pod was deployed" }),
    ]));
    // handed once: its record keeps them no more, and the next deploy starts with none
    const settings = await readSettings(t.db);
    expect(settings.machines.find((m) => m.id === id)?.rented).toMatchObject({ files: [], leaveOut: [] });
    expect(settings.lastDeploy).toMatchObject({ files: [], leaveOut: [], accept: [] });
    expect((await t.db.selectFrom("pod_measures").select(["kind", "cloud"]).execute())).toEqual([{ kind: "boot", cloud: "SECURE" }]);
    // a job that uses the file left out stays home
    await post(t.app, "/api/queue/pause", { machine: await homeId() });
    const a = await enqueue();
    // Waited for until a pass has said what the pod lacks for it, rather than for a fixed time a loaded run outlasts.
    await until(async () => Boolean((await t.services.queue.status()).waiting.find((w) => w.id === a)?.lacks?.[id]));
    expect(pod.prompts.size).toBe(0);
  });

  it("of a preset under a licence are refused until it is accepted in the dialog", async () => {
    const set = (await post(t.app, "/api/model-sets", { name: "H3", presets: ["shipped:minimax-h3"] })).json();
    const files = (await get(t.app, `/api/runpod/deploy/models?set=${set.id}`)).json().set.map(({ file, folder }: { file: string; folder: string }) => ({ file, folder }));
    const ask = { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 60, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15, set: set.id, files };
    const refused = await post(t.app, "/api/runpod/deploy", ask);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/accept it first/);
    expect(runpod.pods).toHaveLength(0);
    expect((await post(t.app, "/api/runpod/deploy", { ...ask, accept: ["shipped:minimax-h3"] })).statusCode).toBe(200);
    expect((await readSettings(t.db)).acceptedPresets).toContain("shipped:minimax-h3");
  });

  it("of a licensed preset are under its licence whichever way they were picked (added by hand, from no set)", async () => {
    const view = (await get(t.app, "/api/runpod/deploy/models")).json();
    // the dialog is told which files each licence covers
    const h3 = view.licences.find((l: { id: string }) => l.id === "shipped:minimax-h3");
    expect(h3.keys).toContain("diffusion_models|minimax_h3_fl2va_pruned_int8_convrot.safetensors");
    const ask = { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 60, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15, files: [{ file: "minimax_h3_fl2va_pruned_int8_convrot.safetensors", folder: "diffusion_models" }] };
    expect((await post(t.app, "/api/runpod/deploy", ask)).json().error).toMatch(/accept it first/);
    expect(runpod.pods).toHaveLength(0);
  });

  it("of the remembered set come again with Deploy again", async () => {
    const set = (await post(t.app, "/api/model-sets", { name: "LoRAs", files: [{ file: "style.safetensors", folder: "loras", url: "https://huggingface.co/o/r/resolve/main/style.safetensors" }] })).json();
    const res = await post(t.app, "/api/runpod/deploy", { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 60, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15, set: set.id, again: true });
    expect(res.statusCode).toBe(200);
    const machine = (await readSettings(t.db)).machines.find((m) => m.id === res.json().id);
    expect(machine?.rented?.files).toEqual([{ file: "style.safetensors", folder: "loras", url: "https://huggingface.co/o/r/resolve/main/style.safetensors" }]);
  });
});

describe("a job pinned to a pod still booting", () => {
  /** A pod deployed and running on RunPod whose ComfyUI does not answer yet (its boot), as the rented poll read it. */
  async function booting(): Promise<string> {
    runpod.comfyStaysDown = true;
    const res = await post(t.app, "/api/runpod/deploy", { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 60, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15 });
    expect(res.statusCode).toBe(200);
    await until(() => runpod.pods[0]?.status === "RUNNING");
    await t.services.rented.poll();
    return res.json().id as string;
  }
  /** Queued pinned to the pod, and seen waiting for its ComfyUI to answer. */
  async function pinned(id: string): Promise<string> {
    const a = (await post(t.app, "/api/jobs", { ...job(), machine: id })).json().ids[0] as string;
    await until(async () => (await t.services.queue.status()).waiting.find((w) => w.id === a)?.lacks?.[id]?.why === "its ComfyUI is not answering yet");
    return a;
  }
  /** Its ComfyUI answers now, and the rented poll (on its own timer, whether a page is open or not) sees it: nothing else. */
  async function answers(): Promise<void> {
    runpod.comfyStaysDown = false;
    pod.down = false;
    await t.services.rented.poll();
  }

  it("has its files sent once the pod answers, with no other change to the queue and no page open", async () => {
    const id = await booting();
    const a = await pinned(id);
    expect(t.services.podFiles.view(id)).toEqual([]);
    await answers();
    await until(() => t.services.podFiles.view(id).some((f) => f.file === CHECKPOINT && f.tier === "need"));
    expect(t.services.podFiles.view(id)).toEqual([expect.objectContaining({ file: CHECKPOINT, tier: "need", jobs: [a] })]);
    await until(() => pod.prompts.size === 1, 15_000);
    expect(home.prompts.size).toBe(0);
  });

  it("has them sent too when its first scan after it answers does not come (its node list slow on a fresh pod)", async () => {
    const id = await booting();
    const a = await pinned(id);
    // the next two scans of the pod fail as an unread node list does; the ones after read it
    const comfy = (await t.services.machines()).find((m) => m.machine.id === id)!.comfy;
    const real = comfy.scan.bind(comfy);
    let failing = 2;
    comfy.scan = async (fresh) => (failing-- > 0 ? { at: new Date().toISOString(), comfy: { online: false, url: comfy.url, error: "timed out" }, families: [], recipes: [] } : real(fresh));
    await answers();
    await until(() => t.services.podFiles.view(id).some((f) => f.file === CHECKPOINT && f.tier === "need" && f.jobs.includes(a)));
    expect(failing).toBeLessThan(0);
    // ended once the job is on the pod, as the test before: left mid-start (its file still coming), the app's close waited
    // past the hook's limit on CI's slower runner
    await until(() => pod.prompts.size === 1, 15_000);
  });

  it("keeps the pod from its idle time while the files its job waits for come", async () => {
    const id = await booting();
    // files that take long to come: asked for, never there during the test
    const want = vi.fn();
    t.services.queue.podFetch = { failed: () => null, short: async () => null, untilThere: async () => 5 * 60_000, want, drop: () => {}, holdsFor: () => false, jobState: () => "waiting", holding: () => false, moving: () => false, failingPacks: () => new Map() };
    const a = await pinned(id);
    await answers();
    await until(() => want.mock.calls.some(([m, , tier, j]) => m === id && tier === "need" && j === a));
    expect(await t.services.queue.wants(id)).toBe(true);
    // past its idle time (10 min) since it was last seen at work: still at work, so still up
    const real = Date.now();
    t.services.rented.now = () => real + 11 * 60_000;
    await t.services.rented.poll();
    expect(runpod.pods[0]!.status).toBe("RUNNING");
    expect(pod.prompts.size).toBe(0);
  });
});
