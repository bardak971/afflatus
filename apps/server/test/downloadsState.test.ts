import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Downloads } from "../src/downloads";

/** The downloads' state file between two runs: what was under way when Afflatus stopped is said to have been interrupted. */
describe("the downloads' state file", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "afflatus-downloads-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists an interrupted download as failed at the next start, keeps a finished one, drops an old one, and dismisses on stop", async () => {
    const file = join(dir, "downloads.json");
    const now = Date.now();
    writeFileSync(file, JSON.stringify([
      { id: "a", file: "big.safetensors", folder: "checkpoints", title: "Big", bytes: 1000, total: 5000, status: "downloading" },
      { id: "b", file: "done.safetensors", folder: "vae", title: "Done", bytes: 10, total: 10, status: "done", finishedAt: now - 60_000 },
      { id: "c", file: "old.safetensors", folder: "vae", title: "Old", bytes: 10, total: 10, status: "done", finishedAt: now - 3 * 60 * 60_000 },
    ]));
    const events = new EventEmitter();
    let told = 0;
    events.on("downloads", () => told++);
    const downloads = new Downloads(events, file);
    await downloads.restored;
    const list = downloads.list();
    expect(list.map((d) => [d.id, d.status])).toEqual([["b", "done"], ["a", "error"]]);
    expect(list.find((d) => d.id === "a")!.error).toMatch(/Interrupted: Afflatus was stopped or restarted/);
    // an interruption is news: told once read
    expect(told).toBe(1);
    // dismissed, and the file follows
    expect(downloads.stop("a")).toBe(true);
    expect(downloads.list().map((d) => d.id)).toEqual(["b"]);
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(readFileSync(file, "utf8")).map((d: { id: string }) => d.id)).toEqual(["b"]);
    expect(downloads.stop("nothing")).toBe(false);
  });

  it("lists one ComfyUI-Manager was saving as done, and writes the file whole, through a file beside it", async () => {
    const file = join(dir, "downloads.json");
    writeFileSync(file, JSON.stringify([{ id: "s", file: "sent.safetensors", folder: "loras", title: "Sent", bytes: 10, total: 10, status: "saving" }]));
    const downloads = new Downloads(new EventEmitter(), file);
    await downloads.restored;
    expect(downloads.list()).toMatchObject([{ id: "s", status: "done" }]);
    expect(downloads.list()[0]!.error).toBeUndefined();
    expect(downloads.stop("s")).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
    expect(readdirSync(dir)).toEqual(["downloads.json"]);
  });

  it("is nothing without a state file, and does not mind one it cannot read", async () => {
    const bare = new Downloads(new EventEmitter());
    await bare.restored;
    expect(bare.list()).toEqual([]);
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{not json");
    const d = new Downloads(new EventEmitter(), broken);
    await d.restored;
    expect(d.list()).toEqual([]);
  });
});
