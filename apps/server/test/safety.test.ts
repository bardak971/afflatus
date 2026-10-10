import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeMediaFile } from "../src/cut";
import { refusal } from "../src/designer";
import { readSettings } from "../src/settings";
import { get, makeApp, png, post, type TestApp } from "./helpers";

/** A stand-in for another server on the network: it answers 200 to anything and keeps what it was asked. */
interface Listener {
  url: string;
  asked: Array<{ url: string; auth: string | undefined }>;
  close(): Promise<void>;
}
async function listen(answer: (url: string) => { type: string; body: Buffer | string } = () => ({ type: "application/json", body: JSON.stringify({ choices: [{ message: { content: "ready" }, finish_reason: "stop" }] }) })): Promise<Listener> {
  const asked: Listener["asked"] = [];
  const server: Server = createServer((req, res) => {
    asked.push({ url: req.url ?? "", auth: req.headers.authorization });
    req.resume();
    req.on("end", () => {
      const a = answer(req.url ?? "");
      res.writeHead(200, { "Content-Type": a.type });
      res.end(a.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(() => t.close());

const putSettings = (payload: unknown) => t.app.inject({ method: "PUT", url: "/api/settings", payload: payload as object });

describe("a stored LLM key", () => {
  it("is dropped when the model is pointed at another server without the key sent again", async () => {
    const other = await listen();
    try {
      await putSettings({ llm: { baseUrl: "http://127.0.0.1:1/v1", model: "m", apiKey: "zz-secret-123" } });
      // the same server at another path keeps it
      expect((await putSettings({ llm: { baseUrl: "http://127.0.0.1:1/api/v1" } })).json().llm.hasApiKey).toBe(true);
      // another server (here another port) does not
      expect((await putSettings({ llm: { baseUrl: `${other.url}/v1` } })).json().llm.hasApiKey).toBe(false);
      await post(t.app, "/api/designer/test");
      expect(other.asked.length).toBeGreaterThan(0);
      expect(other.asked.every((a) => a.auth === undefined)).toBe(true);
      expect((await readSettings(t.db)).llms[0]!.apiKey).toBe("");
      // sent again with the new address, it is kept and used there
      await putSettings({ llm: { baseUrl: `${other.url}/v1`, apiKey: "zz-secret-456" } });
      await post(t.app, "/api/designer/test");
      expect(other.asked.at(-1)!.auth).toBe("Bearer zz-secret-456");
    } finally {
      await other.close();
    }
  });

  it("is dropped the same way in the list of models, one model at a time", async () => {
    await putSettings({ llms: [{ id: "a", baseUrl: "http://127.0.0.1:1/v1", model: "m", apiKey: "zz-a" }, { id: "b", baseUrl: "https://llm.example/v1", model: "m", apiKey: "zz-b" }] });
    const sent = (await putSettings({ llms: [{ id: "a", baseUrl: "http://127.0.0.1:1/v1/", model: "m2" }, { id: "b", baseUrl: "https://elsewhere.example/v1", model: "m" }] })).json();
    expect(sent.llms.map((l: { id: string; hasApiKey: boolean }) => [l.id, l.hasApiKey])).toEqual([["a", true], ["b", false]]);
    expect((await readSettings(t.db)).llms.map((l) => l.apiKey)).toEqual(["zz-a", ""]);
  });
});

describe("every answer", () => {
  it("forbids framing and sniffing, and keeps the address from other sites", async () => {
    for (const res of [await get(t.app, "/api/health"), await get(t.app, "/api/nothing-here"), await post(t.app, "/api/health/check"), await get(t.app, "/api/settings", { host: "evil.example" })]) {
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["referrer-policy"]).toBe("same-origin");
    }
  });
});

describe("a read from another site's page", () => {
  const read = (url: string, headers: Record<string, string>, method: "GET" | "HEAD" = "GET") => t.app.inject({ method, url, headers });

  it("is refused: it cannot see the answer, but the server would still do the work (a backup, again and again)", async () => {
    const res = await read("/api/backup.zip", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "empty" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("another site");
    expect((await read("/api/backup.zip", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "empty" }, "HEAD")).statusCode).toBe(403);
    expect((await read("/api/settings", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" })).statusCode).toBe(403);
    // a picture element pointed at something that is not an asset's file
    expect((await read("/api/backup.zip", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" })).statusCode).toBe(403);
    // a frame is a navigation, but not a top-level one
    expect((await read("/api/backup.zip", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" })).statusCode).toBe(403);
  });

  it("passes for a link followed, an asset's picture, video or sound shown elsewhere, the app's own requests, and a client that is no browser", async () => {
    expect((await read("/api/health", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" })).statusCode).toBe(200);
    for (const dest of ["image", "video", "audio"]) {
      // no such asset: the route says so, the guard lets it through
      expect((await read("/api/assets/zz-test-none/file", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": dest })).statusCode).toBe(404);
    }
    expect((await read("/api/assets/zz-test-none/thumb", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" })).statusCode).toBe(404);
    expect((await read("/api/health", { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" })).statusCode).toBe(200);
    expect((await read("/api/health", { "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" })).statusCode).toBe(200);
    // ComfyUI-Manager fetching a download, curl, a probe: no Sec-Fetch headers at all
    expect((await read("/api/downloads/fetch/zz-test-none?t=x", {})).statusCode).toBe(404);
  });
});

describe("/api/health asked by a name that is not the server's own", () => {
  it("says only that the server is alive, and which release", async () => {
    expect(Object.keys((await get(t.app, "/api/health")).json())).toEqual(expect.arrayContaining(["ok", "version", "database", "checks"]));
    const foreign = await get(t.app, "/api/health", { host: "rebound.example:8720" });
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json()).toEqual({ ok: true, version: expect.any(String) });
  });
});

describe("a parameter given twice in the address", () => {
  it("is a readable 400, not a server error", async () => {
    const upload = await t.app.inject({ method: "POST", url: "/api/assets?folder=a&folder=b", headers: { "content-type": "image/png" }, payload: Buffer.from(png(8, 8)) });
    expect(upload.statusCode).toBe(400);
    expect(upload.json().error).toMatch(/^folder: /);
    const unkept = await get(t.app, "/api/assets/unkept?ids=1&ids=1");
    expect(unkept.statusCode).toBe(400);
    expect(unkept.json().error).toMatch(/^ids: /);
    const fetched = await get(t.app, "/api/downloads/fetch/zz-test-none?t=a&t=b");
    expect(fetched.statusCode).toBe(400);
    expect(fetched.json().error).toMatch(/^t: /);
  });
});

describe("ffmpeg and ffprobe on a stranger's file", () => {
  it("read local files only, never an address on the network", async () => {
    // a WAV of a tenth of a second of silence, served over http: ffprobe would read it there
    const pcm = Buffer.alloc(4410 * 2);
    const head = Buffer.alloc(44);
    head.write("RIFF", 0); head.writeUInt32LE(36 + pcm.length, 4); head.write("WAVEfmt ", 8); head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(44100, 24); head.writeUInt32LE(88200, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
    head.write("data", 36); head.writeUInt32LE(pcm.length, 40);
    const site = await listen(() => ({ type: "audio/wav", body: Buffer.concat([head, pcm]) }));
    try {
      expect(await probeMediaFile(`${site.url}/zz-test.wav`)).toBeNull();
      expect(site.asked).toEqual([]);
    } finally {
      await site.close();
    }
  });
});

describe("a language model's refusal", () => {
  it("passes on the error's message, or a short first line without markup, never a whole page", () => {
    expect(refusal(JSON.stringify({ error: { message: "model not found" } }))).toBe("model not found");
    expect(refusal(JSON.stringify({ detail: "Not authenticated" }))).toBe("Not authenticated");
    const page = `<html><head><title>Router admin</title></head><body>${"internal ".repeat(60)}</body></html>\nsecond line: admin=zz-test`;
    const said = refusal(page);
    expect(said.length).toBeLessThanOrEqual(80);
    expect(said).not.toContain("<");
    expect(said).not.toContain("zz-test");
  });
});
