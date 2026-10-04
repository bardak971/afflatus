import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { makeApp, type TestApp } from "./helpers";

/** The built web app, served by the server: the page for its own routes, real 404s for files that are gone. */
describe("serving the web app", () => {
  let t: TestApp;
  let webDir: string;
  let app: ReturnType<typeof buildApp>;
  beforeEach(async () => {
    t = await makeApp();
    webDir = mkdtempSync(join(tmpdir(), "afflatus-web-"));
    mkdirSync(join(webDir, "assets"));
    writeFileSync(join(webDir, "index.html"), "<!doctype html><script type=\"module\" src=\"/assets/index-abc.js\"></script>");
    writeFileSync(join(webDir, "assets", "index-abc.js"), "console.log(1)");
    app = buildApp(t.services, { webDir });
  });
  afterEach(async () => {
    await app.close();
    await t.close();
    rmSync(webDir, { recursive: true, force: true });
  });

  it("hands the page to the app's own routes, asked for again each time", async () => {
    for (const url of ["/", "/timelines/abc", "/settings/models?x=1"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"], url).toMatch(/text\/html/);
      expect(res.headers["cache-control"], url).toBe("no-cache");
    }
  });

  it("keeps the bundle's hashed files for good, and answers a file that is gone with a 404, never the page", async () => {
    const js = await app.inject({ method: "GET", url: "/assets/index-abc.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    // a tab open from before a rebuild asks for the old bundle: a script answered with a page is refused by the browser with a message that says nothing
    const gone = await app.inject({ method: "GET", url: "/assets/index-old.js" });
    expect(gone.statusCode).toBe(404);
    expect(gone.headers["content-type"]).not.toMatch(/text\/html/);
    expect(gone.json().error).toMatch(/reload/);
    expect((await app.inject({ method: "GET", url: "/favicon.ico" })).statusCode).toBe(404);
    // a bundle rebuilt while the server runs: its new files are served without a restart
    writeFileSync(join(webDir, "assets", "index-new.js"), "console.log(2)");
    const fresh = await app.inject({ method: "GET", url: "/assets/index-new.js" });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.headers["content-type"]).toMatch(/javascript/);
    expect((await app.inject({ method: "GET", url: "/api/nothing" })).statusCode).toBe(404);
  });
});
