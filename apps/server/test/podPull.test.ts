import { describe, expect, it } from "vitest";
import { pullKept, pullOf, type PullLine } from "../src/podPull";
import { buildOf, imageLayers } from "../src/podImage";

/**
 * A pod's image pull as RunPod's system log tells it (podPull.ts): how far, how fast, how long left, from the log's lines
 * against the image's layers. The pulls here are made as RunPod logs one: a "Downloading" line every ~5.15 MB of a layer,
 * the layers downloading together, each extracted in its order once it is in.
 */

const T0 = Date.parse("2026-10-19T21:20:43Z");
const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
const PER = 5.15e6;

/**
 * A pull's log: each layer downloading from the start at its own speed (MB/s), capped by `total` (MB/s) shared among those
 * still coming; then extracted in order at `extract` (MB/s). Its end and each layer's times, as the true figures to test by.
 */
function pullLog(layers: Array<{ id: string; mb: number; mbps: number; had?: boolean }>, o: { total?: number; extract?: number } = {}) {
  const lines: PullLine[] = [];
  const say = (ms: number, line: string) => lines.push({ ts: iso(ms), line });
  say(T0, "create container ghcr.io/owner/afflatus-pod:0.1.27");
  say(T0, "0.1.27 Pulling from owner/afflatus-pod");
  for (const l of layers) say(T0, `${l.id} ${l.had ? "Already exists" : "Pulling fs layer"}`);
  // second by second: each layer still coming gets its own speed, the whole capped at `total`
  const left = new Map(layers.filter((l) => !l.had).map((l) => [l.id, l.mb * 1e6]));
  const lined = new Map<string, number>(layers.map((l) => [l.id, 0]));
  const doneAt = new Map<string, number>();
  for (let t = 0; left.size && t < 3600; t++) {
    const coming = [...left.keys()];
    const want = coming.map((id) => layers.find((l) => l.id === id)!.mbps * 1e6);
    const cap = (o.total ?? Infinity) * 1e6;
    const scale = Math.min(1, cap / want.reduce((n, w) => n + w, 0));
    coming.forEach((id, i) => {
      const got = Math.min(left.get(id)!, want[i]! * scale);
      const was = layers.find((l) => l.id === id)!.mb * 1e6 - left.get(id)!;
      for (let n = Math.floor(was / PER) + 1; n * PER <= was + got; n++) {
        say(T0 + t * 1000 + 500, `${id} Downloading`);
        lined.set(id, lined.get(id)! + 1);
      }
      left.set(id, left.get(id)! - got);
      if (left.get(id)! <= 1) {
        left.delete(id);
        doneAt.set(id, T0 + (t + 1) * 1000);
        say(T0 + (t + 1) * 1000, `${id} Verifying Checksum`);
        say(T0 + (t + 1) * 1000, `${id} Download complete`);
      }
    });
  }
  let at = T0;
  for (const l of layers.filter((x) => !x.had)) {
    at = Math.max(at, doneAt.get(l.id)!);
    say(at, `${l.id} Extracting`);
    at += (l.mb / (o.extract ?? 80)) * 1000;
    say(at, `${l.id} Pull complete`);
  }
  say(at, "Digest: sha256:00");
  say(at, `Status: ${layers.some((l) => !l.had) ? "Downloaded newer image" : "Image is up to date"} for ghcr.io/owner/afflatus-pod:0.1.27`);
  lines.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return { lines, end: at, image: layers.map((l) => ({ id: l.id, size: Math.round(l.mb * 1e6) })) };
}

describe("a pull's progress from RunPod's log", () => {
  // the 0.1.27 image's shape: a 3.7 GB torch layer and smaller ones, on a host that caps each stream at 35 MB/s
  const shape = [
    { id: "aaaaaaaaaaa1", mb: 28, mbps: 35 },
    { id: "aaaaaaaaaaa2", mb: 200, mbps: 35 },
    { id: "aaaaaaaaaaa3", mb: 3716, mbps: 35 },
    { id: "aaaaaaaaaaa4", mb: 444, mbps: 35 },
    { id: "aaaaaaaaaaa5", mb: 172, mbps: 35 },
  ];

  it("says its bytes, its speed and a time left close to the true one, then its extraction, then done", () => {
    const { lines, end, image } = pullLog(shape, { total: 100 });
    const bytes = image.reduce((n, l) => n + l.size, 0);
    for (const s of [20, 60, 90]) {
      const p = pullOf(lines, image, T0 + s * 1000);
      expect(p.phase).toBe("downloading");
      expect(p.bytes).toBe(bytes);
      expect(p.done).toBeGreaterThan(0);
      expect(p.done).toBeLessThan(bytes);
      // the slowest layer's own speed bounds it, not the whole's
      expect(Math.abs(p.leftMs! - (end - (T0 + s * 1000)))).toBeLessThan(0.15 * (end - T0));
    }
    const late = pullOf(lines, image, T0 + 60_000);
    expect(late.mbps).toBeGreaterThan(30);
    expect(late.mbps).toBeLessThan(110);
    const extracting = pullOf(lines, image, end - 10_000);
    expect(extracting.phase).toBe("extracting");
    expect(extracting.done).toBe(bytes);
    expect(extracting.leftMs).toBeLessThan(30_000);
    const done = pullOf(lines, image, end + 1000);
    expect(done).toMatchObject({ phase: "done", fresh: true, bytes, done: bytes, leftMs: 0 });
    // its download to its slowest layer (3.7 GB at 35 MB/s), its extraction after it
    expect(done.downloadMs! / 1000).toBeCloseTo(3716 / 35, -1);
    expect(done.extractMs).toBeGreaterThan(0);
  });

  it("measures a host's line by the layers already in, not by the usual 5.15 MB", () => {
    // a host whose log says a line every ~10 MB: the bytes in mid-layer read by its own measure
    const { lines, image } = pullLog(shape, { total: 100 });
    const halved = lines.filter((l, i) => !/ Downloading$/.test(l.line) || i % 2 === 0);
    const p = pullOf(halved, image, T0 + 60_000);
    const q = pullOf(lines, image, T0 + 60_000);
    expect(Math.abs(p.done - q.done) / q.done).toBeLessThan(0.1);
  });

  it("a host that had the image: not pulled; one that had some layers: only the others counted", () => {
    const cached = pullLog(shape.map((l) => ({ ...l, had: true })));
    expect(pullOf(cached.lines, cached.image, cached.end + 1000)).toMatchObject({ phase: "done", fresh: false, bytes: 0 });
    const some = pullLog(shape.map((l, i) => ({ ...l, had: i !== 2 })));
    const p = pullOf(some.lines, some.image, T0 + 30_000);
    expect(p.bytes).toBe(3716e6);
    expect(pullOf(some.lines, some.image, some.end + 1000).fresh).toBe(true);
  });

  it("before the host begins: waiting, nothing known; without the layers' sizes: only its stage", () => {
    expect(pullOf([{ ts: iso(T0), line: "create container ghcr.io/owner/afflatus-pod:0.1.27" }], null, T0 + 5000)).toMatchObject({ phase: "waiting", fresh: null, leftMs: null });
    const { lines } = pullLog(shape);
    expect(pullOf(lines, null, T0 + 30_000)).toMatchObject({ phase: "downloading", bytes: 0, mbps: null, leftMs: null, fresh: true });
  });

  it("ends as RunPod's own log ends a pull: at its container's start line, else at its container's start", () => {
    // as 5 of 6 real logs (2026-10-25): no Digest nor Status, the big layer's "Download complete" and the last layer's
    // "Pull complete" never said
    const { lines, end, image } = pullLog(shape, { total: 100 });
    const real = lines.filter((l) => !/^(Digest|Status):/.test(l.line) && l.line !== "aaaaaaaaaaa3 Download complete" && l.line !== "aaaaaaaaaaa5 Pull complete");
    const bytes = image.reduce((n, l) => n + l.size, 0);
    expect(pullOf(real, image, end + 60_000).phase).toBe("extracting");
    const started = [...real, { ts: iso(end), line: "start container for ghcr.io/owner/afflatus-pod:0.1.27: begin" }];
    const done = pullOf(started, image, end + 1000);
    expect(done).toMatchObject({ phase: "done", fresh: true, bytes, leftMs: 0 });
    // the big layer in by its extraction's start, its "Download complete" lost
    expect(done.downloadMs! / 1000).toBeCloseTo(3716 / 35, -1);
    expect(done.mbps).toBeGreaterThan(30);
    // a log read no further than its last extraction: ended by the container's start RunPod said, never before it
    const cut = real.filter((l) => Date.parse(l.ts) < end - 2000);
    expect(pullOf(cut, image, end + 1000, end + 5000).phase).toBe("extracting");
    expect(pullOf(cut, image, end + 6000, end + 5000)).toMatchObject({ phase: "done", fresh: true, bytes });
    // no line of it at all: nothing said, whatever the container
    expect(pullOf([], image, end + 6000, end).phase).toBe("waiting");
  });

  it("keeps one progress line in 15 s per layer for a saved log, saying how many it stands for", () => {
    const { lines } = pullLog(shape);
    const kept = pullKept(lines);
    expect(kept.length).toBeLessThan(lines.length / 4);
    // every line but the progress repeats: each layer's download and pull complete stay
    expect(kept.filter((l) => / (Pull complete|Download complete)$/.test(l.line))).toHaveLength(2 * shape.length);
    expect(kept.some((l) => /aaaaaaaaaaa3 Downloading \(\d+ lines since the last\)/.test(l.line))).toBe(true);
    expect(kept.at(-1)!.line).toMatch(/^Status: Downloaded newer image/);
  });
});

describe("the image's build and layers", () => {
  it("names the CUDA build of an Afflatus image, nothing for another", () => {
    expect(buildOf("ghcr.io/owner/afflatus-pod:0.1.27")).toBe("13.0");
    expect(buildOf("ghcr.io/owner/afflatus-pod:0.1.27-cu128")).toBe("12.8");
    expect(buildOf("runpod/comfyui:cuda12.8")).toBeNull();
    expect(buildOf("")).toBeNull();
    expect(buildOf(null)).toBeNull();
  });

  it("reads the amd64 layers through a multi-platform index; null where the registry does not say", async () => {
    const answers: Record<string, unknown> = {
      "/token": { token: "t" },
      "/manifests/0.1.27": { manifests: [{ digest: "sha256:arm", platform: { os: "linux", architecture: "arm64" } }, { digest: "sha256:amd", platform: { os: "linux", architecture: "amd64" } }] },
      "/manifests/sha256:amd": { layers: [{ digest: "sha256:0510507d6828aaaa", size: 3716500000 }, { digest: "sha256:76332ebdc230bbbb", size: 444000000 }] },
    };
    const fetcher = (async (url: string) => {
      const key = Object.keys(answers).find((k) => String(url).split("?")[0]!.endsWith(k));
      return key ? new Response(JSON.stringify(answers[key])) : new Response("", { status: 404 });
    }) as typeof fetch;
    expect(await imageLayers("ghcr.io/owner/afflatus-pod:0.1.27", fetcher)).toEqual([{ id: "0510507d6828", size: 3716500000 }, { id: "76332ebdc230", size: 444000000 }]);
    expect(await imageLayers("ghcr.io/owner/afflatus-pod:9.9.9", fetcher)).toBeNull();
    expect(await imageLayers("quay.io/x/y:1", fetcher)).toBeNull();
  });
});
