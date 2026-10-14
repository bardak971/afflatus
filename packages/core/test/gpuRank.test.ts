import { describe, expect, it } from "vitest";
import { firstFree, gpuKey, rankGpus, roughSpeed, type RankAsk, type RankOffer } from "../src/gpuRank";

const offer = (id: string, name: string, price: number, memory = 24, availability: RankOffer["availability"] = "HIGH", dataCenters: RankOffer["dataCenters"] = [{ id: "EU-RO-1", availability }]): RankOffer => ({ id, name, price, memory, availability, dataCenters });
const OFFERS = [
  offer("NVIDIA GeForce RTX 4090", "RTX 4090", 0.69),
  offer("NVIDIA H100 80GB HBM3", "H100 SXM", 2.69, 80),
  offer("NVIDIA A40", "A40", 0.44, 48),
  offer("NVIDIA L4", "L4", 0.43, 24),
];
const ASK: RankAsk = { mode: "value", ceiling: 5, leftOut: [], dataCenter: null };
// one render of 100 s at the common pace, its model 12 GB
const RENDERS = [{ files: [{ file: "flux.safetensors", size: 12e9 }], ms: 100_000 }];
const HOME = { gpus: [{ gpu: "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync", pace: 1, renders: 30 }], oom: [] };

describe("a GPU's name", () => {
  it("comes down to the same words from ComfyUI and from RunPod", () => {
    expect(gpuKey("cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync")).toBe("rtx 4090");
    expect(gpuKey("NVIDIA GeForce RTX 4090")).toBe("rtx 4090");
    expect(gpuKey("RTX 4090")).toBe("rtx 4090");
    expect(gpuKey("NVIDIA RTX 6000 Ada Generation")).toBe("rtx 6000 ada");
    expect(roughSpeed("NVIDIA RTX 6000 Ada Generation")).toBe(0.95);
    expect(roughSpeed("L40S")).toBe(0.85);
    expect(roughSpeed("NVIDIA L40")).toBe(0.75);
    expect(roughSpeed("L4")).toBe(0.3);
    expect(roughSpeed("RTX A6000")).toBe(0.5);
    expect(roughSpeed("RTX A4000")).toBeNull();
    expect(roughSpeed("NVIDIA GeForce RTX 4090 Laptop GPU")).toBeNull();
  });
});

describe("the ranking", () => {
  it("value: cost a render, the time learned on the home 4090 and guessed elsewhere from it", () => {
    const r = rankGpus(OFFERS, RENDERS, HOME, ASK);
    const by = Object.fromEntries(r.map((g) => [g.name, g]));
    expect(by["RTX 4090"]).toMatchObject({ seconds: 100, learned: 30, timeSaid: "from 30 of your renders", fit: "yes", stock: "free" });
    expect(by["H100 SXM"]).toMatchObject({ seconds: Math.round(100 / 1.9), learned: 0, timeSaid: "a guess" });
    expect(by["A40"]!.seconds).toBe(Math.round(100 / 0.45));
    expect(by["RTX 4090"]!.cost).toBeCloseTo((0.69 * 100) / 3600);
    // value: the 4090 (1.9 ¢ a render), the A40 (2.7 ¢), the H100 (3.9 ¢), the L4 (4.0 ¢)
    expect(r.map((g) => g.name)).toEqual(["RTX 4090", "A40", "H100 SXM", "L4"]);
    expect(r.map((g) => g.rank)).toEqual([1, 2, 3, 4]);
  });

  it("fast: the time; cheap: the price an hour", () => {
    expect(rankGpus(OFFERS, RENDERS, HOME, { ...ASK, mode: "fast" }).map((g) => g.name)).toEqual(["H100 SXM", "RTX 4090", "A40", "L4"]);
    expect(rankGpus(OFFERS, RENDERS, HOME, { ...ASK, mode: "cheap" }).map((g) => g.name)).toEqual(["L4", "A40", "RTX 4090", "H100 SXM"]);
  });

  it("a pace learned on a rented GPU wins over the table, and over the anchor", () => {
    const learned = { gpus: [...HOME.gpus, { gpu: "NVIDIA H100 80GB HBM3", pace: 0.8, renders: 4 }], oom: [] };
    const h100 = rankGpus(OFFERS, RENDERS, learned, ASK).find((g) => g.name === "H100 SXM")!;
    expect(h100).toMatchObject({ seconds: 80, learned: 4, timeSaid: "from 4 of your renders" });
  });

  it("with no GPU learned, no time: value falls back to the price", () => {
    const r = rankGpus(OFFERS, RENDERS, { gpus: [], oom: [] }, ASK);
    expect(r.every((g) => g.seconds === null && g.cost === null && g.timeSaid === "not known yet")).toBe(true);
    expect(r.map((g) => g.name)).toEqual(["L4", "A40", "RTX 4090", "H100 SXM"]);
    // nor with renders whose time is not known
    expect(rankGpus(OFFERS, [{ files: [], ms: null }], HOME, ASK).every((g) => g.seconds === null)).toBe(true);
  });

  it("a GPU the table does not know comes after those with a time, by its price", () => {
    const r = rankGpus([...OFFERS, offer("NVIDIA RTX A4000", "RTX A4000", 0.17, 16)], RENDERS, HOME, ASK);
    expect(r.at(-1)).toMatchObject({ name: "RTX A4000", seconds: null, timeSaid: "not known yet", fit: "yes" });
  });

  it("the usable first: left out, over the ceiling and too small go after, each said", () => {
    const r = rankGpus(OFFERS, RENDERS, HOME, { ...ASK, ceiling: 1, leftOut: ["NVIDIA GeForce RTX 4090"] });
    expect(r.map((g) => [g.name, g.fits])).toEqual([["A40", "yes"], ["L4", "yes"], ["RTX 4090", "left out by you"], ["H100 SXM", "over your $1.00/h"]]);
    // a model file larger than the card's memory
    const big = rankGpus(OFFERS, [{ files: [{ file: "huge.safetensors", size: 30 * 1024 ** 3 }], ms: 100_000 }], HOME, ASK);
    expect(big.filter((g) => g.fit === "small").map((g) => g.name).sort()).toEqual(["L4", "RTX 4090"]);
    expect(big.find((g) => g.name === "L4")!.fits).toBe("too small for these files");
    expect(big.slice(0, 2).map((g) => g.name)).toEqual(["A40", "H100 SXM"]);
  });

  it("too small where that file ran out of memory on that GPU before, whatever its size", () => {
    const learned = { ...HOME, oom: [{ gpu: "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync", file: "models/FLUX.safetensors" }] };
    const r = rankGpus(OFFERS, RENDERS, learned, ASK);
    expect(r.find((g) => g.name === "RTX 4090")!.fit).toBe("small");
    // another file: not
    expect(rankGpus(OFFERS, [{ files: [{ file: "sdxl.safetensors", size: 7e9 }], ms: 10_000 }], learned, ASK).find((g) => g.name === "RTX 4090")!.fit).toBe("yes");
  });

  it("stock in the pinned data center, else anywhere; the first free usable one is the pick", () => {
    const offers = [
      offer("NVIDIA GeForce RTX 4090", "RTX 4090", 0.69, 24, "HIGH", [{ id: "US-TX-3", availability: "HIGH" }, { id: "EU-RO-1", availability: "NONE" }]),
      offer("NVIDIA A40", "A40", 0.44, 48, "LOW", [{ id: "EU-RO-1", availability: "LOW" }]),
    ];
    const anywhere = rankGpus(offers, RENDERS, HOME, ASK);
    expect(anywhere.map((g) => [g.name, g.stock])).toEqual([["RTX 4090", "free"], ["A40", "a few free"]]);
    expect(firstFree(anywhere)?.name).toBe("RTX 4090");
    const pinned = rankGpus(offers, RENDERS, HOME, { ...ASK, dataCenter: "EU-RO-1" });
    expect(pinned.map((g) => [g.name, g.stock])).toEqual([["RTX 4090", "none free"], ["A40", "a few free"]]);
    expect(firstFree(pinned)?.name).toBe("A40");
    expect(firstFree(rankGpus(offers, RENDERS, HOME, { ...ASK, dataCenter: "EU-RO-1", leftOut: ["NVIDIA A40"] }))).toBeNull();
  });
});
