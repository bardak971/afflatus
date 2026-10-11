import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decide } from "../../../scripts/release/launch.mjs";

const base = { code: 1, signal: null, started: false, version: "0.4.1", previous: "0.4.0", previousInstalled: true };

describe("the bundle's launch: what happens when the server stops", () => {
  it("starts again on 75, whether or not the server was up", () => {
    expect(decide({ ...base, code: 75 })).toEqual({ action: "restart" });
    expect(decide({ ...base, code: 75, started: true, previous: null })).toEqual({ action: "restart" });
  });

  it("falls back to the previous version when the new one stops before it is up", () => {
    expect(decide(base)).toEqual({ action: "fallback", to: "0.4.0" });
    expect(decide({ ...base, code: 0 })).toEqual({ action: "fallback", to: "0.4.0" });
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
    writeFileSync(join(dir, "app", "apps", "server", "dist", "index.mjs"), `import { writeFileSync } from "node:fs";\n${body}\n`);
  };
  const run = (v: string) => {
    writeFileSync(join(root, "versions", "current"), `${v}\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, AFFLATUS_NO_BROWSER: "1" };
    delete env.DATA_DIR;
    return spawnSync(process.execPath, [join(root, "versions", v, "app", "launch.mjs")], { env, encoding: "utf8" }).status;
  };
  const current = () => readFileSync(join(root, "versions", "current"), "utf8").trim();

  it("gives the server a bundle's environment, and passes its 75 on", () => {
    version("0.4.0", `writeFileSync(process.env.AFFLATUS_STARTED_FILE, ""); writeFileSync(process.env.DATA_DIR + "-env.json", JSON.stringify(process.env)); process.exit(75);`);
    mkdirSync(join(root, "data"), { recursive: true });
    expect(run("0.4.0")).toBe(75);
    const env = JSON.parse(readFileSync(join(root, "data-env.json"), "utf8"));
    expect(env.AFFLATUS_INSTALL).toBe("bundle");
    expect(env.AFFLATUS_ROOT).toBe(root);
    expect(env.DATA_DIR).toBe(join(root, "data"));
    expect(env.AFFLATUS_VERSION).toBe("v0.4.0");
    expect(env.AFFLATUS_STARTED_FILE).toBe(join(root, "versions", "0.4.0", ".started"));
  });

  it("falls back to the previous version, with a note, when the new one stops before it is up", () => {
    version("0.4.1", `process.exit(3);`);
    writeFileSync(join(root, "versions", "previous"), "0.4.0\n");
    // a marker left by an earlier start that went well does not count for this one
    writeFileSync(join(root, "versions", "0.4.1", ".started"), "");
    expect(run("0.4.1")).toBe(75);
    expect(current()).toBe("0.4.0");
    const note = JSON.parse(readFileSync(join(root, "data", "updates", "fallback.json"), "utf8"));
    expect(note).toMatchObject({ version: "0.4.1", previous: "0.4.0", code: 3 });
    expect(Number.isNaN(Date.parse(note.at))).toBe(false);
  });

  it("stops with the server's code once it was up", () => {
    rmSync(join(root, "data", "updates"), { recursive: true, force: true });
    version("0.4.1", `writeFileSync(process.env.AFFLATUS_STARTED_FILE, ""); process.exit(4);`);
    expect(run("0.4.1")).toBe(4);
    expect(current()).toBe("0.4.1");
    expect(existsSync(join(root, "data", "updates", "fallback.json"))).toBe(false);
  });
});
