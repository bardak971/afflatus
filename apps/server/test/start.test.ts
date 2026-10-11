import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import type { Config } from "../src/config";
import { migrate, openSqlite } from "../src/db";
import { writeSettings } from "../src/settings";
import { PortTakenError, start, type Started } from "../src/start";
import { FAST, makeFake } from "./helpers";

const quiet = { log: () => {}, warn: () => {} };

/** A port nothing listens on now: taken by the system for a moment, then let go. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

/** A data folder whose database points at the fake ComfyUI: the start never asks a real one on this computer. */
async function dataFolder(comfyUrl: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "afflatus-start-"));
  const db = openSqlite(join(dir, "afflatus.db"));
  await migrate(db);
  await writeSettings(db, { comfyUrl });
  await db.destroy();
  return dir;
}

describe("the server's start (start.ts, run by index.ts)", () => {
  let fake: FakeComfy;
  let dirs: string[];
  let running: Started[];
  let config: Config;

  beforeEach(async () => {
    fake = await makeFake();
    const dataDir = await dataFolder(fake.url);
    dirs = [dataDir];
    running = [];
    config = { host: "127.0.0.1", port: await freePort(), dataDir, databaseUrl: "" };
  });

  afterEach(async () => {
    for (const r of running) await r.close().catch(() => {});
    await fake.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const run = async (c: Config = config) => {
    const started = await start(c, { queueOptions: FAST, log: quiet });
    running.push(started);
    return started;
  };

  it("answers the health check and the queue once it has started", async () => {
    await run();
    const health = await fetch(`http://127.0.0.1:${config.port}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ version: expect.any(String) });
    const queue = await fetch(`http://127.0.0.1:${config.port}/api/queue`);
    expect(queue.status).toBe(200);
    expect(await queue.json()).toMatchObject({ waiting: [] });
  });

  it("listens within seconds while connections keep coming in during the start", async () => {
    // a browser tab reconnecting while the port is only held: connections made all along the start and left open by
    // the client. The held port must drop them, or letting it go waits for them to end and the start never listens
    const sockets: Socket[] = [];
    let dropped = 0;
    let knocking = true;
    const knock = async () => {
      while (knocking) {
        const s = connect({ host: "127.0.0.1", port: config.port });
        s.on("error", () => {});
        s.once("connect", () => s.once("close", () => dropped++));
        sockets.push(s);
        await new Promise((r) => setTimeout(r, 2));
      }
    };
    const knocked = knock();
    try {
      const started = await Promise.race([
        run(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the start did not listen within 8 s")), 8_000)),
      ]);
      expect(started.app.server.listening).toBe(true);
    } finally {
      knocking = false;
      await knocked;
      for (const s of sockets) s.destroy();
    }
    // the test did what it says: connections were taken and dropped while the port was held
    expect(dropped).toBeGreaterThan(0);
    const health = await fetch(`http://127.0.0.1:${config.port}/api/health`);
    expect(health.status).toBe(200);
  });

  it("stops at once when the port is taken, before it touches the data folder", async () => {
    const first = await run();
    // a second Afflatus on the same port, on a data folder where a download was cut short: its .part is left alone
    const second = mkdtempSync(join(tmpdir(), "afflatus-start-"));
    dirs.push(second);
    mkdirSync(join(second, "models"));
    const part = join(second, "models", "zz-test.safetensors.part");
    writeFileSync(part, "partial");
    writeFileSync(join(second, "downloads.json"), JSON.stringify([{ id: "zz-test", status: "downloading", part }]));
    await expect(start({ ...config, dataDir: second }, { log: quiet })).rejects.toBeInstanceOf(PortTakenError);
    expect(readdirSync(second).sort()).toEqual(["downloads.json", "models"]);
    expect(existsSync(part)).toBe(true);
    // and on the first one's own data folder: the same stop, said the same way
    await expect(start(config, { log: quiet })).rejects.toThrow(/already in use/);
    // the first one goes on answering
    expect(first.app.server.listening).toBe(true);
    expect((await fetch(`http://127.0.0.1:${config.port}/api/health`)).status).toBe(200);
  });

  it("lets the port go when it is closed", async () => {
    const started = await run();
    await started.close();
    running = [];
    const again = await run();
    expect(again.app.server.listening).toBe(true);
  });
});
