import { createHash, createHmac } from "node:crypto";
import { envSaid } from "./config";

/**
 * A network volume's files read and deleted through RunPod's S3-compatible API (https://docs.runpod.io/storage/s3-api), with
 * no pod running: the volume viewer (volumeFiles.ts). One endpoint per data center, the data center's id as the region, the
 * volume's id as the bucket, path-style. Requests are signed with AWS Signature Version 4 using the account's S3 API key
 * (RunPod › Settings › S3 API Keys): its access key is the user's id, its secret starts with "rps_". The key is not the
 * REST API key. RUNPOD_S3_URL points every data center at one pretend S3 (the demo, the tests).
 */

/** The data centers whose volumes the S3 API serves, as RunPod's page listed them on 2026-10-16. */
export const S3_DATA_CENTERS: readonly string[] = [
  "EU-CZ-1", "EU-RO-1", "EUR-IS-1", "EUR-NO-1", "US-CA-2", "US-GA-2", "US-IL-1", "US-KS-2", "US-MD-1", "US-MO-1", "US-MO-2", "US-NC-1", "US-NC-2", "US-NE-1", "US-WA-1",
];

/**
 * The S3 endpoint of a data center; null where RunPod has none (a pretend S3 stands in for the ones it has). Under pretend
 * sites (AFFLATUS_PRETEND_SITES: the demo, the tests) it throws unless RUNPOD_S3_URL says the pretend one, as runpod.ts's
 * API and proxy do, so that a signed request never reaches RunPod's own S3 from there.
 */
export function s3Endpoint(dataCenter: string): string | null {
  if (!S3_DATA_CENTERS.includes(dataCenter)) return null;
  const said = envSaid.runpodS3()?.trim();
  if (!said && envSaid.pretendSites()) throw new Error("not sent: no site on the internet is asked here (RUNPOD_S3_URL is not set)");
  return (said || `https://s3api-${dataCenter.toLowerCase()}.runpod.io`).replace(/\/+$/, "");
}

export interface S3Key {
  /** The access key: the RunPod user's id ("user_…"). */
  user: string;
  /** The secret ("rps_…"), shown once by RunPod. */
  secret: string;
}

/** A file of the volume as S3 lists it: its path from the volume's root, its bytes, when it was last written. */
export interface S3Object {
  key: string;
  size: number;
  modified: string | null;
}

/** S3 refused or failed: its own words when it said some (its <Message>), with the HTTP status. */
export class S3Error extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null = null) {
    super(message);
  }
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it: every byte but the unreserved ones; `/` kept in a path. */
export function awsEncode(text: string, path = false): string {
  return [...Buffer.from(text, "utf8")]
    .map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-_.~]/.test(c) || (path && c === "/")) return c;
      return `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

/**
 * The headers that sign a request (AWS Signature Version 4, service "s3"): Authorization, x-amz-date and
 * x-amz-content-sha256. `path` is already encoded; `query` is encoded here, sorted by name. Exported for its test against
 * AWS's own example.
 */
export function signS3(o: { method: string; host: string; path: string; query: Record<string, string>; headers?: Record<string, string>; region: string; key: S3Key; now: Date; payloadHash?: string }): Record<string, string> {
  const amzDate = o.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = o.payloadHash ?? sha256("");
  const headers: Record<string, string> = { host: o.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  for (const [k, v] of Object.entries(o.headers ?? {})) headers[k.toLowerCase()] = v.trim();
  const names = Object.keys(headers).sort();
  const query = Object.keys(o.query).sort().map((k) => `${awsEncode(k)}=${awsEncode(o.query[k]!)}`).join("&");
  const canonical = [o.method, o.path, query, names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${o.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${o.key.secret}`, day), o.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
  const { host: _host, ...sent } = headers;
  return { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${o.key.user}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

const unXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? unXml(m[1]!) : null;
};

/** A page of ListObjectsV2, read from its XML: the files, and the token of the next page when there is one. */
export function readListPage(xml: string): { objects: S3Object[]; next: string | null } {
  const objects: S3Object[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = tag(m[1]!, "Key");
    const size = Number(tag(m[1]!, "Size"));
    if (key === null || !Number.isFinite(size)) continue;
    objects.push({ key, size, modified: tag(m[1]!, "LastModified") });
  }
  return { objects, next: tag(xml, "IsTruncated") === "true" ? tag(xml, "NextContinuationToken") : null };
}

/** Pages of a listing at most: a models folder is a few hundred files, never ten thousand. */
const MAX_PAGES = 50;

/** One volume's bucket, on its data center's endpoint. */
export class VolumeS3 {
  private readonly endpoint: URL;
  constructor(private readonly volume: string, private readonly dataCenter: string, private readonly key: S3Key, endpoint: string, private readonly o: { timeoutMs?: number; retryMs?: number } = {}) {
    this.endpoint = new URL(endpoint);
  }

  private async call(method: "GET" | "DELETE" | "HEAD", objectKey: string, query: Record<string, string> = {}): Promise<string> {
    const base = this.endpoint.pathname.replace(/\/+$/, "");
    const path = `${base}/${awsEncode(this.volume)}${objectKey ? `/${awsEncode(objectKey, true)}` : ""}`;
    const headers = signS3({ method, host: this.endpoint.host, path, query, region: this.dataCenter, key: this.key, now: new Date() });
    const search = Object.keys(query).sort().map((k) => `${awsEncode(k)}=${awsEncode(query[k]!)}`).join("&");
    const url = `${this.endpoint.origin}${path}${search ? `?${search}` : ""}`;
    const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(this.o.timeoutMs ?? 60_000) }).catch((err: Error) => {
      throw new S3Error(`RunPod's S3 API in ${this.dataCenter} did not answer (${err.name === "TimeoutError" ? "no answer in time" : err.message})`, 0);
    });
    const body = await res.text();
    if (!res.ok) {
      const code = tag(body, "Code");
      const said = tag(body, "Message");
      throw new S3Error(said || code || `HTTP ${res.status}`, res.status, code);
    }
    return body;
  }

  /**
   * Every file under a prefix, page by page. RunPod's listing of files a pod wrote can fail the first time with the same
   * continuation token twice (its page says so, "retrying after a pause usually helps"): asked again once, after a pause.
   */
  async list(prefix: string): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const ask = (): Promise<string> => this.call("GET", "", { "list-type": "2", prefix, "max-keys": "1000", ...(token ? { "continuation-token": token } : {}) });
      let got = readListPage(await ask());
      if (got.next && got.next === token) {
        await new Promise((r) => setTimeout(r, this.o.retryMs ?? 3000));
        got = readListPage(await ask());
        if (got.next === token) throw new S3Error("RunPod's S3 API gave the same page twice: it is still reading the volume. Try again in a minute.", 0);
      }
      out.push(...got.objects);
      if (!got.next) return out;
      token = got.next;
    }
    throw new S3Error(`More than ${MAX_PAGES * 1000} files under ${prefix}: not listed.`, 0);
  }

  /** A file deleted. S3 answers 204 for a file that was not there too: deleting twice is harmless. */
  async remove(objectKey: string): Promise<void> {
    await this.call("DELETE", objectKey);
  }
}
