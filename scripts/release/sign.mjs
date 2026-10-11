// Signs a release's SHA256SUMS.txt, so that an Afflatus updating itself takes only files the release key vouches
// for: the signature covers the exact bytes of the list, and the list names the SHA-256 of every archive.
//
//   AFFLATUS_RELEASE_KEY=<PEM> node scripts/release/sign.mjs dist/SHA256SUMS.txt          → dist/SHA256SUMS.txt.sig
//   node scripts/release/sign.mjs dist/SHA256SUMS.txt --verify <public key, base64>       → exits 0 or 1
//
// The key is Ed25519: the private half a PKCS#8 PEM (the release workflow's secret AFFLATUS_RELEASE_KEY, never in
// the repository), the public half its 32 raw bytes in base64, as apps/server/src/releaseKey.ts holds it. The
// .sig is the 64-byte signature in base64, with no line end. Node's own crypto does it all: no dependency.
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The base64 Ed25519 signature of `data` with a PKCS#8 PEM private key. */
export function signBytes(data, privatePem) {
  const key = createPrivateKey(privatePem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`the release key is ${key.asymmetricKeyType}, not Ed25519`);
  return sign(null, data, key).toString("base64");
}

/** The raw public key (base64) of a PKCS#8 PEM private key: what releaseKey.ts holds. */
export function publicKeyOf(privatePem) {
  const jwk = createPublicKey(createPrivateKey(privatePem)).export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

/** Whether `signature` (base64) is the raw Ed25519 public key `publicKey`'s (base64) over `data`. */
export function verifyBytes(data, signature, publicKey) {
  const raw = Buffer.from(publicKey.trim(), "base64");
  if (raw.length !== 32) throw new Error("the public key is not 32 bytes of base64");
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
  const sig = Buffer.from(signature.trim(), "base64");
  return sig.length === 64 && verify(null, data, key, sig);
}

function main(argv) {
  const at = argv.indexOf("--verify");
  const file = argv.find((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1));
  if (!file) throw new Error("usage: sign.mjs <SHA256SUMS.txt> [--verify <public key base64>]");
  const data = readFileSync(file);
  if (argv.includes("--verify")) {
    const publicKey = argv[at + 1];
    if (!publicKey) throw new Error("--verify needs the public key (base64)");
    const ok = verifyBytes(data, readFileSync(`${file}.sig`, "utf8"), publicKey);
    console.log(ok ? `[sign] ${file}.sig verifies` : `[sign] ${file}.sig does NOT verify with that key`);
    return ok ? 0 : 1;
  }
  const pem = process.env.AFFLATUS_RELEASE_KEY?.trim();
  if (!pem) throw new Error("AFFLATUS_RELEASE_KEY is empty: the release key (an Ed25519 PKCS#8 PEM) is needed to sign");
  writeFileSync(`${file}.sig`, signBytes(data, pem));
  console.log(`[sign] ${file}.sig written (public key ${publicKeyOf(pem)})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
