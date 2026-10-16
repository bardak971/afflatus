import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A file of a pretend volume: its bytes and when it was written. */
export interface FakeS3File {
  size: number;
  modified?: string;
}

export interface FakeS3 {
  url: string;
  /** Each volume's files by path, as its bucket holds them (the volume's id). */
  volumes: Map<string, Map<string, FakeS3File>>;
  /** Every call, as "METHOD /bucket/key?query". */
  calls: string[];
  /** The access key it takes (the RunPod user's id); a request signed with another is refused (403). */
  user: string;
  /** Files per page of a listing, to try paging. */
  pageSize: number;
  /** Paths whose DELETE fails (500), to try a failure in the middle. */
  failDelete: Set<string>;
  close(): Promise<void>;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const error = (code: string, message: string) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xml(message)}</Message></Error>`;

/**
 * A pretend RunPod S3 API (runpodS3.ts) for the demo and the tests, every data center at one address (RUNPOD_S3_URL): a
 * volume is a bucket of files, path-style, listed with ListObjectsV2 (paged), a file deleted with DeleteObject. It checks
 * that a request is signed with Signature Version 4 by its user, not the signature itself: the signing has its own test
 * against AWS's example.
 */
export async function startFakeS3(o: { user: string; volumes?: Record<string, Record<string, FakeS3File>> }): Promise<FakeS3> {
  const fake: Omit<FakeS3, "url" | "close"> = {
    user: o.user, calls: [], pageSize: 1000, failDelete: new Set(),
    volumes: new Map(Object.entries(o.volumes ?? {}).map(([id, files]) => [id, new Map(Object.entries(files))])),
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    fake.calls.push(`${req.method} ${decodeURIComponent(url.pathname)}${url.search}`);
    const send = (status: number, body = "") => {
      res.writeHead(status, { "content-type": "application/xml" });
      res.end(body);
    };
    const auth = String(req.headers.authorization ?? "");
    if (!auth.startsWith(`AWS4-HMAC-SHA256 Credential=${fake.user}/`) || !/Signature=[0-9a-f]{64}$/.test(auth) || !req.headers["x-amz-date"]) {
      return send(403, error("AccessDenied", "Invalid S3 credentials"));
    }
    const [, bucket = "", ...rest] = url.pathname.split("/");
    const files = fake.volumes.get(decodeURIComponent(bucket));
    if (!files) return send(404, error("NoSuchBucket", "The specified bucket does not exist"));
    const key = rest.map(decodeURIComponent).join("/");
    if (req.method === "GET" && !key) {
      const prefix = url.searchParams.get("prefix") ?? "";
      const all = [...files.keys()].filter((k) => k.startsWith(prefix)).sort();
      const from = Number(url.searchParams.get("continuation-token") ?? 0);
      const page = all.slice(from, from + fake.pageSize);
      const more = from + fake.pageSize < all.length;
      const contents = page.map((k) => `<Contents><Key>${xml(k)}</Key><LastModified>${files.get(k)!.modified ?? "2026-10-01T10:00:00.000Z"}</LastModified><Size>${files.get(k)!.size}</Size></Contents>`).join("");
      return send(200, `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${xml(bucket)}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${more}</IsTruncated>${contents}${more ? `<NextContinuationToken>${from + fake.pageSize}</NextContinuationToken>` : ""}</ListBucketResult>`);
    }
    if (req.method === "DELETE" && key) {
      if (fake.failDelete.has(key)) return send(500, error("InternalError", "We encountered an internal error. Please try again."));
      files.delete(key);
      return send(204);
    }
    return send(405, error("MethodNotAllowed", "Not supported by the pretend S3"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return Object.assign(fake, { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
}
