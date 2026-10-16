import { describe, expect, it } from "vitest";
import { publicPlainHttp } from "../src/screens/settings/plainHttp";

/** A ComfyUI address out on the internet over plain http (Settings › ComfyUI's warning): anyone who finds it can run code there. */

describe("a public address over plain http", () => {
  it("is a public name or IPv4 address over http, not over https", () => {
    expect(publicPlainHttp("http://comfy.example.com:8188")).toBe(true);
    expect(publicPlainHttp("http://203.0.113.7:8188")).toBe(true);
    expect(publicPlainHttp("https://comfy.example.com")).toBe(false);
    expect(publicPlainHttp("not an address")).toBe(false);
  });

  it("leaves out loopback, the private ranges, Tailscale's, link-local and the network's own names", () => {
    for (const url of ["http://127.0.0.1:8188", "http://localhost:8188", "http://10.0.0.5:8188", "http://172.16.0.1", "http://172.31.255.1", "http://192.168.1.20:8188", "http://100.64.0.1", "http://100.127.1.1", "http://169.254.1.1", "http://gpu-box:8188", "http://gpu.local", "http://gpu.lan", "http://gpu.internal"]) {
      expect(publicPlainHttp(url), url).toBe(false);
    }
    expect(publicPlainHttp("http://172.32.0.1")).toBe(true);
    expect(publicPlainHttp("http://100.128.0.1")).toBe(true);
  });

  // review S-8: fc/fd were read on any host, and an IPv6 literal (no dot) counted as a name of the network
  it("reads the IPv6 private ranges on IPv6 literals only", () => {
    expect(publicPlainHttp("http://fdgpu.example.com:8188")).toBe(true);
    expect(publicPlainHttp("http://fcloud.example.com")).toBe(true);
    expect(publicPlainHttp("http://[2a01:4f8::1]:8188")).toBe(true);
    expect(publicPlainHttp("http://[fc::1]")).toBe(true);
    for (const url of ["http://[::1]:8188", "http://[fd7a:115c:a1e0::1]:8188", "http://[fc00::1]", "http://[fe80::1]", "http://[febf::1]", "http://[::ffff:10.0.0.5]:8188", "http://[::ffff:192.168.1.2]"]) {
      expect(publicPlainHttp(url), url).toBe(false);
    }
    expect(publicPlainHttp("http://[::ffff:203.0.113.7]")).toBe(true);
    expect(publicPlainHttp("http://[fec0::1]")).toBe(true);
  });
});
