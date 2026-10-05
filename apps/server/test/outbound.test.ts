import { describe, expect, it } from "vitest";
import { assertPublicUrl, isPrivateAddress, isPrivateHost } from "../src/outbound";

describe("where the server may fetch from", () => {
  it("knows the addresses of this machine and its network", () => {
    for (const ip of ["127.0.0.1", "127.8.8.8", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "::", "fe80::1", "fd00::1", "fc00::abcd", "::ffff:192.168.1.1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "192.167.1.1", "2606:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
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
    expect(assertPublicUrl("http://127.0.0.1:8188/x", ["127.0.0.1"]).port).toBe("8188");
    expect(assertPublicUrl("http://[::1]:9/x", ["::1"]).hostname).toBe("[::1]");
  });
});
