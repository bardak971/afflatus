import { describe, expect, it } from "vitest";
import { awsEncode, readListPage, s3Endpoint, signS3 } from "../src/runpodS3";

/** RunPod's S3 API as Afflatus speaks it: the signature, the endpoints and the listing's XML. */

describe("signing", () => {
  it("signs AWS's own example request (GET Object, Signature Version 4 documentation)", () => {
    const headers = signS3({
      method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", query: {}, headers: { Range: "bytes=0-9" }, region: "us-east-1",
      key: { user: "AKIAIOSFODNN7EXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" }, now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("encodes a path's bytes but keeps its slashes, and a query's slashes too", () => {
    expect(awsEncode("comfyui/models/loras/my lora (v2)+.safetensors", true)).toBe("comfyui/models/loras/my%20lora%20%28v2%29%2B.safetensors");
    expect(awsEncode("comfyui/models/")).toBe("comfyui%2Fmodels%2F");
    expect(awsEncode("é")).toBe("%C3%A9");
  });
});

describe("endpoints", () => {
  it("has one per data center that RunPod serves, none elsewhere", () => {
    expect(s3Endpoint("EU-RO-1")).toBe("https://s3api-eu-ro-1.runpod.io");
    expect(s3Endpoint("EUR-IS-1")).toBe("https://s3api-eur-is-1.runpod.io");
    expect(s3Endpoint("US-TX-3")).toBeNull();
  });
});

describe("listing", () => {
  it("reads the files of a page, their sizes and dates, and the next page's token", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>vol</Name><IsTruncated>true</IsTruncated>
      <Contents><Key>comfyui/models/loras/a &amp; b.safetensors</Key><LastModified>2026-10-14T09:00:00.000Z</LastModified><ETag>"x"</ETag><Size>228000000</Size></Contents>
      <Contents><Key>comfyui/models/vae/wan.safetensors</Key><Size>254000000</Size></Contents>
      <NextContinuationToken>abc/=</NextContinuationToken></ListBucketResult>`;
    expect(readListPage(xml)).toEqual({
      objects: [
        { key: "comfyui/models/loras/a & b.safetensors", size: 228_000_000, modified: "2026-10-14T09:00:00.000Z" },
        { key: "comfyui/models/vae/wan.safetensors", size: 254_000_000, modified: null },
      ],
      next: "abc/=",
    });
    expect(readListPage("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>")).toEqual({ objects: [], next: null });
  });
});
