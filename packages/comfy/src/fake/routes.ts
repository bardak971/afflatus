import type { Graph } from "@afflatus/core";
import type { FakeRequest, FakeState } from "../testing";

/**
 * ComfyUI's own routes, and the Afflatus node pack's: the node list, the model folders, the queue and the
 * history, uploads and downloads. `queued` hears of each prompt taken, with the client id it was queued under.
 */
export function fakeRoutes(fake: FakeState, hooks: { queued(promptId: string, clientId: string | null): void }): (r: FakeRequest) => boolean {
  let n = 0;
  /** The client id each prompt was queued under, as GET /queue says it in each entry's extra_data. */
  const clientOf = new Map<string, string>();
  const entry = (id: string, i: number) => [i, id, {}, clientOf.has(id) ? { client_id: clientOf.get(id) } : {}, []];
  // the log's lines are stamped once, when the fake started: read again, they are the same lines
  const started = new Date().toISOString();
  return ({ method, path, url, headers, raw, json, plain }) => {
    if (method === "GET") {
      if (path === "/system_stats") {
        const ram = fake.ram ? { ram_total: fake.ram.total, ram_free: fake.ram.free } : {};
        return json(200, { system: { comfyui_version: fake.version, ...(fake.pytorch ? { pytorch_version: fake.pytorch } : {}), ...ram }, devices: [{ name: fake.device?.name ?? "fake gpu", vram_total: (fake.device?.vramGb ?? 12) * 2 ** 30, vram_free: (fake.device?.vramGb ?? 12) * (2 / 3) * 2 ** 30 }] });
      }
      if (path === "/object_info") return json(200, fake.catalog);
      // one node type, as ComfyUI answers it: that type alone, or nothing when it does not have it
      if (path.startsWith("/object_info/")) {
        const node = decodeURIComponent(path.slice("/object_info/".length));
        return json(200, fake.catalog[node] ? { [node]: fake.catalog[node] } : {});
      }
      if (path === "/internal/logs/raw") {
        const t = started;
        return json(200, { entries: [
          { t, m: "Total VRAM 12288 MB, total RAM 32768 MB" },
          { t, m: `ComfyUI version: ${fake.version}` },
          { t, m: "Starting server" },
          { t, m: "To see the GUI go to: http://127.0.0.1:8188" },
          ...Object.keys(fake.history).map((id) => ({ t, m: `got prompt ${id}` })),
          // ComfyUI keeps each write as it came, a line's end among them: the lines above are given whole, without it
          ...(fake.printed.length ? [{ t, m: "\n" }] : []),
          ...fake.printed.map((m) => ({ t, m })),
        ] });
      }
      if (path === "/models") return json(200, Object.keys(fake.models));
      if (path.startsWith("/models/")) {
        const list = fake.models[decodeURIComponent(path.slice(8))];
        return list ? json(200, list) : json(404, { error: "unknown folder" });
      }
      if (path === "/afflatus/header") {
        if (!fake.headers) return json(404, {});
        const header = fake.headers[`${url.searchParams.get("folder") ?? ""}/${url.searchParams.get("filename") ?? ""}`];
        return header ? json(200, header) : json(404, {});
      }
      if (path === "/afflatus/power") return fake.watts === undefined ? json(404, {}) : json(200, { watts: fake.watts, source: fake.watts === null ? null : "nvml" });
      if (path === "/afflatus/version") return fake.packVersion ? json(200, { pack: "afflatus-nodes", version: fake.packVersion }) : json(404, {});
      if (path.startsWith("/view_metadata/")) {
        const header = fake.metadata[`${decodeURIComponent(path.slice(15))}/${url.searchParams.get("filename") ?? ""}`];
        return header ? json(200, header) : json(404, {});
      }
      if (path.startsWith("/history/")) {
        const id = decodeURIComponent(path.slice(9));
        return json(200, fake.history[id] ? { [id]: fake.history[id] } : {});
      }
      if (path === "/queue") {
        return json(200, { queue_running: fake.running.map(entry), queue_pending: fake.pending.map(entry) });
      }
      if (path === "/view") {
        const file = fake.files[url.searchParams.get("filename") ?? ""];
        return file ? plain(200, file, "application/octet-stream") : json(404, { error: "no such file" });
      }
      return false;
    }
    // no custom node pack serves example workflows in the pretend ComfyUI
    if (method === "HEAD") return plain(404);
    if (method !== "POST") return false;
    if (path === "/prompt") {
      if (fake.rejectWith) return json(400, fake.rejectWith);
      if (fake.rejectNext.length) return json(400, fake.rejectNext.shift());
      const sent = JSON.parse(raw.toString("utf-8")) as { prompt: Graph; client_id?: string; prompt_id?: string };
      // the id the client chose, as ComfyUI takes it; else one of its own
      const id = typeof sent.prompt_id === "string" && sent.prompt_id ? sent.prompt_id : `prompt-${++n}`;
      fake.prompts.set(id, sent.prompt);
      if (typeof sent.client_id === "string") clientOf.set(id, sent.client_id);
      fake.pending.push(id);
      hooks.queued(id, typeof sent.client_id === "string" ? sent.client_id : null);
      return json(200, { prompt_id: id });
    }
    if (path === "/queue") {
      const ids = (JSON.parse(raw.toString("utf-8")) as { delete?: string[] }).delete ?? [];
      fake.pending = fake.pending.filter((id) => !ids.includes(id));
      return json(200, {});
    }
    if (path === "/interrupt") {
      const id = (JSON.parse(raw.toString("utf-8")) as { prompt_id?: string }).prompt_id;
      fake.running = fake.running.filter((r) => r !== id || fake.deaf.has(r));
      return json(200, {});
    }
    if (path === "/free") return json(200, {});
    if (path.startsWith("/userdata/")) {
      const file = decodeURIComponent(path.slice("/userdata/".length));
      fake.userdata[file] = JSON.parse(raw.toString("utf-8"));
      return json(200, { path: file, size: raw.length, modified: Date.now() });
    }
    if (path === "/upload/image") {
      const name = /filename="([^"]+)"/.exec(raw.toString("latin1"))?.[1] ?? "upload.bin";
      fake.uploads.push(name);
      // the file part of the form: from after its headers to the next boundary
      const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(String(headers["content-type"] ?? ""));
      const head = raw.indexOf(`filename="${name}"`);
      const from = head < 0 ? -1 : raw.indexOf("\r\n\r\n", head) + 4;
      const to = boundary && from > 3 ? raw.indexOf(`\r\n--${boundary[1] ?? boundary[2]}`, from) : -1;
      if (to > from) fake.uploaded[name] = new Uint8Array(raw.subarray(from, to));
      // the folder asked for (temp, or input with a subfolder), as ComfyUI answers it
      const field = (key: string) => new RegExp(`name="${key}"\\r\\n\\r\\n([^\\r]*)`).exec(raw.toString("latin1"))?.[1] ?? "";
      return json(200, { name, subfolder: field("subfolder"), type: field("type") || "temp" });
    }
    if (path === "/afflatus/alive") {
      // the node pack's watchdog (0.13.0): "still here", with the minutes it may be silent
      // no pack: not found; an older ComfyUI, whose page answers every address, refuses the method instead (405)
      if (!fake.packVersion || !/^0\.(1[3-9]|[2-9]\d)\.|^[1-9]/.test(fake.packVersion)) return json(fake.oldPage ? 405 : 404, {});
      const minutes = Number((JSON.parse(raw.toString("utf8") || "{}") as { minutes?: unknown }).minutes ?? 0);
      fake.alive.push({ at: Date.now(), minutes });
      return json(200, { watching: minutes > 0, minutes, can: true });
    }
    if (path === "/afflatus/clean-input") {
      // as the pack does: only a JSON body, which a page of another site cannot send without asking first
      if (!/^application\/json\b/.test(String(headers["content-type"] ?? ""))) return json(415, { error: "a JSON body is expected" });
      fake.cleaned.push(JSON.parse(raw.toString("utf8") || "{}"));
      return json(200, { removed: 0 });
    }
    return false;
  };
}
