/**
 * What ComfyUI's own editor makes of each corpus workflow: the graph its "Export (API)" would give, read
 * from a running ComfyUI in a headless Chrome of its own (temporary profile, no GPU), for comfyExport.test.ts
 * to compare with Afflatus's reading. Nothing is queued: every request but a read is answered in the browser
 * with an empty "done", so neither a prompt nor a setting reaches ComfyUI.
 *
 *   node packages/workflows/test/comfyExport.mjs [filter]
 *
 * COMFY_URL (default http://127.0.0.1:8188), CHROME (the browser's path) and COMFY_API_DIR (default comfy-api) can
 * be set. Writes corpus/<dir>/<file> and corpus/<dir>/_object_info.json (gitignored, as the corpus). A run picks up
 * where an earlier one stopped (REDO=1 exports everything again). A workflow the editor never finishes loading is
 * given up on after a minute, and the browser is started afresh.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMFY = (process.env.COMFY_URL ?? "http://127.0.0.1:8188").replace(/\/$/, "");
const CHROME = process.env.CHROME ?? [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
].find((p) => existsSync(p));
const PORT = 9333;
const corpus = join(import.meta.dirname, "corpus");
const out = join(corpus, process.env.COMFY_API_DIR ?? "comfy-api");
const filter = process.argv[2] ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const blocked = new Set();

if (!CHROME) throw new Error("No Chrome found: set CHROME to the browser's path.");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "_object_info.json"), await (await fetch(`${COMFY}/api/object_info`)).text());

/** A headless Chrome with ComfyUI's editor loaded in it: `evaluate` runs code in the page, `close` ends it all. */
async function openEditor() {
  const profile = mkdtempSync(join(tmpdir(), "afflatus-comfy-export-"));
  const browser = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--mute-audio",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore" });
  let ws;
  const close = async () => {
    try { ws?.close(); } catch { /* gone */ }
    browser.kill();
    await sleep(800);
    // Chrome may still hold its profile for a moment: left in the temp folder then, not an error
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* left behind */ }
  };
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200);
      target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === "page")).catch(() => undefined);
    }
    if (!target) throw new Error("Chrome did not open its debugging port.");

    // the DevTools protocol, by hand: one socket, calls answered by id
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
    let next = 0;
    const waiting = new Map();
    const pageErrors = [];
    const send = (method, params = {}) => new Promise((ok, fail) => {
      const id = ++next;
      waiting.set(id, { ok, fail });
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.onmessage = ({ data }) => {
      const m = JSON.parse(String(data));
      if (m.id && waiting.has(m.id)) {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        return m.error ? w.fail(new Error(m.error.message)) : w.ok(m.result);
      }
      if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params.exceptionDetails?.exception?.description?.split("\n")[0] ?? m.params.exceptionDetails?.text);
      if (m.method === "Fetch.requestPaused") {
        const { requestId, request } = m.params;
        // reads only: no prompt, no setting, no saved workflow reaches ComfyUI. A write is answered here with an empty
        // "done" (a newer editor waits for a setting it writes on starting, and stops when that fails)
        if (["GET", "HEAD", "OPTIONS"].includes(request.method)) void send("Fetch.continueRequest", { requestId });
        else {
          blocked.add(`${request.method} ${new URL(request.url).pathname}`);
          void send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from("{}").toString("base64") });
        }
      }
    };
    const evaluate = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };

    await send("Runtime.enable");
    await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    await send("Page.navigate", { url: COMFY });
    // ready when the app has its graph and the node types stop arriving (extensions register theirs late)
    let types = -1;
    for (let i = 0; i < Number(process.env.WAIT_TICKS ?? 600); i++) {
      await sleep(500);
      const now = await evaluate("(window.app ?? window.comfyAPI?.app?.app)?.graph && window.LiteGraph ? Object.keys(LiteGraph.registered_node_types).length : 0").catch(() => 0);
      if (now > 0 && now === types) break;
      types = now;
    }
    if (types <= 0) throw new Error(`ComfyUI's editor did not start at ${COMFY}. Page errors:\n${[...new Set(pageErrors)].slice(0, 25).join("\n")}`);
    return { evaluate, close, types };
  } catch (err) {
    await close();
    throw err;
  }
}

/** What the editor makes of one workflow, run in the page. */
const exportIn = (raw) => `(async () => {
  // newer editors keep the app under comfyAPI only
  const app = window.app ?? window.comfyAPI.app.app;
  const wf = JSON.parse(${JSON.stringify(JSON.stringify(raw))});
  const types = [...wf.nodes, ...(wf.definitions?.subgraphs ?? []).flatMap((s) => s.nodes ?? [])].map((n) => n.type);
  const subgraphs = new Set((wf.definitions?.subgraphs ?? []).map((s) => s.id));
  const missing = [...new Set(types.filter((t) => !subgraphs.has(t) && !LiteGraph.registered_node_types[t]))];
  try {
    await app.loadGraphData(wf, true, false, null, { showMissingNodesDialog: false, showMissingModelsDialog: false });
  } catch (err) {
    // the workflow store copies the file into a tab after the graph is set up, and fails on what an extension
    // hung on it: the graph is loaded all the same (checked by its node count)
    if (!/structuredClone/.test(String(err)) || app.graph.nodes.length !== wf.nodes.length) throw err;
  }
  const p = await app.graphToPrompt();
  // the editor may number the nodes inside a group node anew (an id taken elsewhere): new id → the file's, per group
  const renumbered = {};
  for (const def of wf.definitions?.subgraphs ?? []) {
    const loaded = app.graph.subgraphs?.get(def.id);
    const now = loaded?.nodes ?? loaded?._nodes ?? [];
    if (now.length !== (def.nodes ?? []).length) continue;
    const map = {};
    def.nodes.forEach((n, i) => { if (String(now[i].id) !== String(n.id) && now[i].type === n.type) map[now[i].id] = String(n.id); });
    if (Object.keys(map).length) renumbered[def.id] = map;
  }
  return { output: p.output, missing, renumbered };
})()`;

const files = readdirSync(corpus).filter((f) => f.endsWith(".json") && f !== "expect.json" && f.includes(filter)).sort();
let editor = await openEditor();
console.log(`ComfyUI editor ready: ${editor.types} node types`);
let done = 0;
try {
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(corpus, file), "utf8"));
    if (!Array.isArray(raw?.nodes)) continue; // already in the API format: nothing to compare
    if (!process.env.REDO && existsSync(join(out, file))) continue;
    let timer;
    const hang = new Promise((_, fail) => { timer = setTimeout(() => fail(new Error("the editor did not finish loading it within 60 s")), 60_000); });
    try {
      const result = await Promise.race([hang, editor.evaluate(exportIn(raw))]);
      writeFileSync(join(out, file), JSON.stringify(result));
      done++;
    } catch (err) {
      writeFileSync(join(out, file), JSON.stringify({ error: String(err.message ?? err).slice(0, 500) }));
      console.log(`${file}: ${String(err.message ?? err).split("\n")[0]}`);
      // a page left hanging answers nothing more, not even a reload: the browser is started afresh
      if (/within 60 s/.test(String(err.message))) {
        await editor.close();
        editor = await openEditor();
      }
    } finally {
      clearTimeout(timer);
    }
  }
} finally {
  await editor.close();
}
console.log(`exported ${done} of ${files.length}; requests answered in the browser: ${blocked.size ? [...blocked].join(", ") : "none"}`);
