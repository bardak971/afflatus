import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { publicKeyOf, signBytes, verifyBytes } from "../../../scripts/release/sign.mjs";

// a throwaway key for these tests: the release key's private half is a secret of the release workflow only
const { privateKey } = generateKeyPairSync("ed25519");
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pub = publicKeyOf(pem);
const sums = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  afflatus-v0.4.0-win-x64.zip\n");
const dir = mkdtempSync(join(tmpdir(), "afflatus-sign-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const script = join(import.meta.dirname, "../../../scripts/release/sign.mjs");

describe("release signing", () => {
  it("signs SHA256SUMS.txt so that its public key verifies it", () => {
    expect(Buffer.from(pub, "base64")).toHaveLength(32);
    const sig = signBytes(sums, pem);
    expect(Buffer.from(sig, "base64")).toHaveLength(64);
    expect(verifyBytes(sums, sig, pub)).toBe(true);
  });

  it("refuses a list with one byte changed, a changed signature and another key", () => {
    const sig = signBytes(sums, pem);
    const changed = Buffer.from(sums);
    changed[0] = changed[0]! ^ 1;
    expect(verifyBytes(changed, sig, pub)).toBe(false);
    const bad = Buffer.from(sig, "base64");
    bad[10] = bad[10]! ^ 1;
    expect(verifyBytes(sums, bad.toString("base64"), pub)).toBe(false);
    const other = publicKeyOf(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    expect(verifyBytes(sums, sig, other)).toBe(false);
  });

  it("writes the .sig from AFFLATUS_RELEASE_KEY, and --verify checks it from the command line", () => {
    const file = join(dir, "SHA256SUMS.txt");
    writeFileSync(file, sums);
    execFileSync(process.execPath, [script, file], { env: { ...process.env, AFFLATUS_RELEASE_KEY: pem }, stdio: "pipe" });
    // the base64 alone, no line end: the signature is over the list's exact bytes, and the .sig is read as is
    expect(readFileSync(`${file}.sig`, "utf8")).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(() => execFileSync(process.execPath, [script, file, "--verify", pub], { stdio: "pipe" })).not.toThrow();
    writeFileSync(file, Buffer.concat([sums, Buffer.from(" ")]));
    expect(() => execFileSync(process.execPath, [script, file, "--verify", pub], { stdio: "pipe" })).toThrow();
  });

  it("refuses to sign without the key", () => {
    const file = join(dir, "nokey.txt");
    writeFileSync(file, sums);
    const env = { ...process.env };
    delete env.AFFLATUS_RELEASE_KEY;
    expect(() => execFileSync(process.execPath, [script, file], { env, stdio: "pipe" })).toThrow();
  });
});
