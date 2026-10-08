import type { FakeInit, FakeRequest, FakeState } from "../testing";

/** Where Manager puts a model by its type, when the install says "default". */
const MANAGER_FOLDER: Record<string, string> = {
  checkpoints: "checkpoints", checkpoint: "checkpoints", lora: "loras", vae: "vae", clip: "text_encoders", text_encoders: "text_encoders",
  unet: "diffusion_models", diffusion_model: "diffusion_models", upscale: "upscale_models", controlnet: "controlnet", clip_vision: "clip_vision", embedding: "embeddings",
};

type Install = { type: string; save_path: string; url: string; filename: string };
type Task = { ui_id: string; client_id: string; kind: string; params: { id: string; version: string; repository?: string } };

/**
 * The pretend ComfyUI-Manager (init.manager): its model installs, its pack queue and its restart. Without
 * `init.manager` it answers nothing, as a ComfyUI without Manager.
 */
export function fakeManager(fake: FakeState, init: FakeInit): (r: FakeRequest) => boolean {
  let installs: Install[] = [];
  let tasks: Task[] = [];
  const history: Record<string, { ui_id: string; client_id: string; kind: string; timestamp: string; result: string; status: { status_str: string; completed: boolean; messages: string[] } }> = {};
  const runTask = (t: Task) => {
    const failed = init.packsFail?.includes(t.params.id);
    if (!failed) fake.packs.push(t.params);
    history[t.ui_id] = {
      ui_id: t.ui_id, client_id: t.client_id, kind: t.kind, timestamp: new Date().toISOString(),
      result: failed ? `Cannot resolve install target: '${t.params.id}@${t.params.version}'` : "success",
      status: { status_str: failed ? "failed" : "success", completed: true, messages: [] },
    };
  };
  const install = async (task: Install) => {
    const got = await fetch(task.url).catch(() => null);
    if (!got?.ok) return;
    // a download cut off half way leaves nothing: the real one only writes a file it has all of
    const whole = await got.arrayBuffer().catch(() => null);
    if (!whole) return;
    const bytes = whole.byteLength;
    const [folder, ...sub] = task.save_path === "default" ? [MANAGER_FOLDER[task.type.toLowerCase()] ?? "etc"] : task.save_path.split("/");
    const file = [...sub, task.filename].join("\\");
    (fake.models[folder!] ??= []).push(file);
    fake.installed.push({ folder: folder!, file, bytes });
    // the loaders of that folder offer it from now on, when they list files at all
    const loader = ({ checkpoints: ["CheckpointLoaderSimple", "ckpt_name"], diffusion_models: ["UNETLoader", "unet_name"], loras: ["LoraLoader", "lora_name"], vae: ["VAELoader", "vae_name"], text_encoders: ["CLIPLoader", "clip_name"] } as Record<string, [string, string]>)[folder!];
    const spec = loader && (fake.catalog[loader[0]]?.input.required?.[loader[1]] as unknown[] | undefined);
    const list = Array.isArray(spec?.[0]) ? (spec![0] as string[]) : (spec?.[1] as { options?: string[] } | undefined)?.options;
    if (list?.length) list.push(file);
  };

  return ({ method, path, url, headers, raw, json, plain }) => {
    if (!init.manager) return false;
    if (method === "GET") {
      if (path === "/v2/customnode/getmappings") return json(200, init.mappings ?? {});
      if (path === "/v2/manager/queue/history") {
        const client = url.searchParams.get("client_id");
        return json(200, { history: Object.fromEntries(Object.entries(history).filter(([, h]) => !client || h.client_id === client)) });
      }
      if (path === "/v2/manager/queue/status") {
        return json(200, { total_count: tasks.length + installs.length, done_count: Object.keys(history).length, in_progress_count: 0, pending_count: tasks.length + installs.length, is_processing: false });
      }
      if (path === "/v2/manager/version") return plain(200, "V0.0.0-fake", "text/plain");
      return false;
    }
    if (method !== "POST") return false;
    if (path === "/v2/manager/queue/install_model") {
      const task = JSON.parse(raw.toString("utf-8")) as Install & { client_id?: string; ui_id?: string };
      if (!task.client_id || !task.ui_id || /[\\/:]/.test(task.filename)) return plain(400, "Invalid model data");
      installs.push(task);
      return plain(200);
    }
    if (path === "/v2/manager/reboot") {
      if (/^(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)/.test(headers["content-type"] ?? "")) return plain(400, "simple form posts are refused");
      fake.reboots++;
      if (fake.packs.length) Object.assign(fake.catalog, init.afterReboot ?? {});
      return plain(200);
    }
    if (path === "/v2/manager/queue/task") {
      const task = JSON.parse(raw.toString("utf-8")) as Task;
      if (!task.ui_id || !task.client_id || task.kind !== "install" || !task.params?.id) return plain(400, "Invalid task data");
      tasks.push(task);
      return plain(200);
    }
    if (path === "/v2/manager/queue/start") {
      const todo = installs;
      installs = [];
      const queued = tasks;
      tasks = [];
      if (init.manager !== "refuses") for (const task of todo) void install(task);
      if (init.manager !== "refuses") for (const task of queued) runTask(task);
      return plain(200);
    }
    return false;
  };
}
