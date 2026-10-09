import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import type { NodeCatalog } from "@afflatus/core";
import { buildApp } from "../src/app";
import { migrate, openSqlite, type Db } from "../src/db";
import type { QueueOptions } from "../src/queue";
import { createServices, type Services } from "../src/services";
import { writeSettings } from "../src/settings";
import { LocalStorage } from "../src/storage";

/** An address nothing listens on. Tests never talk to a real ComfyUI: every app starts pointed here. */
export const NOWHERE = "http://127.0.0.1:9";

export const FAST: QueueOptions = {
  offlineRetryMs: 20, offlineExpiryMs: 150, maxAttempts: 3,
  wait: { timeoutMs: 5000, pollMs: 2, offlineMs: 100, queueCheckEvery: 1 },
  // every new step count saved on its job at once
  stepsSaveMs: 0,
};

export const CHECKPOINT = "illustrious.safetensors";

/** The saved node catalog, with one checkpoint on disk so that file checks have something to check against. */
export function referenceCatalog(): NodeCatalog {
  const catalog = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../reference/comfy-object-info.json", import.meta.url)), "utf-8"),
  ) as NodeCatalog;
  catalog.CheckpointLoaderSimple!.input.required!.ckpt_name = [[CHECKPOINT, "other.safetensors"]];
  return catalog;
}

export interface TestApp {
  app: FastifyInstance;
  services: Services;
  db: Db;
  dir: string;
  close(): Promise<void>;
}

export async function makeApp(opts: { db?: Db; dir?: string; comfyUrl?: string } = {}): Promise<TestApp> {
  const db = opts.db ?? openSqlite(":memory:");
  await migrate(db);
  await writeSettings(db, { comfyUrl: opts.comfyUrl ?? NOWHERE });
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "afflatus-test-"));
  const services = await createServices(db, "sqlite", new LocalStorage(dir), FAST);
  const app = buildApp(services, { backup: { dataDir: dir, filesDir: dir } });
  // every request carries the web app's own header (app.ts refuses a change without it, JSON or a file); a test that wants it gone sets it to undefined
  const inject = app.inject.bind(app) as (o: unknown) => unknown;
  (app as { inject: unknown }).inject = (o?: unknown) => {
    if (typeof o !== "object" || o === null) return inject(o);
    const given = o as { headers?: Record<string, string | undefined> };
    const headers = Object.fromEntries(Object.entries({ "x-afflatus": "1", ...given.headers }).filter(([, v]) => v !== undefined));
    return inject({ ...given, headers });
  };
  return {
    app, services, db, dir,
    async close() {
      await app.close();
      await services.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function makeFake(): Promise<FakeComfy> {
  return startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT, "other.safetensors"], upscale_models: [] } });
}

/** Wait until something that happens on a later tick is true. */
export async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A PNG header of the given size: enough for the server to read its dimensions. */
export function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(b.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return b;
}

/** Make the fake ComfyUI finish a prompt with one picture. */
export function complete(fake: FakeComfy, promptId: string, width = 832, height = 1216): void {
  const graph = fake.prompts.get(promptId)!;
  const out = Object.entries(graph).find(([, n]) => n.class_type === "PreviewImage")![0];
  const filename = `${promptId}.png`;
  fake.files[filename] = png(width, height);
  fake.pending = fake.pending.filter((p) => p !== promptId);
  fake.history[promptId] = { status: { completed: true }, outputs: { [out]: { images: [{ filename, subfolder: "", type: "temp" }] } } };
}

export const post = (app: FastifyInstance, url: string, payload?: unknown) => app.inject({ method: "POST", url, payload: payload as object });
export const get = (app: FastifyInstance, url: string, headers?: Record<string, string>) => app.inject({ method: "GET", url, headers });
export const job = (over: Record<string, unknown> = {}) => ({ recipe: "sdxl.text-to-picture", input: { prompt: "a cat", checkpoint: CHECKPOINT, ...over } });
