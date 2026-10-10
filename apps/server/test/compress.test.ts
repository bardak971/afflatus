import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { encodingFor, tagMatches } from "../src/compress";
import { makeApp, type TestApp } from "./helpers";

let t: TestApp;
let app: FastifyInstance;
let web: string;
const script = `console.log(${JSON.stringify("zz-test ".repeat(4000))});\n`;
beforeEach(async () => {
  t = await makeApp();
  web = mkdtempSync(join(tmpdir(), "afflatus-web-"));
  mkdirSync(join(web, "assets"));
  writeFileSync(join(web, "assets", "index-abc123.js"), script);
  writeFileSync(join(web, "assets", "pic.png"), Buffer.alloc(4000, 7));
  writeFileSync(join(web, "index.html"), `<!doctype html><title>zz-test</title>${"<p>zz-test</p>".repeat(200)}`);
  app = buildApp(t.services, { webDir: web });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  await t.close();
  rmSync(web, { recursive: true, force: true });
});

const ask = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers: { host: "127.0.0.1", ...headers } });

describe("compressed answers", () => {
  it("picks Brotli, else gzip, as the browser says it takes them", () => {
    expect(encodingFor("gzip, deflate, br, zstd")).toBe("br");
    expect(encodingFor("gzip")).toBe("gzip");
    expect(encodingFor("br;q=0, gzip;q=0.5")).toBe("gzip");
    expect(encodingFor("*")).toBe("br");
    expect(encodingFor("identity")).toBeNull();
    expect(encodingFor(undefined)).toBeNull();
  });

  it("sends JSON compressed to a browser that takes it, as it is to one that does not, and says it varies", async () => {
    const plain = await ask("/api/recipes");
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(String(plain.headers.vary)).toMatch(/Accept-Encoding/);
    const brotli = await ask("/api/recipes", { "accept-encoding": "gzip, br" });
    expect(brotli.headers["content-encoding"]).toBe("br");
    expect(Number(brotli.headers["content-length"])).toBe(brotli.rawPayload.length);
    expect(brotli.rawPayload.length).toBeLessThan(plain.rawPayload.length / 3);
    expect(brotliDecompressSync(brotli.rawPayload).toString()).toBe(plain.body);
    const gz = await ask("/api/recipes", { "accept-encoding": "gzip" });
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(gz.rawPayload).toString()).toBe(plain.body);
  });

  it("leaves a small answer, a picture and a part of a file as they are", async () => {
    expect((await ask("/api/health", { "accept-encoding": "br" })).headers["content-encoding"]).toBeUndefined();
    expect((await ask("/assets/pic.png", { "accept-encoding": "br" })).headers["content-encoding"]).toBeUndefined();
    const part = await ask("/assets/index-abc123.js", { "accept-encoding": "br", range: "bytes=0-99" });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-encoding"]).toBeUndefined();
    expect(part.body).toBe(script.slice(0, 100));
  });

  it("sends the web app's files compressed, a built one kept compressed for the next time", async () => {
    for (let i = 0; i < 2; i++) {
      const js = await ask("/assets/index-abc123.js", { "accept-encoding": "br" });
      expect(js.headers["content-encoding"]).toBe("br");
      expect(brotliDecompressSync(js.rawPayload).toString()).toBe(script);
    }
    const page = await ask("/", { "accept-encoding": "gzip" });
    expect(page.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(page.rawPayload).toString()).toMatch(/^<!doctype html>/);
  });
});

describe("tagged JSON answers", () => {
  it("carry a weak tag of their content, the same whatever the encoding, and ask the browser to check it each time", async () => {
    const plain = await ask("/api/recipes");
    const tag = String(plain.headers.etag);
    expect(tag).toMatch(/^W\/"[\w-]+"$/);
    expect(plain.headers["cache-control"]).toBe("private, no-cache");
    const brotli = await ask("/api/recipes", { "accept-encoding": "br" });
    expect(brotli.headers["content-encoding"]).toBe("br");
    expect(brotli.headers.etag).toBe(tag);
    expect(String(brotli.headers.vary)).toMatch(/Accept-Encoding/);
    // the same content asked again: the same tag
    expect((await ask("/api/recipes")).headers.etag).toBe(tag);
  });

  it("answer 304 with no body when the browser has the same, compressed or not, and the whole answer when it changed", async () => {
    const first = await ask("/api/recipes", { "accept-encoding": "br" });
    const tag = String(first.headers.etag);
    for (const encoding of ["br", "gzip", "identity"]) {
      const again = await ask("/api/recipes", { "accept-encoding": encoding, "if-none-match": tag });
      expect(again.statusCode).toBe(304);
      expect(again.rawPayload.length).toBe(0);
      expect(again.headers["content-encoding"]).toBeUndefined();
      expect(again.headers["content-length"]).toBeUndefined();
      expect(again.headers.etag).toBe(tag);
    }
    // a small answer too, and a tag sent strong
    const health = await ask("/api/health");
    expect((await ask("/api/health", { "if-none-match": String(health.headers.etag).slice(2) })).statusCode).toBe(304);
    // another content: the whole answer, with its own tag
    const other = await ask("/api/recipes", { "if-none-match": 'W/"something-else"' });
    expect(other.statusCode).toBe(200);
    expect(other.body).toBe((await ask("/api/recipes")).body);
  });

  it("leave errors, files and changes untagged", async () => {
    const missing = await ask("/api/assets/0123456789abcdef0123456789abcdef");
    expect(missing.statusCode).toBe(404);
    expect(missing.headers.etag).toBeUndefined();
    expect((await ask("/assets/index-abc123.js")).headers.etag).not.toMatch(/^W\/"[\w-]{22}"$/);
    const made = await app.inject({ method: "POST", url: "/api/projects", headers: { host: "127.0.0.1", "content-type": "application/json" }, payload: { name: "zz-test project" } });
    expect(made.statusCode).toBeLessThan(300);
    expect(made.headers.etag).toBeUndefined();
  });

  it("match a tag in a list, weak or not, or any with *", () => {
    expect(tagMatches('"a", W/"b"', 'W/"b"')).toBe(true);
    expect(tagMatches('W/"a"', 'W/"a"')).toBe(true);
    expect(tagMatches('"a"', 'W/"a"')).toBe(true);
    expect(tagMatches("*", 'W/"a"')).toBe(true);
    expect(tagMatches('W/"a"', 'W/"ab"')).toBe(false);
    expect(tagMatches(undefined, 'W/"a"')).toBe(false);
  });
});
