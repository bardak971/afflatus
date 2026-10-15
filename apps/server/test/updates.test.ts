import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { migrate, openSqlite } from "../src/db";
import { createServices, type Services } from "../src/services";
import { writeSettings } from "../src/settings";
import { check, NewerLibraryError, start } from "../src/start";
import { LocalStorage } from "../src/storage";
import { AfflatusUpdates, compareVersions, librarySummary, nodeIn, readRelease, readSums, systemTar, verifySignature, versionName, type InstallKind, type UpdatesView } from "../src/updates";
import { FAST, job, makeApp, makeFake, NOWHERE, post, until } from "./helpers";

/**
 * Afflatus updating itself (updates.ts), against a pretend release server (a stand-in for GitHub's latest release and
 * its downloads, at UPDATES_URL) and a key made for the test: the check, the update of a bundle from download to
 * restart, what refuses it, Go back, the 0.3 move, and the loopback-only actions.
 */

/**
 * The file copies of node:fs/promises, watched: for each, whether the library's database (afflatus.db beside where the
 * copy goes) was in place while it was made. The files written in place are kept too: a note the page or the next start
 * reads (data/updates/*.json) must be renamed in whole, never seen empty halfway through its write. Everything else is the
 * real file system.
 */
const copies = vi.hoisted(() => [] as Array<{ to: string; dbThere: boolean }>);
const inPlace = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  const { existsSync: there } = await import("node:fs");
  const { dirname: dir, join: under } = await import("node:path");
  const copyFile = (async (from: string, to: string, mode?: number) => {
    copies.push({ to: String(to), dbThere: there(under(dir(String(to)), "afflatus.db")) });
    return real.copyFile(from, to, mode);
  }) as typeof real.copyFile;
  const writeFile = ((file: Parameters<typeof real.writeFile>[0], ...rest: [never, never]) => {
    inPlace.push(String(file));
    return real.writeFile(file, ...rest);
  }) as typeof real.writeFile;
  return { ...real, default: { ...real, copyFile, writeFile }, copyFile, writeFile };
});

/** The notes under data/updates written in place rather than renamed in whole. */
const notesInPlace = (data: string) => inPlace.filter((f) => dirname(f) === join(data, "updates"));

// ---------------------------------------------------------------- a key, a bundle, a release server

const keyPair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  return { publicKey: Buffer.from(x, "base64url").toString("base64"), privateKey };
};
const KEY = keyPair();
const OTHER = keyPair();
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A release archive as the release build lays it out (Afflatus/versions/<v>/… and versions/current), packed by the system tar. */
function bundle(version: string, opts: { checkCode?: number; zip?: boolean; pad?: number; nodeBin?: boolean } = {}): Buffer {
  const stage = mkdtempSync(join(tmpdir(), "afflatus-zz-test-bundle-"));
  try {
    const app = join(stage, "Afflatus", "versions", version, "app", "apps", "server", "dist");
    mkdirSync(app, { recursive: true });
    // the new version's server: it answers --check (the smoke check) and nothing else
    writeFileSync(join(app, "index.mjs"), `process.exit(process.argv.includes("--check") ? ${opts.checkCode ?? 0} : 3);\n`);
    writeFileSync(join(stage, "Afflatus", "versions", "current"), version);
    writeFileSync(join(stage, "Afflatus", "afflatus.sh"), "#!/bin/sh\n");
    // bytes that do not compress, for an archive large enough to be cut half way
    if (opts.pad) writeFileSync(join(stage, "Afflatus", "versions", version, "pad.bin"), randomBytes(opts.pad));
    // the node of a Linux or macOS bundle, where nodejs.org's archives put it (it is not run here: it is not a program)
    if (opts.nodeBin) {
      mkdirSync(join(stage, "Afflatus", "versions", version, "node", "bin"), { recursive: true });
      writeFileSync(join(stage, "Afflatus", "versions", version, "node", "bin", "node"), "");
    }
    const out = opts.zip ? "bundle.zip" : "bundle.tar.gz";
    execFileSync(systemTar(), opts.zip ? ["-a", "-cf", out, "Afflatus"] : ["-czf", out, "Afflatus"], { cwd: stage, windowsHide: true });
    return readFileSync(join(stage, out));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

interface Pretend {
  url: string;
  /** The requests it had, "GET /latest", "GET /files/x (range bytes=10-)". */
  asked: string[];
  release: Record<string, unknown>;
  files: Map<string, Buffer>;
  /** The archive's first answer is cut after this many bytes. */
  cutAt?: number;
  close(): Promise<void>;
}

async function pretendGitHub(): Promise<Pretend> {
  const p = { asked: [] as string[], files: new Map<string, Buffer>(), release: {} as Record<string, unknown> } as Pretend;
  let cut = false;
  const server: Server = createServer((req, res) => {
    const range = req.headers.range;
    p.asked.push(`${req.method} ${req.url}${range ? ` (range ${range})` : ""}${req.headers["if-none-match"] ? ` (if-none-match ${req.headers["if-none-match"]})` : ""}`);
    if (req.url === "/latest") {
      const etag = `"${sha(Buffer.from(JSON.stringify(p.release))).slice(0, 12)}"`;
      if (req.headers["if-none-match"] === etag) return void res.writeHead(304, { ETag: etag }).end();
      return void res.writeHead(200, { "Content-Type": "application/json", ETag: etag }).end(JSON.stringify(p.release));
    }
    const name = decodeURIComponent((req.url ?? "").replace(/^\/files\//, ""));
    const body = p.files.get(name);
    if (!body) return void res.writeHead(404).end();
    const from = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    const head = { "Content-Type": "application/octet-stream", "Content-Length": String(body.length - from), ...(range ? { "Content-Range": `bytes ${from}-${body.length - 1}/${body.length}` } : {}) };
    res.writeHead(range ? 206 : 200, head);
    if (p.cutAt && !cut && /\.(zip|tar\.gz)$/.test(name)) {
      // the connection cut half way: the rest never comes
      cut = true;
      res.write(body.subarray(0, p.cutAt), () => setTimeout(() => res.destroy(), 50));
      return;
    }
    res.end(body.subarray(from));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  p.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  p.close = () => new Promise<void>((r) => server.close(() => r()));
  return p;
}

/** A release of `version` on the pretend server: its archive, SHA256SUMS.txt and the signature, as the release job writes them. */
function publish(p: Pretend, version: string, opts: { archive?: Buffer; signWith?: KeyObject; sums?: string; notes?: string; prerelease?: boolean; platform?: string; zip?: boolean } = {}) {
  const archive = opts.archive ?? bundle(version, { zip: opts.zip });
  const name = `afflatus-v${version}-${opts.platform ?? "linux-x64"}.${opts.zip ? "zip" : "tar.gz"}`;
  const sums = Buffer.from(opts.sums ?? `${sha(archive)}  ${name}\n${sha(Buffer.from("other"))}  afflatus-v${version}-win-x64.zip\n`);
  const sig = sign(null, sums, opts.signWith ?? KEY.privateKey).toString("base64");
  p.files = new Map([[name, archive], ["SHA256SUMS.txt", sums], ["SHA256SUMS.txt.sig", Buffer.from(sig)]]);
  p.release = {
    tag_name: `v${version}`, name: `Afflatus ${version}`, html_url: `https://github.com/bardak971/afflatus/releases/tag/v${version}`,
    published_at: "2026-10-11T10:00:00Z", prerelease: opts.prerelease ?? false, draft: false,
    body: opts.notes ?? "## What changed\n\n- Faster joins\n- A clearer queue\n",
    assets: [...p.files].map(([n, b]) => ({ name: n, browser_download_url: `${p.url}/files/${encodeURIComponent(n)}`, size: b.length })),
  };
  return { name, archive };
}

// ---------------------------------------------------------------- a bundle's folder, running one version

interface Rig {
  base: string;
  root: string;
  versions: string;
  data: string;
  app: FastifyInstance;
  services: Services;
  updates: AfflatusUpdates;
  /** How many restarts were asked (each would exit with 75). */
  restarts: number;
  view(remoteAddress?: string): Promise<UpdatesView>;
  post(path: string, remoteAddress?: string, headers?: Record<string, string>): Promise<{ statusCode: number; json(): unknown }>;
  close(): Promise<void>;
}

const rigs: Rig[] = [];

async function rig(o: { running?: string; version?: string; install?: InstallKind; free?: (dir: string) => Promise<number>; extracted?: boolean; ownNode?: boolean; before?: (r: { base: string; root: string; versions: string; data: string }) => void } = {}): Promise<Rig> {
  const running = o.running ?? "0.4.1";
  const base = mkdtempSync(join(tmpdir(), "afflatus-zz-test-updates-"));
  // `extracted`: unpacked by Windows' Extract All, into a folder named after the archive first
  const root = o.extracted ? join(base, "afflatus-v0.4.0-win-x64", "Afflatus") : join(base, "Afflatus");
  const versions = join(root, "versions");
  const data = join(root, "data");
  mkdirSync(join(versions, running), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(versions, "current"), running);
  o.before?.({ base, root, versions, data });
  const db = openSqlite(join(data, "afflatus.db"));
  await migrate(db);
  await writeSettings(db, { comfyUrl: NOWHERE });
  const services = await createServices(db, "sqlite", new LocalStorage(join(data, "files")), FAST, { precompute: false, shippedPresets: null, dataDir: data });
  await services.started;
  let closed = false;
  const r = { base, root, versions, data, services, restarts: 0 } as Rig;
  r.updates = new AfflatusUpdates({
    services, dataDir: data, key: KEY.publicKey, version: o.version ?? running, install: o.install ?? "bundle", root,
    startedFile: join(versions, running, ".started-1"), platform: "linux-x64", nodeOf: o.ownNode ? undefined : () => process.execPath,
    waitPollMs: 20, backoffMs: 10, timers: false, free: o.free,
    // what start.ts does, but the process stays: everything closed, then the files swapped
    restart: async (between) => {
      r.restarts++;
      await r.app.close();
      await services.close();
      closed = true;
      await between?.();
    },
  });
  await r.updates.init();
  r.app = buildApp(services, { updates: r.updates });
  r.view = async (remoteAddress = "127.0.0.1") => (await r.app.inject({ method: "GET", url: "/api/updates", remoteAddress })).json() as UpdatesView;
  r.post = async (path, remoteAddress = "127.0.0.1", headers = {}) => r.app.inject({ method: "POST", url: `/api/updates/${path}`, remoteAddress, headers: { "x-afflatus": "1", ...headers } });
  r.close = async () => {
    await r.updates.stop();
    if (!closed) {
      await r.app.close();
      await services.close();
    }
    rmSync(base, { recursive: true, force: true });
  };
  rigs.push(r);
  return r;
}

let gh: Pretend;
beforeEach(async () => {
  gh = await pretendGitHub();
  process.env.UPDATES_URL = `${gh.url}/latest`;
});
afterEach(async () => {
  delete process.env.UPDATES_URL;
  for (const r of rigs.splice(0)) await r.close().catch(() => {});
  await gh.close();
});

/** A job of the queue's, as the database has it: the queue of a rig is not started, so nothing runs it. */
const addJob = (s: Services, id: string, status: "queued" | "running") => sql`
  INSERT INTO jobs (id, owner_id, recipe_id, label, inputs, status, warm, priority, attempts, clip_fit, created_at, updated_at)
  VALUES (${id}, 'local', 'sdxl.text-to-picture', 'zz-test render', '{}', ${status}, 0, 0, 0, 0, ${new Date().toISOString()}, ${new Date().toISOString()})`.execute(s.db);

const settled = async (r: Rig) => {
  await until(async () => {
    const f = (await r.view()).flow;
    return r.restarts > 0 || f?.phase === "failed" || f?.phase === "waiting";
  }, 20_000);
};

// ---------------------------------------------------------------- versions and the release

describe("versions and releases", () => {
  it("orders versions as semver does, a prerelease before its release", () => {
    expect(compareVersions("0.4.2", "0.4.1")).toBe(1);
    expect(compareVersions("v0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.4.0-rc.1", "0.4.0")).toBe(-1);
    expect(compareVersions("0.4.0-rc.2", "0.4.0-rc.1")).toBe(1);
    expect(compareVersions("0.4.0-rc.10", "0.4.0-rc.9")).toBe(1);
    expect(compareVersions("0.4.0", "v0.4.0")).toBe(0);
    expect(compareVersions("dev", "0.4.0")).toBeNull();
  });

  it("reads a release's notes, its first lines and a Security: line", () => {
    const r = readRelease({ tag_name: "v0.4.2", body: "Intro\n\n- One\n* Two\n\nSecurity: a crafted workflow could read files outside the library\n", assets: [] })!;
    expect(r).toMatchObject({ version: "0.4.2", highlights: ["One", "Two"], security: "a crafted workflow could read files outside the library", prerelease: false });
    expect(readRelease({ tag_name: "v0.4.2", body: "- Fixed the security tab" })!.security).toBeNull();
    expect(readRelease({ tag_name: "v0.4.2", draft: true })).toBeNull();
    expect(readRelease({ tag_name: "v0.5.0-rc.1" })!.prerelease).toBe(true);
  });

  it("verifies the list of checksums with the release key only", () => {
    const sums = Buffer.from("abc  afflatus.zip\n");
    const sig = sign(null, sums, KEY.privateKey).toString("base64");
    expect(verifySignature(sums, sig, KEY.publicKey)).toBe(true);
    expect(verifySignature(sums, sig, OTHER.publicKey)).toBe(false);
    expect(verifySignature(Buffer.from("abd  afflatus.zip\n"), sig, KEY.publicKey)).toBe(false);
    expect(verifySignature(sums, "not a signature", KEY.publicKey)).toBe(false);
    expect(readSums(`${"a".repeat(64)}  x.zip\n${"B".repeat(64)} *y.tar.gz\r\n`)).toEqual(new Map([["x.zip", "a".repeat(64)], ["y.tar.gz", "b".repeat(64)]]));
  });
});

// ---------------------------------------------------------------- the check

describe("the check", () => {
  it("finds a newer release, offers it to a bundle, and asks again with the ETag", async () => {
    const r = await rig();
    publish(gh, "0.4.2", { notes: "- Faster joins\n\nSecurity: the upload route checked no size\n" });
    expect((await r.post("check")).statusCode).toBe(200);
    const v = await r.view();
    expect(v).toMatchObject({ version: "0.4.1", install: "bundle", checks: true, newer: true, here: true, canUpdate: true, cannot: null, checkError: null, flow: null, previous: null, fallback: null, move: null });
    expect(v.latest).toMatchObject({ version: "0.4.2", highlights: ["Faster joins"], security: "the upload route checked no size" });
    expect(v.latest).not.toHaveProperty("assets");
    expect(v.checkedAt).toEqual(expect.any(String));
    await r.post("check");
    expect(gh.asked.filter((a) => a.startsWith("GET /latest"))).toHaveLength(2);
    expect(gh.asked[1]).toMatch(/if-none-match "/);
    // the 304 kept what the first answer said
    expect((await r.view()).latest?.version).toBe("0.4.2");
    // and the answer is kept across a restart, ETag and all
    const again = new AfflatusUpdates({ services: r.services, dataDir: r.data, restart: async () => {}, version: "0.4.1", install: "bundle", root: r.root, timers: false });
    await again.init();
    expect((await again.view(true)).latest?.version).toBe("0.4.2");
  });

  it("says nothing is newer for an older release, a prerelease, or a release a checkout already has", async () => {
    const r = await rig({ running: "0.5.0" });
    publish(gh, "0.4.2");
    await r.post("check");
    expect(await r.view()).toMatchObject({ newer: false, canUpdate: false, cannot: null });

    const rc = await rig({ running: "0.4.1" });
    publish(gh, "0.4.2-rc.1", { prerelease: true });
    await rc.post("check");
    expect((await rc.view()).newer).toBe(false);
    // a release candidate follows the release candidates
    const onRc = await rig({ running: "0.4.2-rc.1" });
    publish(gh, "0.4.2-rc.2", { prerelease: true });
    await onRc.post("check");
    expect((await onRc.view()).newer).toBe(true);

    // a checkout ("dev") is compared with its package.json's version (0.4.0 or later)
    const dev = await rig({ version: "dev", install: "sources" });
    publish(gh, "0.3.9");
    await dev.post("check");
    expect((await dev.view()).newer).toBe(false);
    publish(gh, "9.0.0");
    await dev.post("check");
    expect(await dev.view()).toMatchObject({ newer: true, canUpdate: false, cannot: expect.stringMatching(/sources/) });
  });

  it("gives Docker the notice without the button, and keeps the check off when the switch is off", async () => {
    const r = await rig({ install: "docker" });
    publish(gh, "0.4.2");
    await r.post("check");
    expect(await r.view()).toMatchObject({ install: "docker", newer: true, canUpdate: false, cannot: expect.stringMatching(/container/) });
    expect((await r.post("update")).statusCode).toBe(409);

    await writeSettings(r.services.db, { afflatusUpdateChecks: false });
    const asked = gh.asked.length;
    await r.updates.daily();
    expect(gh.asked.length).toBe(asked);
    expect((await r.view()).checks).toBe(false);
  });

  it("says why a check got no answer", async () => {
    const r = await rig();
    process.env.UPDATES_URL = "http://127.0.0.1:9/latest";
    await r.post("check");
    expect((await r.view()).checkError).toEqual(expect.any(String));
  });
});

// ---------------------------------------------------------------- the update

describe("the update of a bundle", () => {
  it("downloads, checks, unpacks beside, waits for the running render, copies the database, switches and restarts", async () => {
    const r = await rig({ before: ({ versions }) => mkdirSync(join(versions, "0.3.9")) });
    publish(gh, "0.4.2");
    await r.post("check");
    await addJob(r.services, "zz-test-running", "running");
    const pressed = await r.post("update");
    expect(pressed.statusCode).toBe(200);
    await settled(r);
    const waiting = (await r.view()).flow!;
    expect(waiting).toMatchObject({ phase: "waiting", version: "0.4.2", left: 1, error: null });
    expect(waiting.bytes).toBe(waiting.total);
    // unpacked and checked already, the switch not made
    expect(existsSync(join(r.versions, "0.4.2", "app", "apps", "server", "dist", "index.mjs"))).toBe(true);
    expect(readFileSync(join(r.versions, "current"), "utf8")).toBe("0.4.1");
    expect(r.restarts).toBe(0);
    // the render ends: the switch comes
    await sql`UPDATE jobs SET status = 'done' WHERE id = 'zz-test-running'`.execute(r.services.db);
    await until(() => r.restarts > 0, 10_000);
    expect(readFileSync(join(r.versions, "current"), "utf8")).toBe("0.4.2");
    expect(readFileSync(join(r.versions, "previous"), "utf8")).toBe("0.4.1");
    // the new version's first start, from which alone the launcher falls back
    expect(readFileSync(join(r.versions, "trial"), "utf8")).toBe("0.4.2");
    expect(existsSync(join(r.data, "backups", "before-0.4.2.db"))).toBe(true);
    // one previous version kept, never more; nothing left half done; the downloads gone
    expect(readdirSync(r.versions).sort()).toEqual(["0.4.1", "0.4.2", "current", "previous", "trial"]);
    expect(readdirSync(join(r.data, "updates"))).toEqual(["last.json"]);
    expect(JSON.parse(readFileSync(join(r.data, "updates", "last.json"), "utf8"))).toMatchObject({ kind: "updated", from: "0.4.1", to: "0.4.2" });
    expect(notesInPlace(r.data)).toEqual([]);
  });

  it("picks a download up where the connection was cut", async () => {
    const r = await rig();
    const { archive } = publish(gh, "0.4.2", { archive: bundle("0.4.2", { pad: 2 * 1024 * 1024 }) });
    gh.cutAt = Math.floor(archive.length / 2);
    await r.post("check");
    await r.post("update");
    await until(() => r.restarts > 0, 20_000);
    expect(gh.asked.some((a) => /range bytes=\d+-/.test(a))).toBe(true);
    expect(readFileSync(join(r.versions, "current"), "utf8")).toBe("0.4.2");
  });

  it("unpacks a zip with the system's tar", async () => {
    if (process.platform !== "win32") return;
    const r = await rig();
    // the rig says it is Linux: a zip of that name is what the Windows archive looks like
    publish(gh, "0.4.2", { zip: true, platform: "linux-x64" });
    await r.post("check");
    await r.post("update");
    await until(() => r.restarts > 0, 20_000);
    expect(existsSync(join(r.versions, "0.4.2", "app", "apps", "server", "dist", "index.mjs"))).toBe(true);
  });

  const refused = async (r: Rig, why: RegExp) => {
    await r.post("check");
    expect((await r.post("update")).statusCode).toBe(200);
    await settled(r);
    const v = await r.view();
    expect(v.flow).toMatchObject({ phase: "failed", version: "0.4.2" });
    expect(v.flow!.error).toMatch(why);
    expect(v.flow!.error).toMatch(/Nothing was changed: you are on 0\.4\.1\./);
    // the running version untouched
    expect(r.restarts).toBe(0);
    expect(readFileSync(join(r.versions, "current"), "utf8")).toBe("0.4.1");
    expect(readdirSync(r.versions).sort()).toEqual(["0.4.1", "current"]);
    // Try again is there
    expect(v.canUpdate).toBe(true);
  };

  it("refuses a download whose list is not signed by the release key", async () => {
    const r = await rig();
    publish(gh, "0.4.2", { signWith: OTHER.privateKey });
    await refused(r, /signature does not match Afflatus's release key/);
  });

  it("refuses an archive whose SHA-256 is not the one signed", async () => {
    const r = await rig();
    publish(gh, "0.4.2", { sums: `${"0".repeat(64)}  afflatus-v0.4.2-linux-x64.tar.gz\n` });
    await refused(r, /SHA-256/);
    expect(existsSync(join(r.data, "updates", "afflatus-v0.4.2-linux-x64.tar.gz"))).toBe(false);
  });

  it("refuses when the disk has no room for it", async () => {
    const r = await rig({ free: async () => 1000 });
    publish(gh, "0.4.2");
    await refused(r, /Not enough free space/);
  });

  it("refuses a version that does not pass its start check, and takes away what it unpacked", async () => {
    const r = await rig();
    publish(gh, "0.4.2", { archive: bundle("0.4.2", { checkCode: 1 }) });
    await refused(r, /0\.4\.2 does not start here \(its start check exited with 1/);
  });

  it("runs the new version's start check with the node where a Linux or macOS bundle has it (node/bin/node)", async () => {
    // the node the launchers run, found without a stand-in: on this computer it is not a program, so the check cannot
    // run it, and says which one it tried
    const r = await rig({ ownNode: true });
    publish(gh, "0.4.2", { archive: bundle("0.4.2", { nodeBin: true }) });
    await r.post("check");
    await r.post("update");
    await settled(r);
    const error = (await r.view()).flow?.error ?? "";
    expect(error).toMatch(/0\.4\.2 does not start here/);
    expect(error).toContain(join("0.4.2", "node", "bin", "node"));
  });

  it("finds a version's node as the launchers do", () => {
    const dir = mkdtempSync(join(tmpdir(), "afflatus-zz-test-node-"));
    try {
      expect(nodeIn(dir, "win-x64")).toBe(join(dir, "node", "node.exe"));
      expect(nodeIn(dir, "linux-x64")).toBe(join(dir, "node", "bin", "node"));
      // no node/bin/node, a node.exe: as afflatus.sh falls back to it
      mkdirSync(join(dir, "node"));
      writeFileSync(join(dir, "node", "node.exe"), "");
      expect(nodeIn(dir, "darwin-arm64")).toBe(join(dir, "node", "node.exe"));
      mkdirSync(join(dir, "node", "bin"));
      writeFileSync(join(dir, "node", "bin", "node"), "");
      expect(nodeIn(dir, "darwin-arm64")).toBe(join(dir, "node", "bin", "node"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes one press of Update at a time: a second one at once is refused, and the first keeps its hold on the queue", async () => {
    const r = await rig();
    publish(gh, "0.4.2");
    await r.post("check");
    await addJob(r.services, "zz-test-running", "running");
    const [a, b] = await Promise.all([r.post("update"), r.post("update")]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    await settled(r);
    expect((await r.view()).flow?.phase).toBe("waiting");
    expect((r.services.queue as unknown as { only: ReadonlySet<string> | null }).only).toEqual(new Set(["zz-test-running"]));
    await sql`UPDATE jobs SET status = 'done' WHERE id = 'zz-test-running'`.execute(r.services.db);
    await until(() => r.restarts > 0, 10_000);
    expect(r.restarts).toBe(1);
  });

  it("undoes a switch that did not go through: versions/current names the running version again, the new one is taken away", async () => {
    const r = await rig({ before: ({ data }) => mkdirSync(join(data, "updates", "last.json"), { recursive: true }) });
    publish(gh, "0.4.2");
    await r.post("check");
    await r.post("update");
    await settled(r);
    const v = await r.view();
    expect(v.flow).toMatchObject({ phase: "failed", version: "0.4.2" });
    expect(r.restarts).toBe(0);
    expect(readFileSync(join(r.versions, "current"), "utf8")).toBe("0.4.1");
    expect(readdirSync(r.versions).sort()).toEqual(["0.4.1", "current"]);
    expect(existsSync(join(r.data, "backups", "before-0.4.2.db"))).toBe(false);
    // the queue is let go
    expect((r.services.queue as unknown as { only: unknown }).only).toBeNull();
  });

  it("holds new jobs back while it waits, and lets them go when it is stopped", async () => {
    const r = await rig();
    publish(gh, "0.4.2");
    await r.post("check");
    await addJob(r.services, "zz-test-running", "running");
    await r.post("update");
    await settled(r);
    expect((await r.view()).flow?.phase).toBe("waiting");
    expect((r.services.queue as unknown as { only: ReadonlySet<string> | null }).only).toEqual(new Set(["zz-test-running"]));
    expect((await r.post("cancel")).statusCode).toBe(200);
    expect((await r.view()).flow).toBeNull();
    expect((r.services.queue as unknown as { only: unknown }).only).toBeNull();
    // what it unpacked is gone; the download stays for the next press
    expect(existsSync(join(r.versions, "0.4.2"))).toBe(false);
    expect(existsSync(join(r.data, "updates", "afflatus-v0.4.2-linux-x64.tar.gz"))).toBe(true);
  });

  it("does not wait for a job pinned to a machine that is paused: it would never start", async () => {
    const r = await rig();
    await writeSettings(r.services.db, { machines: [{ id: "m1", name: "A", url: NOWHERE }, { id: "m2", name: "B", url: "http://127.0.0.1:10" }] });
    await r.services.queue.setPaused(true, "m2");
    publish(gh, "0.4.2");
    await r.post("check");
    await addJob(r.services, "zz-test-pinned", "queued");
    await sql`UPDATE jobs SET pin_machine = 'm2' WHERE id = 'zz-test-pinned'`.execute(r.services.db);
    await r.post("update");
    await until(() => r.restarts > 0, 20_000);
  });
});

describe("the queue while an update waits", () => {
  it("starts no job asked for after Update was pressed, until the hold is let go", async () => {
    const fake = await makeFake();
    const t = await makeApp({ comfyUrl: fake.url });
    try {
      await t.services.queue.start();
      t.services.queue.holdNew(new Set());
      const id = ((await post(t.app, "/api/jobs", job())).json() as { ids: string[] }).ids[0]!;
      await new Promise((r) => setTimeout(r, 300));
      const status = async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
      expect(await status()).toBe("queued");
      t.services.queue.holdNew(null);
      await until(async () => (await status()) !== "queued");
    } finally {
      await t.close();
      await fake.close().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------- what the launcher left, Go back, the move

describe("after an update", () => {
  it("says once that the new version did not start and the launcher went back", async () => {
    const r = await rig({
      before: ({ data }) => {
        mkdirSync(join(data, "updates"));
        writeFileSync(join(data, "updates", "fallback.json"), JSON.stringify({ version: "0.4.2", previous: "0.4.1", at: "2026-10-11T10:00:00.000Z", code: 1 }));
      },
    });
    expect((await r.view()).fallback).toEqual({ version: "0.4.2", previous: "0.4.1", at: "2026-10-11T10:00:00.000Z", code: 1 });
    expect(existsSync(join(r.data, "updates", "fallback.json"))).toBe(false);
    expect(notesInPlace(r.data)).toEqual([]);
  });

  it("does not offer again a version that did not start, and takes its folder away; the next release is offered", async () => {
    const r = await rig({
      before: ({ data, versions }) => {
        mkdirSync(join(data, "updates"));
        mkdirSync(join(versions, "0.4.2"));
        writeFileSync(join(data, "updates", "fallback.json"), JSON.stringify({ version: "0.4.2", previous: "0.4.1", at: "2026-10-11T10:00:00.000Z", code: 3 }));
      },
    });
    expect(existsSync(join(r.versions, "0.4.2"))).toBe(false);
    publish(gh, "0.4.2");
    await r.post("check");
    expect(await r.view()).toMatchObject({ newer: true, canUpdate: false, cannot: "0.4.2 did not start here: the next release will be offered." });
    publish(gh, "0.4.3");
    await r.post("check");
    expect(await r.view()).toMatchObject({ newer: true, canUpdate: true, cannot: null });
  });

  it("takes no path out of versions/ from the launcher's note or versions/previous", async () => {
    let outside = "";
    const r = await rig({
      before: ({ base, data, versions }) => {
        outside = join(base, "zz-test-outside");
        mkdirSync(outside);
        mkdirSync(join(data, "updates"));
        writeFileSync(join(data, "updates", "fallback.json"), JSON.stringify({ version: "../../zz-test-outside", previous: "0.4.1", at: "2026-10-11T10:00:00.000Z", code: 1 }));
        writeFileSync(join(versions, "previous"), "..");
      },
    });
    expect(existsSync(outside)).toBe(true);
    const v = await r.view();
    expect(v.fallback).toBeNull();
    expect(v.previous).toBeNull();
    expect(existsSync(join(r.data, "updates", "failed.json"))).toBe(false);
    expect(versionName("0.4.0-rc.2")).toBe("0.4.0-rc.2");
    for (const bad of ["..", "...", "../x", "a\\b", "", null]) expect(versionName(bad)).toBeNull();
  });

  it("says the running version as releases are said, without the tag's v", async () => {
    const r = await rig({ version: "v0.4.1" });
    expect((await r.view()).version).toBe("0.4.1");
  });

  it("goes back to the previous version with the library as it was at the update", async () => {
    const r = await rig({
      running: "0.4.2",
      before: ({ versions }) => {
        mkdirSync(join(versions, "0.4.1"));
        writeFileSync(join(versions, "previous"), "0.4.1");
      },
    });
    const db = r.services.db;
    await writeSettings(db, { comfyDir: "zz-test-at-the-update" });
    mkdirSync(join(r.data, "backups"));
    await sql`VACUUM INTO ${join(r.data, "backups", "before-0.4.2.db")}`.execute(db);
    await writeSettings(db, { comfyDir: "zz-test-since" });
    expect((await r.view()).previous).toEqual({ version: "0.4.1", restoresLibrary: true });
    // not while a job runs: it would be cut
    await addJob(r.services, "zz-test-running", "running");
    expect((await r.post("go-back")).statusCode).toBe(409);
    await sql`UPDATE jobs SET status = 'done'`.execute(db);
    // not while a rented GPU runs, nor while a hunt may deploy one: 0.4.1 has nothing to stop them, they would bill unseen
    const left = vi.spyOn(r.services.rented, "goingBack").mockResolvedValue({ running: ["zz-test pod (NVIDIA A40)"], billing: ["volume zz-test (50 GB, $3.50/month)"], unknown: false });
    const refused = await r.post("go-back");
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: string }).error).toMatch(/zz-test pod \(NVIDIA A40\).*0\.4\.1 has no Rented GPUs screen/);
    left.mockResolvedValue({ running: [], billing: ["volume zz-test (50 GB, $3.50/month)"], unknown: false });
    const hunting = vi.spyOn(r.services.hunt, "view").mockReturnValue({ hunt: { status: "hunting" }, ranking: null, askedAt: null } as never);
    expect((await r.post("go-back")).statusCode).toBe(409);
    hunting.mockRestore();
    // what keeps billing, for its question
    const check = await r.app.inject({ method: "GET", url: "/api/updates/go-back", remoteAddress: "127.0.0.1" });
    expect(check.json()).toEqual({ refused: null, billing: ["volume zz-test (50 GB, $3.50/month)"], unknown: false });
    const back = await r.post("go-back");
    expect(back.statusCode).toBe(200);
    expect((back.json() as UpdatesView).flow?.phase).toBe("restarting");
    copies.length = 0;
    await until(() => r.restarts > 0 && existsSync(join(r.data, "updates", "last.json")));
    // the copy is made while the library's database is still in place: a stop halfway never leaves it without one
    expect(copies.filter((c) => dirname(c.to) === r.data)).toEqual([{ to: join(r.data, "afflatus.db.tmp"), dbThere: true }]);
    expect(existsSync(join(r.data, "afflatus.db.tmp"))).toBe(false);
    expect(readFileSync(join(r.versions, "current"), "utf8")).toBe("0.4.1");
    expect(existsSync(join(r.versions, "previous"))).toBe(false);
    const restored = openSqlite(join(r.data, "afflatus.db"));
    const row = await restored.selectFrom("settings").select("value").where("key", "=", "comfyDir").executeTakeFirst();
    await restored.destroy();
    expect(JSON.parse(row!.value)).toBe("zz-test-at-the-update");
    // the database as it was is set aside, not deleted
    expect(readdirSync(join(r.data, "backups")).some((n) => /^after-0\.4\.2-.+\.db$/.test(n))).toBe(true);
    expect(JSON.parse(readFileSync(join(r.data, "updates", "last.json"), "utf8"))).toMatchObject({ kind: "went-back", from: "0.4.2", to: "0.4.1" });
    expect(notesInPlace(r.data)).toEqual([]);
  });

  it("brings a 0.3 library beside it in, moved and not copied, while its own is empty", async () => {
    let old = "";
    const r = await rig({
      before: ({ base }) => {
        old = join(base, "afflatus-v0.3.0-win-x64", "data");
        mkdirSync(join(old, "files"), { recursive: true });
        writeFileSync(join(old, "afflatus.db"), "zz-test old library");
        writeFileSync(join(old, "files", "zz-test.png"), "png");
      },
    });
    expect((await r.view()).move).toEqual({ from: old, version: "0.3.0", items: null, timelines: null, drafts: null, bytes: 3 });
    // another computer is not offered it
    expect((await r.view("192.168.1.20")).move).toBeNull();
    expect((await r.post("move")).statusCode).toBe(200);
    await until(() => r.restarts > 0 && existsSync(join(r.data, "updates", "last.json")));
    expect(readFileSync(join(r.data, "afflatus.db"), "utf8")).toBe("zz-test old library");
    expect(existsSync(join(r.data, "files", "zz-test.png"))).toBe(true);
    expect(existsSync(old)).toBe(false);
    expect(readdirSync(r.root).some((n) => /^data-empty-/.test(n))).toBe(true);
    expect(JSON.parse(readFileSync(join(r.data, "updates", "last.json"), "utf8"))).toMatchObject({ kind: "moved", from: "0.3.0" });
    expect(notesInPlace(r.data)).toEqual([]);
  });

  it("finds a 0.3 library unpacked by Windows' Extract All, a folder deeper, beside this one's own", async () => {
    let old = "";
    const r = await rig({
      extracted: true,
      before: ({ base }) => {
        old = join(base, "afflatus-v0.3.0-win-x64", "afflatus-v0.3.0-win-x64", "data");
        mkdirSync(old, { recursive: true });
        writeFileSync(join(old, "afflatus.db"), "zz-test old library");
      },
    });
    expect((await r.view()).move).toEqual({ from: old, version: "0.3.0", items: null, timelines: null, drafts: null, bytes: 0 });
  });

  it("says what the 0.3 library holds: its items out of the bin, timelines, drafts, read without writing to it, and its files' size", async () => {
    let old = "";
    const r = await rig({
      before: ({ base }) => {
        old = join(base, "afflatus-v0.3.0-win-x64", "data");
        mkdirSync(join(old, "files", "a"), { recursive: true });
        writeFileSync(join(old, "files", "zz-test.png"), Buffer.alloc(1000));
        writeFileSync(join(old, "files", "a", "zz-test.mp4"), Buffer.alloc(24));
        // the tables as far as the counts read them
        const db = new DatabaseSync(join(old, "afflatus.db"));
        db.exec("CREATE TABLE assets (id TEXT, deleted_at TEXT); CREATE TABLE timelines (id TEXT); CREATE TABLE drafts (id TEXT);");
        db.exec("INSERT INTO assets VALUES ('a', NULL), ('b', NULL), ('c', '2026-01-01'); INSERT INTO timelines VALUES ('t'); INSERT INTO drafts VALUES ('d1'), ('d2'), ('d3');");
        db.close();
      },
    });
    const before = readFileSync(join(old, "afflatus.db"));
    expect((await r.view()).move).toEqual({ from: old, version: "0.3.0", items: 2, timelines: 1, drafts: 3, bytes: 1024 });
    expect(readFileSync(join(old, "afflatus.db")).equals(before)).toBe(true);
    // no database to read: the counts are unknown, not zero
    expect(await librarySummary(join(r.base, "nowhere"))).toEqual({ items: null, timelines: null, drafts: null, bytes: 0 });
  });

  it("offers no move once its own library has something in it", async () => {
    const r = await rig({
      before: ({ base }) => {
        mkdirSync(join(base, "afflatus-v0.3.0-win-x64", "data"), { recursive: true });
        writeFileSync(join(base, "afflatus-v0.3.0-win-x64", "data", "afflatus.db"), "zz-test");
      },
    });
    expect((await r.view()).move).not.toBeNull();
    await r.app.inject({ method: "POST", url: "/api/timelines", headers: { "x-afflatus": "1" }, payload: { name: "zz-test timeline" } });
    expect((await r.view()).move).toBeNull();
    expect((await r.post("move")).statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------- from this computer only

describe("the actions", () => {
  it("are taken only from the computer Afflatus runs on, and not through a proxy", async () => {
    const r = await rig();
    publish(gh, "0.4.2");
    await r.post("check");
    for (const path of ["check", "update", "cancel", "go-back", "move"]) {
      expect((await r.post(path, "192.168.1.20")).statusCode).toBe(403);
      expect((await r.post(path, "127.0.0.1", { "x-forwarded-for": "192.168.1.20" })).statusCode).toBe(403);
    }
    const there = await r.view("192.168.1.20");
    expect(there).toMatchObject({ here: false, newer: true, canUpdate: false, cannot: "Only on the computer Afflatus runs on." });
    expect((await r.view("::1")).here).toBe(true);
    expect((await r.view("::ffff:127.0.0.1")).here).toBe(true);
  });

  it("are not taken through a proxy on this computer that does not say whom it forwards for", async () => {
    // the proxy's name and the LAN address are allowed (ALLOWED_HOSTS), as a proxy needs them to be
    process.env.ALLOWED_HOSTS = "afflatus.example.test,192.168.1.5";
    const r = await rig().finally(() => delete process.env.ALLOWED_HOSTS);
    const asked = async (host: string) => (await r.app.inject({ method: "GET", url: "/api/updates", remoteAddress: "127.0.0.1", headers: { host } })).json() as UpdatesView;
    for (const host of ["afflatus.example.test", "192.168.1.5:8720"]) {
      expect((await r.post("check", "127.0.0.1", { host })).statusCode).toBe(403);
      expect((await asked(host)).here).toBe(false);
    }
    for (const host of ["localhost:8720", "127.0.0.1:8720", "[::1]:8720"]) expect((await asked(host)).here).toBe(true);
  });
});

// ---------------------------------------------------------------- the process: --check, the started marker, exit 75

describe("the server's side of the launcher's contract", () => {
  it("says plainly that a library a newer version migrated is not this version's, and names the copy to put back", async () => {
    const data = mkdtempSync(join(tmpdir(), "afflatus-zz-test-newer-"));
    try {
      const db = openSqlite(join(data, "afflatus.db"));
      await migrate(db);
      // what a newer version's migration leaves: one more row this code does not know
      await sql`INSERT INTO kysely_migration (name, timestamp) VALUES ('9999-zz-test-newer', ${new Date().toISOString()})`.execute(db);
      await db.destroy();
      mkdirSync(join(data, "backups"));
      writeFileSync(join(data, "backups", "before-0.4.2.db"), "zz-test");
      const failed = await start({ host: "127.0.0.1", port: 0, dataDir: data, databaseUrl: "" }, { queueOptions: FAST, log: { log: () => {}, warn: () => {} }, updates: { timers: false } }).then(() => null, (err: Error) => err);
      expect(failed).toBeInstanceOf(NewerLibraryError);
      expect(failed!.message).toMatch(/is from a newer Afflatus/);
      expect(failed!.message).toContain("9999-zz-test-newer");
      expect(failed!.message).toContain(join(data, "backups", "before-0.4.2.db"));
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  it("--check passes on a data folder it can write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afflatus-zz-test-check-"));
    try {
      expect(await check({ host: "127.0.0.1", port: 0, dataDir: dir, databaseUrl: "" }, { log: () => {}, warn: () => {} })).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the started marker once it listens, and exits with 75 after the move, the port and the page's stream let go", async () => {
    const base = mkdtempSync(join(tmpdir(), "afflatus-zz-test-start-"));
    const root = join(base, "Afflatus");
    const data = join(root, "data");
    const old = join(base, "afflatus-0.3.1", "data");
    mkdirSync(join(root, "versions", "0.4.0"), { recursive: true });
    writeFileSync(join(root, "versions", "current"), "0.4.0");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "afflatus.db"), "zz-test old library");
    const marker = join(root, "versions", "0.4.0", ".started-1");
    // the first start after the update to 0.4.0, which also had a previous version
    writeFileSync(join(root, "versions", "trial"), "0.4.0");
    writeFileSync(join(root, "versions", "previous"), "0.3.9");
    process.env.AFFLATUS_STARTED_FILE = marker;
    const exits: number[] = [];
    try {
      const port = await new Promise<number>((resolve) => {
        const s = createServer().listen(0, "127.0.0.1", () => {
          const p = (s.address() as { port: number }).port;
          s.close(() => resolve(p));
        });
      });
      const started = await start({ host: "127.0.0.1", port, dataDir: data, databaseUrl: "" }, {
        queueOptions: FAST, log: { log: () => {}, warn: () => {} }, exit: (code) => exits.push(code),
        updates: { install: "bundle", root, version: "0.4.0", startedFile: marker, timers: false },
      });
      expect(existsSync(marker)).toBe(true);
      // it started once: the launcher never falls back from it again; Go back still can
      expect(existsSync(join(root, "versions", "trial"))).toBe(false);
      expect(readFileSync(join(root, "versions", "previous"), "utf8")).toBe("0.3.9");
      // a page's event stream open: the restart must not wait for it to end
      const stream = new AbortController();
      const events = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: stream.signal });
      expect(events.status).toBe(200);
      const view = (await (await fetch(`http://127.0.0.1:${port}/api/updates`)).json()) as UpdatesView;
      expect(view.move).toMatchObject({ from: old, version: "0.3.1" });
      const moved = await fetch(`http://127.0.0.1:${port}/api/updates/move`, { method: "POST", headers: { "x-afflatus": "1" } });
      expect(moved.status).toBe(200);
      await until(() => exits.length > 0, 15_000);
      stream.abort();
      expect(exits).toEqual([75]);
      expect(readFileSync(join(data, "afflatus.db"), "utf8")).toBe("zz-test old library");
      expect(started.app.server.listening).toBe(false);
    } finally {
      delete process.env.AFFLATUS_STARTED_FILE;
      rmSync(base, { recursive: true, force: true });
    }
  });
});
