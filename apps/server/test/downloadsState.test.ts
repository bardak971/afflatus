import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Downloads } from "../src/downloads";
import { until } from "./helpers";

/** The ids the state file holds now (it is written whole, through a file beside it, so it always reads). */
const idsIn = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as Array<{ id: string }>).map((d) => d.id).join(",");

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
    // written a moment later: the list without it
    await until(() => idsIn(file) === "b");
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
    await until(() => idsIn(file) === "");
    expect(readdirSync(dir)).toEqual(["downloads.json"]);
  });

  it("removes the .part of a download Afflatus was writing itself when it stopped", async () => {
    const file = join(dir, "downloads.json");
    const part = join(dir, "big.safetensors.part");
    writeFileSync(part, "half");
    writeFileSync(file, JSON.stringify([{ id: "h", file: "big.safetensors", folder: "loras", title: "Big", bytes: 4, total: 8, status: "downloading", via: "afflatus", part }]));
    const downloads = new Downloads(new EventEmitter(), file);
    await downloads.restored;
    expect(downloads.list()).toMatchObject([{ id: "h", status: "error", via: "afflatus" }]);
    // the path of the .part stays in the state file, never in what the browser is told
    expect(downloads.list()[0]).not.toHaveProperty("part");
    await until(() => readdirSync(dir).join() === "downloads.json");
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
