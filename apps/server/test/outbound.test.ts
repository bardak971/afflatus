import dns from "node:dns";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { civitaiGet } from "../src/civitai";
import { findOnHuggingFace, forgetHuggingFace } from "../src/huggingface";
import { assertPublicUrl, cannotReach, fetchFailure, fetchPublic, insideRefusingLookup, isPrivateAddress, isPrivateHost } from "../src/outbound";

describe("where the server may fetch from", () => {
  it("knows the addresses of this machine and its network", () => {
    for (const ip of ["127.0.0.1", "127.8.8.8", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "::", "fe80::1", "fd00::1", "fc00::abcd", "::ffff:192.168.1.1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "192.167.1.1", "2606:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("judges an IPv4 address carried in IPv6 by that address, however it is written, and the ranges no stranger's server is in", () => {
    // the forms the 0.5.0 review got through: what URL makes of [::ffff:127.0.0.1], the metadata address mapped, NAT64
    const inside = ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "64:ff9b::127.0.0.1", "64:ff9b:1::5",
      "::7f00:1", "::127.0.0.1", "::a00:1", "0:0:0:0:0:ffff:127.0.0.1", "::ffff:0:7f00:1", "2002:7f00:1::", "2002:c0a8:101::1", "2002:a9fe:a9fe::",
      "198.18.0.1", "198.19.255.255", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "ff02::1", "fec0::1", "FE80::1%eth0"];
    for (const ip of inside) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["64:ff9b::808:808", "2002:808:808::1", "::ffff:808:808", "198.17.255.255", "198.20.0.1", "223.255.255.255", "2001:4860:4860::8888"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("refuses those forms in an address, as URL spells them", () => {
    for (const url of ["http://[::ffff:127.0.0.1]:8188/", "http://[::ffff:169.254.169.254]/latest/meta-data/", "http://[64:ff9b::7f00:1]/", "http://[::127.0.0.1]/",
      "http://[2002:7f00:1::]/", "http://[0:0:0:0:0:ffff:7f00:1]/", "http://198.18.0.1/", "http://224.0.0.1/", "http://2130706433/", "http://0x7f.1/"]) {
      expect(() => assertPublicUrl(url), url).toThrow(/inside your own network/);
    }
  });

  it("treats localhost, bare names and the local suffixes as the network's own", () => {
    for (const host of ["localhost", "LOCALHOST", "app.localhost", "router", "nas.local", "host.docker.internal", "[::1]", "10.0.0.5"]) expect(isPrivateHost(host), host).toBe(true);
    for (const host of ["civitai.com", "huggingface.co", "cdn-lfs.hf.co", "8.8.8.8"]) expect(isPrivateHost(host), host).toBe(false);
  });

  it("refuses private targets and other schemes, and lets through what is named as allowed", () => {
    expect(() => assertPublicUrl("http://127.0.0.1:8188/x")).toThrow(/inside your own network/);
    expect(() => assertPublicUrl("http://192.168.1.4/model.safetensors")).toThrow(/inside your own network/);
    expect(() => assertPublicUrl("file:///etc/passwd")).toThrow(/http and https/);
    expect(() => assertPublicUrl("not a url")).toThrow(/not an address/);
    expect(assertPublicUrl("https://civitai.com/api/download/models/1").hostname).toBe("civitai.com");
    expect(assertPublicUrl("http://127.0.0.1:8188/x", ["http://127.0.0.1:8188"]).port).toBe("8188");
    expect(assertPublicUrl("http://[::1]:9/x", ["http://[::1]:9"]).hostname).toBe("[::1]");
  });

  it("allows a host inside the network by its port too: another port of the same machine is another service", () => {
    const allow = ["http://127.0.0.1:8188"];
    expect(() => assertPublicUrl("http://127.0.0.1:8720/api/comfy/node-pack.zip", allow)).toThrow(/inside your own network/);
    expect(() => assertPublicUrl("http://127.0.0.1/x", allow)).toThrow(/inside your own network/);
    // a host alone allows no port of it
    expect(() => assertPublicUrl("http://127.0.0.1:8188/x", ["127.0.0.1"])).toThrow(/inside your own network/);
    expect(() => assertPublicUrl("http://localhost:8188/x", allow)).toThrow(/inside your own network/);
  });
});

describe("following a redirect", () => {
  let a: Server;
  let b: Server;
  let aUrl = "";
  let bUrl = "";
  let seen: Array<{ at: string; url: string; auth?: string }> = [];
  const serve = (name: string, route: (url: string, res: ServerResponse) => void) => {
    const s = createServer((req, res) => {
      seen.push({ at: name, url: req.url ?? "", auth: req.headers.authorization });
      route(req.url ?? "", res);
    });
    return new Promise<Server>((r) => s.listen(0, "127.0.0.1", () => r(s)));
  };
  const to = (res: ServerResponse, where: string) => {
    res.writeHead(302, { location: where });
    res.end();
  };
  beforeEach(async () => {
    seen = [];
    b = await serve("b", (_url, res) => res.end("file"));
    bUrl = `http://127.0.0.1:${(b.address() as AddressInfo).port}`;
    a = await serve("a", (url, res) => {
      if (url === "/elsewhere") return to(res, `${bUrl}/file`);
      if (url === "/same") return to(res, "/file");
      if (url === "/inside") return to(res, "http://169.254.169.254/latest/meta-data/");
      if (url.startsWith("/loop")) return to(res, `/loop${url.length}`);
      res.end("file");
    });
    aUrl = `http://127.0.0.1:${(a.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((r) => a.close(r));
    await new Promise((r) => b.close(r));
  });
  const headers = { "User-Agent": "afflatus", Authorization: "Bearer k-123" };

  it("judges each address it is sent on to, as the first one was", async () => {
    await expect(fetchPublic(`${aUrl}/inside`, { headers }, [aUrl, bUrl])).rejects.toThrow(/inside your own network/);
    expect(seen.map((s) => s.url)).toEqual(["/inside"]);
  });

  it("keeps the key for the host first asked: another host gets none", async () => {
    expect(await (await fetchPublic(`${aUrl}/elsewhere`, { headers }, [aUrl, bUrl])).text()).toBe("file");
    expect(seen).toEqual([{ at: "a", url: "/elsewhere", auth: "Bearer k-123" }, { at: "b", url: "/file", auth: undefined }]);
    seen = [];
    await fetchPublic(`${aUrl}/same`, { headers }, [aUrl, bUrl]);
    expect(seen.map((s) => s.auth)).toEqual(["Bearer k-123", "Bearer k-123"]);
  });

  it("is never let down from https to plain http on the way", async () => {
    const asked: string[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      asked.push(String(url));
      return new Response(null, { status: 302, headers: { location: "http://cdn.example.com/model.safetensors" } });
    });
    try {
      await expect(fetchPublic("https://example.com/model.safetensors", { headers })).rejects.toThrow(/plain http address \(cdn\.example\.com\): refused/);
      expect(asked).toEqual(["https://example.com/model.safetensors"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("gives up after five redirects", async () => {
    await expect(fetchPublic(`${aUrl}/loop`, { headers }, [aUrl, bUrl])).rejects.toThrow(/more than 5 times/);
    expect(seen.length).toBe(6);
  });
});

describe("a failed fetch, said plainly", () => {
  it("names the host and the reason instead of undici's bare 'fetch failed'", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/x`;
    await new Promise((r) => closed.close(r));
    const err = await fetch(url).catch((e: unknown) => e);
    expect(cannotReach(err)).toBe(true);
    expect(fetchFailure(err, url)).toBe(`could not reach ${new URL(url).host} (ECONNREFUSED)`);
    // anything else is said as it was
    expect(cannotReach(new Error("terminated"))).toBe(false);
    expect(fetchFailure(new Error("the site answered 503"), url)).toBe("the site answered 503");
  });
});

describe("Civitai's and Hugging Face's APIs, sent on elsewhere", () => {
  let a: Server;
  let b: Server;
  let aUrl = "";
  let seen: Array<{ at: string; url: string; auth?: string }> = [];
  const was = { civitai: process.env.CIVITAI_URL, hf: process.env.HUGGINGFACE_URL };
  const serve = (name: string, route: (url: string, res: ServerResponse) => void) => {
    const s = createServer((req, res) => {
      seen.push({ at: name, url: req.url ?? "", auth: req.headers.authorization });
      route(req.url ?? "", res);
    });
    return new Promise<Server>((r) => s.listen(0, "127.0.0.1", () => r(s)));
  };
  const to = (res: ServerResponse, where: string) => {
    res.writeHead(302, { location: where });
    res.end();
  };
  beforeEach(async () => {
    seen = [];
    b = await serve("b", (_url, res) => res.end(JSON.stringify({ id: 1 })));
    const bUrl = `http://127.0.0.1:${(b.address() as AddressInfo).port}`;
    a = await serve("a", (url, res) => {
      if (url === "/api/v1/model-versions/1") return to(res, `${bUrl}/v`);
      to(res, "http://169.254.169.254/latest/meta-data/");
    });
    aUrl = `http://127.0.0.1:${(a.address() as AddressInfo).port}`;
    process.env.CIVITAI_URL = aUrl;
    process.env.HUGGINGFACE_URL = aUrl;
    forgetHuggingFace();
  });
  afterEach(async () => {
    for (const [k, v] of [["CIVITAI_URL", was.civitai], ["HUGGINGFACE_URL", was.hf]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    forgetHuggingFace();
    await new Promise((r) => a.close(r));
    await new Promise((r) => b.close(r));
  });

  it("a pretend Civitai sent on to another port of its machine is not followed: that is another service", async () => {
    // the key staying with the host first asked is shown above, with both hosts allowed
    await expect(civitaiGet<{ id: number }>("/api/v1/model-versions/1", "k-123")).rejects.toThrow(/inside your own network/);
    expect(seen).toEqual([{ at: "a", url: "/api/v1/model-versions/1", auth: "Bearer k-123" }]);
  });

  it("an answer sent on into the network is not followed, from either", async () => {
    await expect(civitaiGet("/api/v1/model-versions/2", "k-123")).rejects.toThrow(/inside your own network/);
    expect(await findOnHuggingFace("some_model_fp8.safetensors")).toEqual({ items: [], answered: false });
    expect(seen.every((s) => s.at === "a")).toBe(true);
  });
});

describe("a public name that points inside the network", () => {
  let inside: Server;
  let insidePort = 0;
  let asked = 0;
  // localtest.me and its like are public names whose address is 127.0.0.1: here the resolver is told so, offline
  const resolveTo = (address: string) =>
    vi.spyOn(dns, "lookup").mockImplementation(((_host: string, options: unknown, done: (err: null, found: unknown) => void) => {
      const family = address.includes(":") ? 6 : 4;
      done(null, (options as { all?: boolean }).all ? [{ address, family }] : address);
    }) as unknown as typeof dns.lookup);
  beforeEach(async () => {
    asked = 0;
    inside = createServer((_req, res) => {
      asked++;
      res.end("the router's page");
    });
    await new Promise<void>((r) => inside.listen(0, "127.0.0.1", () => r()));
    insidePort = (inside.address() as AddressInfo).port;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise((r) => inside.close(r));
  });

  it("is refused where the connection is made, before anything is sent", async () => {
    resolveTo("127.0.0.1");
    await expect(fetchPublic(`http://localtest.me:${insidePort}/admin`, {})).rejects.toThrow(/inside your own network \(localtest\.me is 127\.0\.0\.1\)/);
    expect(asked).toBe(0);
  });

  it("is refused at the end of a redirect too", async () => {
    const from = createServer((_req, res) => {
      res.writeHead(302, { location: `http://rebind.example:${insidePort}/admin` });
      res.end();
    });
    await new Promise<void>((r) => from.listen(0, "127.0.0.1", () => r()));
    const fromUrl = `http://127.0.0.1:${(from.address() as AddressInfo).port}`;
    try {
      resolveTo("::ffff:127.0.0.1");
      await expect(fetchPublic(`${fromUrl}/model.safetensors`, {}, [fromUrl])).rejects.toThrow(/inside your own network/);
      expect(asked).toBe(0);
    } finally {
      await new Promise((r) => from.close(r));
    }
  });

  it("lets a name through whose addresses are all on the internet", async () => {
    resolveTo("93.184.215.14");
    const one = await new Promise<unknown[]>((r) => insideRefusingLookup("example.com", {}, (err, address, family) => r([err, address, family])));
    expect(one).toEqual([null, "93.184.215.14", 4]);
    const all = await new Promise<unknown[]>((r) => insideRefusingLookup("example.com", { all: true }, (err, address) => r([err, address])));
    expect(all).toEqual([null, [{ address: "93.184.215.14", family: 4 }]]);
  });
});
