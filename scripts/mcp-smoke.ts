/**
 * One whole job through /mcp, as an agent would do it, against a running Afflatus: run by hand against the demo (`pnpm demo`,
 * a pretend ComfyUI), never against the live app, since it renders. Not in vitest: the server's tests cover each tool, this
 * covers them one after the other, over HTTP, through the SDK's own client.
 *   whats_open, describe_form, new_draft, edit_draft, render, job, view_item, edit_draft and render again, compare, keep,
 *   new_timeline with both takes and a clip to render, edit_clip, render_clips, view_timeline, export, then the export seen.
 *
 *   tsx scripts/mcp-smoke.ts [http://127.0.0.1:8720]
 * The token is AFFLATUS_MCP_TOKEN (Make at least); without one, a Make token named "zz-test smoke" is made through the app's
 * API (an app with no password: the demo) and revoked at the end. What it makes is named "zz-test smoke", left in the demo.
 */
import { mcpClient, type CallToolResult } from "../apps/server/test/mcpClient";

const base = (process.argv[2] ?? "http://127.0.0.1:8720").replace(/\/+$/, "");
const NAME = "zz-test smoke";

async function api<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

let made: { id: string } | null = null;
let token = process.env.AFFLATUS_MCP_TOKEN;
if (!token) {
  const t = await api<{ token: string; view: { id: string } }>("/api/mcp/tokens", { name: NAME, start: "make" });
  token = t.token;
  made = { id: t.view.id };
}

const client = await mcpClient(`${base}/mcp`, token, "Afflatus smoke");
const t0 = Date.now();
let steps = 0;

/** One call: its JSON answer (or the kinds of its parts when it is pictures), failing the run on a refusal. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = r.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  if (r.isError) throw new Error(`${name} refused: ${text}`);
  steps++;
  const pictures = r.content.filter((p) => p.type === "image").length;
  try {
    const value = JSON.parse(text);
    return pictures ? { value, pictures } : value;
  } catch {
    return { text, pictures };
  }
}

const say = (step: string, what: string) => console.log(`✓ ${step.padEnd(14)} ${what}`);

/** A job followed until it ends (job's own wait, asked again while it goes on): its items when done, an error otherwise. */
async function done(job: string, within = 180_000): Promise<Array<{ item: string; kind: string; durationMs?: number }>> {
  const until = Date.now() + within;
  for (;;) {
    const j = await call("job", { job, wait: 30 });
    if (j.status === "done") return j.made;
    if (j.status === "failed" || j.status === "cancelled") throw new Error(`job ${job} ${j.status}: ${j.error ?? ""}`);
    if (Date.now() > until) throw new Error(`job ${job} still ${j.status} after ${within / 1000} s`);
  }
}

try {
  const open = await call("whats_open");
  say("whats_open", open.open ? `${open.page ?? "a page"} is open` : "no page has said where it is");

  const form = await call("describe_form", { form: "h3.video" });
  say("describe_form", `${form.title}: ${form.inputs.length} inputs, ${form.machines.length} machine(s), guide ${form.prompt ? "given" : "none"}`);

  const draft = await call("new_draft", { form: "h3.video", name: NAME, values: { description: "A cat sits on a windowsill at dusk, watching the street lights come on.", seconds: 6 } });
  say("new_draft", `${draft.id} on ${draft.form}, ${draft.whole.seconds} s`);

  await call("edit_draft", { draft: draft.id, set: { soundscape: "A quiet street, a distant car, the cat purring." } });
  say("edit_draft", "sound effects written");

  const first = await call("render", { draft: draft.id });
  const [a] = await done(first.jobs[0]);
  say("render", `take 1 is ${a!.item} (${a!.kind}, ${a!.durationMs} ms)`);

  const seen = await call("view_item", { item: a!.item });
  if (!seen.pictures) throw new Error("view_item gave no frames of the take");
  say("view_item", `${seen.pictures} frames`);

  await call("edit_draft", { draft: draft.id, set: { description: "A ginger cat sits on a windowsill at dusk, its tail swaying, watching the street lights come on one by one.", shot: "Close-up" } });
  const second = await call("render", { draft: draft.id });
  const [b] = await done(second.jobs[0]);
  say("edit + render", `take 2 is ${b!.item}`);

  const both = await call("compare", { items: [a!.item, b!.item] });
  if (!both.pictures) throw new Error("compare gave no picture");
  say("compare", `side by side, ${Object.keys(both.value?.differs ?? {}).join(", ") || "nothing"} differs`);

  await call("keep", { items: [a!.item, b!.item] });
  say("keep", "both takes kept");

  const tl = await call("new_timeline", { name: NAME });
  const added = await call("edit_timeline", { timeline: tl.id, actions: [{ do: "add", item: a!.item }, { do: "add", item: b!.item }, { do: "add", form: "h3.video" }] });
  say("new_timeline", `${tl.id}: ${added.done.join("; ")}`);

  await call("edit_clip", { timeline: tl.id, clip: 3, set: { description: "The cat jumps down from the windowsill and walks out of the frame.", seconds: 4 } });
  say("edit_clip", "clip 3 written");

  const clips = await call("render_clips", { timeline: tl.id });
  for (const job of clips.jobs) await done(job);
  say("render_clips", `${clips.jobs.length} clip(s) rendered`);

  const sheet = await call("view_timeline", { timeline: tl.id });
  if (!sheet.pictures) throw new Error("view_timeline gave no contact sheet");
  say("view_timeline", "contact sheet");

  const exp = await call("export", { timeline: tl.id });
  const [video] = await done(exp.job, 300_000);
  const read = await call("read_timeline", { timeline: tl.id });
  if (read.export?.item !== video!.item) throw new Error(`read_timeline does not give the export: ${JSON.stringify(read.export)}`);
  say("export", `${video!.item}, ${video!.durationMs} ms`);

  console.log(`\nThe whole job went through: ${steps} calls in ${Math.round((Date.now() - t0) / 1000)} s.`);
} catch (err) {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await client.close();
  if (made) await api(`/api/mcp/tokens/${made.id}/revoke`, {}).catch((e) => console.warn(`The smoke token was not revoked: ${(e as Error).message}`));
}
