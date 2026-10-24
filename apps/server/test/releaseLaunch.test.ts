import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { clearStaleMarkers, decide, restoreLibrary, versionName } from "../../../scripts/release/launch.mjs";
import { until } from "./helpers";

const base = { code: 1, signal: null, started: false, version: "0.4.1", trial: "0.4.1", previous: "0.4.0", previousInstalled: true };

describe("the bundle's launch: what happens when the server stops", () => {
  it("starts again on 75, whether or not the server was up", () => {
    expect(decide({ ...base, code: 75 })).toEqual({ action: "restart" });
    expect(decide({ ...base, code: 75, started: true, previous: null })).toEqual({ action: "restart" });
  });

  it("falls back to the previous version when the new one stops before it is up, on its first start after the update", () => {
    expect(decide(base)).toEqual({ action: "fallback", to: "0.4.0" });
    expect(decide({ ...base, code: 0 })).toEqual({ action: "fallback", to: "0.4.0" });
  });

  it("never falls back from a version that has started once: weeks later, a failed start is not the update's doing", () => {
    expect(decide({ ...base, trial: null })).toEqual({ action: "stop", code: 1 });
    // versions/trial names another version: not this one's first start
    expect(decide({ ...base, trial: "0.4.0" })).toEqual({ action: "stop", code: 1 });
  });

  it("does not fall back on a port taken or a data folder that cannot be used, even on the first start", () => {
    expect(decide({ ...base, code: 3 })).toEqual({ action: "stop", code: 3 });
    expect(decide({ ...base, code: 4 })).toEqual({ action: "stop", code: 4 });
  });

  it("stops with the server's code otherwise", () => {
    // it was up: whatever stopped it is not the update's doing
    expect(decide({ ...base, started: true })).toEqual({ action: "stop", code: 1 });
    expect(decide({ ...base, started: true, code: 0 })).toEqual({ action: "stop", code: 0 });
    // nothing to go back to: no previous, the previous is this one (it failed already), or its folder is gone
    expect(decide({ ...base, previous: null })).toEqual({ action: "stop", code: 1 });
    expect(decide({ ...base, previous: "0.4.1" })).toEqual({ action: "stop", code: 1 });
    expect(decide({ ...base, previousInstalled: false })).toEqual({ action: "stop", code: 1 });
    // Ctrl+C or a signal during the start is the user's, never a reason to leave the version
    expect(decide({ ...base, code: null, signal: "SIGINT" })).toEqual({ action: "stop", code: 1 });
    expect(decide({ ...base, code: 0xc000013a })).toEqual({ action: "stop", code: 0xc000013a });
    expect(decide({ ...base, code: 130 })).toEqual({ action: "stop", code: 130 });
  });

  it("takes only a version's name from the versions/ files, never a path out of it", () => {
    expect(versionName("0.4.1")).toBe("0.4.1");
    expect(versionName("0.4.0-rc.2+build.1")).toBe("0.4.0-rc.2+build.1");
    for (const bad of ["../../x", "..", ".", "...", "a/b", "a\\b", "", "0.4.1.", ".hidden", null, 3]) expect(versionName(bad)).toBeNull();
  });
});

describe("the bundle's launch, run in a pretend bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "afflatus-launch-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const launch = join(import.meta.dirname, "../../../scripts/release/launch.mjs");

  /** A version folder whose "server" does what `body` says (it sees its environment as `process.env`). */
  const version = (v: string, body: string) => {
    const dir = join(root, "versions", v);
    mkdirSync(join(dir, "app", "apps", "server", "dist"), { recursive: true });
    mkdirSync(join(dir, "node", "bin"), { recursive: true });
    writeFileSync(join(dir, "node", "bin", "node"), "");
    cpSync(launch, join(dir, "app", "launch.mjs"));
    writeFileSync(join(dir, "app", "VERSION"), `v${v}\n`);
    writeFileSync(join(dir, "app", "apps", "server", "dist", "index.mjs"), `import { existsSync, writeFileSync } from "node:fs";\n${body}\n`);
  };
  const envOf = () => {
    const env: NodeJS.ProcessEnv = { ...process.env, AFFLATUS_NO_BROWSER: "1" };
    delete env.DATA_DIR;
    delete env.DATABASE_URL;
    delete env.FFMPEG;
    delete env.FFPROBE;
    return env;
  };
  const run = (v: string) => {
    writeFileSync(join(root, "versions", "current"), `${v}\n`);
    return spawnSync(process.execPath, [join(root, "versions", v, "app", "launch.mjs")], { env: envOf(), encoding: "utf8" }).status;
  };
  const current = () => readFileSync(join(root, "versions", "current"), "utf8").trim();
  const markers = (v: string) => readdirSync(join(root, "versions", v)).filter((n) => n.startsWith(".started"));
  const fallbackNote = join(root, "data", "updates", "fallback.json");

  it("gives the server a bundle's environment and a started marker of its run's own, and passes its 75 on", () => {
    version("0.4.0", `writeFileSync(process.env.AFFLATUS_STARTED_FILE, ""); writeFileSync(process.env.DATA_DIR + "-env.json", JSON.stringify(process.env)); process.exit(75);`);
    mkdirSync(join(root, "data"), { recursive: true });
    expect(run("0.4.0")).toBe(75);
    const env = JSON.parse(readFileSync(join(root, "data-env.json"), "utf8"));
    expect(env.AFFLATUS_INSTALL).toBe("bundle");
    expect(env.AFFLATUS_ROOT).toBe(root);
    expect(env.DATA_DIR).toBe(join(root, "data"));
    expect(env.AFFLATUS_VERSION).toBe("v0.4.0");
    expect(env.AFFLATUS_STARTED_FILE).toMatch(/[\\/]versions[\\/]0\.4\.0[\\/]\.started-\d+$/);
    // the run's marker goes with the run
    expect(markers("0.4.0")).toEqual([]);
  });

  it("puts the bundle's ffmpeg first on the PATH without setting FFMPEG, and passes a person's own FFMPEG on untouched", () => {
    version("0.3.9", `writeFileSync(process.env.DATA_DIR + "-env.json", JSON.stringify(process.env)); process.exit(0);`);
    const bin = join(root, "versions", "0.3.9", "bin");
    mkdirSync(bin, { recursive: true });
    const exe = process.platform === "win32" ? ".exe" : "";
    for (const t of ["ffmpeg", "ffprobe"]) writeFileSync(join(bin, t + exe), "");
    mkdirSync(join(root, "data"), { recursive: true });
    const read = () => JSON.parse(readFileSync(join(root, "data-env.json"), "utf8")) as NodeJS.ProcessEnv;
    const pathOf = (env: NodeJS.ProcessEnv) => env[Object.keys(env).find((k) => k.toUpperCase() === "PATH")!]!;
    // FFMPEG set by the launcher read as the person's own: the bundle's never passed over when it fails its check (ffmpegCheck.ts)
    expect(run("0.3.9")).toBe(0);
    const env = read();
    expect(env.FFMPEG).toBeUndefined();
    expect(env.FFPROBE).toBeUndefined();
    expect(pathOf(env).startsWith(bin)).toBe(true);
    const own = spawnSync(process.execPath, [join(root, "versions", "0.3.9", "app", "launch.mjs")], { env: { ...envOf(), FFMPEG: "/opt/zz-test/ffmpeg" }, encoding: "utf8" });
    expect(own.status).toBe(0);
    expect(read()).toMatchObject({ FFMPEG: "/opt/zz-test/ffmpeg" });
    expect(read().FFPROBE).toBeUndefined();
  });

  it("falls back on the new version's first start, with the library as it was before the update and a note", () => {
    version("0.4.1", `process.exit(1);`);
    writeFileSync(join(root, "versions", "previous"), "0.4.0\n");
    writeFileSync(join(root, "versions", "trial"), "0.4.1\n");
    // markers left by runs that ended do not count for this one
    writeFileSync(join(root, "versions", "0.4.1", ".started"), "");
    writeFileSync(join(root, "versions", "0.4.1", ".started-999999999"), "");
    // the library as the update copied it, and as 0.4.1 left it (migrated, with a log not yet written back)
    mkdirSync(join(root, "data", "backups"), { recursive: true });
    writeFileSync(join(root, "data", "backups", "before-0.4.1.db"), "zz-test library before 0.4.1");
    writeFileSync(join(root, "data", "afflatus.db"), "zz-test library 0.4.1 migrated");
    writeFileSync(join(root, "data", "afflatus.db-wal"), "zz-test 0.4.1's log");
    writeFileSync(join(root, "data", "afflatus.db-shm"), "zz-test");
    expect(run("0.4.1")).toBe(75);
    expect(current()).toBe("0.4.0");
    expect(existsSync(join(root, "versions", "trial"))).toBe(false);
    const note = JSON.parse(readFileSync(fallbackNote, "utf8"));
    expect(note).toMatchObject({ version: "0.4.1", previous: "0.4.0", code: 1 });
    expect(Number.isNaN(Date.parse(note.at))).toBe(false);
    expect(readFileSync(join(root, "data", "afflatus.db"), "utf8")).toBe("zz-test library before 0.4.1");
    for (const gone of ["afflatus.db-wal", "afflatus.db-shm", "afflatus.db.tmp"]) expect(existsSync(join(root, "data", gone))).toBe(false);
    const aside = readdirSync(join(root, "data", "backups")).filter((n) => n.startsWith("after-failed-0.4.1-"));
    expect(aside).toHaveLength(2);
    const db = aside.find((n) => n.endsWith(".db"))!;
    expect(readFileSync(join(root, "data", "backups", db), "utf8")).toBe("zz-test library 0.4.1 migrated");
    expect(readFileSync(join(root, "data", "backups", `${db}-wal`), "utf8")).toBe("zz-test 0.4.1's log");
    expect(markers("0.4.1")).toEqual([]);
  });

  it("does not fall back from a version that has started once, nor on a port taken", () => {
    rmSync(join(root, "data", "updates"), { recursive: true, force: true });
    // the update to 0.4.1 started once (versions/trial is gone; previous stays, for Go back), and later a start fails
    version("0.4.1", `process.exit(1);`);
    expect(run("0.4.1")).toBe(1);
    expect(current()).toBe("0.4.1");
    // its first start, but the port was taken: not the version's doing
    writeFileSync(join(root, "versions", "trial"), "0.4.1\n");
    version("0.4.1", `process.exit(3);`);
    expect(run("0.4.1")).toBe(3);
    expect(current()).toBe("0.4.1");
    expect(existsSync(fallbackNote)).toBe(false);
    rmSync(join(root, "versions", "trial"));
  });

  it("stops with the server's code once it was up", () => {
    version("0.4.1", `writeFileSync(process.env.AFFLATUS_STARTED_FILE, ""); process.exit(5);`);
    writeFileSync(join(root, "versions", "trial"), "0.4.1\n");
    expect(run("0.4.1")).toBe(5);
    expect(current()).toBe("0.4.1");
    expect(existsSync(fallbackNote)).toBe(false);
    rmSync(join(root, "versions", "trial"));
  });

  it("leaves the running one's marker on a second launch, and neither falls back", async () => {
    writeFileSync(join(root, "versions", "trial"), "0.4.1\n");
    // the server: up until told to stop, then it stops on an error of its own; a second one finds the port taken
    version("0.4.1", `
      const running = process.env.DATA_DIR + "-running";
      if (existsSync(running)) { console.error("Port 8720 is already in use"); process.exit(3); }
      writeFileSync(running, "");
      writeFileSync(process.env.AFFLATUS_STARTED_FILE, "");
      const t = setInterval(() => { if (existsSync(process.env.DATA_DIR + "-stop")) { clearInterval(t); process.exit(1); } }, 50);`);
    writeFileSync(join(root, "versions", "current"), "0.4.1\n");
    const first = spawn(process.execPath, [join(root, "versions", "0.4.1", "app", "launch.mjs")], { env: envOf(), stdio: "ignore" });
    const firstDone = new Promise<number | null>((r) => first.on("exit", (c) => r(c)));
    await until(() => markers("0.4.1").length === 1, 10_000);
    expect(run("0.4.1")).toBe(3);
    expect(markers("0.4.1")).toHaveLength(1);
    writeFileSync(join(root, "data-stop"), "");
    expect(await firstDone).toBe(1);
    expect(current()).toBe("0.4.1");
    expect(existsSync(fallbackNote)).toBe(false);
    rmSync(join(root, "data-running"));
    rmSync(join(root, "data-stop"));
  });

  it("takes away only the markers of runs that ended", () => {
    const dir = join(root, "markers");
    mkdirSync(dir, { recursive: true });
    for (const n of [".started", ".started-10", ".started-20", "keep.txt"]) writeFileSync(join(dir, n), "");
    clearStaleMarkers(dir, (pid) => pid === 20);
    expect(readdirSync(dir).sort()).toEqual([".started-20", "keep.txt"]);
  });

  it("puts a SQLite library back whole, without replaying the log of the database it sets aside", () => {
    const data = join(root, "sqlite");
    const newer = join(root, "sqlite-newer");
    mkdirSync(join(data, "backups"), { recursive: true });
    mkdirSync(newer, { recursive: true });
    const before = new DatabaseSync(join(data, "backups", "before-0.4.2.db"));
    before.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('zz-test before');");
    before.close();
    // the database as a newer version left it, its changes still in its log: copied while open, as a crash leaves it
    const open = new DatabaseSync(join(newer, "afflatus.db"));
    open.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (v TEXT); CREATE TABLE newer (x); INSERT INTO t VALUES ('zz-test after');");
    copyFileSync(join(newer, "afflatus.db"), join(data, "afflatus.db"));
    copyFileSync(join(newer, "afflatus.db-wal"), join(data, "afflatus.db-wal"));
    open.close();
    const aside = restoreLibrary(data, "0.4.2");
    expect(typeof aside).toBe("string");
    const back = new DatabaseSync(join(data, "afflatus.db"), { readOnly: true });
    expect(back.prepare("SELECT v FROM t").all()).toEqual([{ v: "zz-test before" }]);
    expect(back.prepare("SELECT name FROM sqlite_master WHERE name = 'newer'").all()).toEqual([]);
    back.close();
    // set aside whole: with its log beside it, it reads as the newer version left it
    const kept = new DatabaseSync(aside as string, { readOnly: true });
    expect(kept.prepare("SELECT v FROM t").all()).toEqual([{ v: "zz-test after" }]);
    kept.close();
    // no copy to put back: nothing is touched
    expect(restoreLibrary(data, "9.9.9")).toBe(false);
  });
});
