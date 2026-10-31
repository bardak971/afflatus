import { describe, expect, it } from "vitest";
import { firstFree, GUESS_ERROR, gpuKey, rankGpus, roughSpeed, TIE, type RankAsk, type RankOffer } from "../src/gpuRank";

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
    expect(roughSpeed("NVIDIA RTX 6000 Ada Generation")).toBe(0.7);
    expect(roughSpeed("NVIDIA A40")).toBe(0.39);
    expect(roughSpeed("L40S")).toBe(0.85);
    expect(roughSpeed("NVIDIA L40")).toBe(0.75);
    expect(roughSpeed("L4")).toBe(0.3);
    expect(roughSpeed("RTX A6000")).toBe(0.5);
    expect(roughSpeed("RTX A2000")).toBeNull();
    expect(roughSpeed("NVIDIA GeForce RTX 4090 Laptop GPU")).toBeNull();
  });
});

describe("the ranking", () => {
  it("value: cost a render, the time learned on the home 4090 and guessed elsewhere from it", () => {
    const r = rankGpus(OFFERS, RENDERS, HOME, ASK);
    const by = Object.fromEntries(r.map((g) => [g.name, g]));
    expect(by["RTX 4090"]).toMatchObject({ seconds: 100, learned: 30, timeSaid: "from 30 of your renders", fit: "yes", stock: "free" });
    expect(by["H100 SXM"]).toMatchObject({ seconds: Math.round(100 / 1.9), learned: 0, guess: true });
    expect(by["A40"]!.seconds).toBe(Math.round(100 / roughSpeed("A40")!));
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

  it("guesses against a rented card before a home one: the home card spills larger models and reads slower than the table says", () => {
    // the owner's 4070 Ti at the common pace on more renders, an A40 pod at 0.76 though the table puts it under the 4070 Ti
    const learned = { gpus: [{ gpu: "NVIDIA GeForce RTX 4070 Ti", pace: 1, renders: 40 }, { gpu: "NVIDIA A40", pace: 0.76, renders: 6 }], rented: ["NVIDIA A40"], oom: [] };
    const h100 = rankGpus(OFFERS, RENDERS, learned, ASK).find((g) => g.name === "H100 SXM")!;
    expect(h100).toMatchObject({ guess: true, seconds: Math.round((100 * 0.76 * roughSpeed("A40")!) / roughSpeed("H100 SXM")!) });
    const home = rankGpus(OFFERS, RENDERS, { ...learned, rented: [] }, ASK).find((g) => g.name === "H100 SXM")!;
    expect(home.seconds).toBe(Math.round((100 * roughSpeed("RTX 4070 Ti")!) / roughSpeed("H100 SXM")!));
  });

  it("adds a pod's model load as it is: the load is the pod's disk, not its card, and is not read at the GPU's pace", () => {
    // 100 s of rendering at the common pace, and 50 s a pod takes to load the model from its volume
    const r = rankGpus(OFFERS, [{ ...RENDERS[0]!, loadMs: 50_000 }], HOME, ASK);
    const by = Object.fromEntries(r.map((g) => [g.name, g]));
    expect(by["RTX 4090"]!.seconds).toBe(150);
    expect(by["H100 SXM"]!.seconds).toBe(Math.round(100 / 1.9 + 50));
    expect(by["A40"]!.seconds).toBe(Math.round(100 / roughSpeed("A40")! + 50));
  });

  it("with no GPU learned, no time: value falls back to the price", () => {
    const r = rankGpus(OFFERS, RENDERS, { gpus: [], oom: [] }, ASK);
    expect(r.every((g) => g.seconds === null && g.cost === null && g.timeSaid === "not known yet" && !g.guess)).toBe(true);
    expect(r.map((g) => g.name)).toEqual(["L4", "A40", "RTX 4090", "H100 SXM"]);
    // nor with renders whose time is not known
    expect(rankGpus(OFFERS, [{ files: [], ms: null }], HOME, ASK).every((g) => g.seconds === null)).toBe(true);
  });

  it("a GPU the table does not know comes after those with a time, by its price", () => {
    const r = rankGpus([...OFFERS, offer("NVIDIA RTX A2000", "RTX A2000", 0.12, 12)], RENDERS, HOME, ASK);
    expect(r.at(-1)).toMatchObject({ name: "RTX A2000", seconds: null, timeSaid: "not known yet", fit: "yes" });
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

  it("a GPU's pace from fewer than 3 renders is a guess: the live 2000 Ada (1 render, pace 1) ranks under the A40", () => {
    // the owner's record on 10-15: the 4070 Ti at home, an A40 pod (13 renders), a 2000 Ada pod (1 render, compared with
    // nothing: pace 1); a SCAIL window of 230 s at the common pace
    const live = { gpus: [{ gpu: "NVIDIA GeForce RTX 4070 Ti", pace: 1.0085, renders: 122 }, { gpu: "NVIDIA RTX 2000 Ada Generation", pace: 1, renders: 1 }, { gpu: "NVIDIA A40", pace: 0.762, renders: 13 }], oom: [] };
    const offers = [offer("NVIDIA A40", "A40", 0.44, 48), offer("NVIDIA RTX 2000 Ada Generation", "RTX 2000 Ada", 0.24, 16)];
    const scail = [{ files: [], ms: 230_046 }];
    for (const learned of [live, { ...live, gpus: live.gpus.filter((g) => g.renders > 1) }]) {
      const r = rankGpus(offers, scail, learned, ASK);
      const by = Object.fromEntries(r.map((g) => [g.name, g]));
      expect(by["A40"]).toMatchObject({ seconds: Math.round(230.046 * 0.762), learned: 13, timeSaid: "from 13 of your renders" });
      // a guess from the 4070 Ti (the anchor, 122 renders): 0.55 against 0.2 of a 4090
      expect(by["RTX 2000 Ada"]).toMatchObject({ seconds: Math.round((230.046 * 1.0085 * 0.55) / 0.2), learned: 0, guess: true });
      expect(r.map((g) => g.name)).toEqual(["A40", "RTX 2000 Ada"]);
      expect(by["RTX 2000 Ada"]!.cost!).toBeGreaterThan(by["A40"]!.cost!);
    }
    // one slow render on a GPU never ranks it as learned, nor two
    const two = rankGpus(OFFERS, RENDERS, { gpus: [...HOME.gpus, { gpu: "NVIDIA A40", pace: 1.5, renders: 2 }], oom: [] }, ASK).find((g) => g.name === "A40")!;
    expect(two).toMatchObject({ seconds: Math.round(100 / roughSpeed("A40")!), learned: 0, guess: true });
  });

  it("home alone: the table's GPUs get a time from the owner's card, whether the record lists it or not", () => {
    const offers = [offer("NVIDIA GeForce RTX 4090", "RTX 4090", 0.69), offer("NVIDIA A40", "A40", 0.44, 48), offer("NVIDIA RTX A4000", "RTX A4000", 0.17, 16), offer("NVIDIA GeForce RTX 4070 Ti", "RTX 4070 Ti", 0.2, 12)];
    const ms = 510_000;
    // the record's paces with every GPU (the home card compared with nothing, at 1), or with the compared ones alone (none)
    const listed = { gpus: [{ gpu: "cuda:0 NVIDIA GeForce RTX 4070 Ti : cudaMallocAsync", pace: 1, renders: 122 }], oom: [] };
    const alone = { gpus: [], oom: [], rendered: [{ gpu: "cuda:0 NVIDIA GeForce RTX 4070 Ti : cudaMallocAsync", renders: 100 }, { gpu: "NVIDIA GeForce RTX 4070 Ti", renders: 22 }] };
    for (const learned of [listed, alone]) {
      const by = Object.fromEntries(rankGpus(offers, [{ files: [], ms }], learned, ASK).map((g) => [g.name, g]));
      expect(by["RTX 4070 Ti"]).toMatchObject({ seconds: 510, learned: 122, timeSaid: "from 122 of your renders" });
      expect(by["RTX 4090"]).toMatchObject({ seconds: Math.round(510 * 0.55), guess: true });
      expect(by["A40"]).toMatchObject({ seconds: Math.round((510 * 0.55) / roughSpeed("A40")!), guess: true });
      expect(by["RTX A4000"]).toMatchObject({ seconds: Math.round((510 * 0.55) / 0.27), guess: true });
    }
    // two GPUs never compared: neither is the common pace, nothing is told
    const two = { gpus: [], oom: [], rendered: [{ gpu: "NVIDIA GeForce RTX 4070 Ti", renders: 50 }, { gpu: "NVIDIA A40", renders: 2 }] };
    expect(rankGpus(offers, [{ files: [], ms }], two, ASK).every((g) => g.seconds === null)).toBe(true);
    // the owner's card and the common pod cards are in the table
    for (const name of ["RTX 4060", "RTX 4060 Ti", "RTX 4070", "RTX 4070 Ti", "RTX 4070 SUPER", "RTX 3060", "RTX 3070", "RTX 5070", "RTX 5080", "RTX A4000", "RTX A4500"]) expect(roughSpeed(name)).not.toBeNull();
    expect(roughSpeed("RTX 4070 Ti")).toBe(0.55);
    expect(roughSpeed("RTX 4070 SUPER")).toBe(0.5);
    expect(roughSpeed("RTX 4070")).toBe(0.42);
  });

  it("a deploy's own cost: the user's usual boot and idle at each GPU's price", () => {
    const r = rankGpus(OFFERS, RENDERS, { ...HOME, overheadMs: 12 * 60_000 }, ASK);
    expect(r.find((g) => g.name === "A40")!.overhead).toBeCloseTo((0.44 * 12) / 60, 10);
    expect(r.find((g) => g.name === "H100 SXM")!.overhead).toBeCloseTo((2.69 * 12) / 60, 10);
    expect(rankGpus(OFFERS, RENDERS, HOME, ASK).every((g) => g.overhead === null)).toBe(true);
  });

  it("value counts a deploy's overhead and the renders waiting: with few renders, the cheaper hour wins (K-3)", () => {
    // a $2/h GPU at 30 s a render, a $0.50/h one at 150 s, learned; 10 min of usual boot and idle
    const offers = [offer("NVIDIA H100 80GB HBM3", "H100 SXM", 2, 80), offer("NVIDIA A40", "A40", 0.5, 48)];
    const learned = { gpus: [{ gpu: "NVIDIA H100 80GB HBM3", pace: 0.3, renders: 10 }, { gpu: "NVIDIA A40", pace: 1.5, renders: 10 }], oom: [] };
    const one = [{ files: [], ms: 100_000 }];
    // per render the H100 is cheaper (1.7 ¢ against 2.1 ¢): without the overhead known, it ranks first
    expect(rankGpus(offers, one, learned, ASK).map((g) => g.name)).toEqual(["H100 SXM", "A40"]);
    // one render and the overhead: $0.35 against $0.10 for the session, the A40 first and the pick
    const withOverhead = { ...learned, overheadMs: 10 * 60_000 };
    const r = rankGpus(offers, one, withOverhead, ASK);
    expect(r.map((g) => g.name)).toEqual(["A40", "H100 SXM"]);
    expect(firstFree(r)?.name).toBe("A40");
    // with many renders waiting the per-render cost weighs most again: 200 renders, $3.67 against $4.25
    const many = Array.from({ length: 200 }, () => ({ files: [], ms: 100_000 }));
    expect(rankGpus(offers, many, withOverhead, ASK).map((g) => g.name)).toEqual(["H100 SXM", "A40"]);
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

describe("$ per render (card #201)", () => {
  // the #201 pod series on H3 Video: the L40S at the common pace (61 s a warm render), the A40 104 s, the 6000 Ada 71 s
  const H3 = "minimax-h3";
  const A40 = offer("NVIDIA A40", "A40", 0.601, 48);
  const L40S = offer("NVIDIA L40S", "L40S", 1.101, 48);
  const ADA = offer("NVIDIA RTX 6000 Ada Generation", "RTX 6000 Ada", 1.001, 48);
  const h3 = [{ files: [], ms: 61_000, family: H3 }];
  const measured = {
    gpus: [
      { gpu: "NVIDIA L40S", pace: 1, renders: 3, families: { [H3]: 1 } },
      // fast against the L40S overall (SDXL, say), slow on H3
      { gpu: "NVIDIA A40", pace: 0.5, renders: 20, families: { [H3]: 104 / 61 } },
      { gpu: "NVIDIA RTX 6000 Ada Generation", pace: 71 / 61, renders: 3, families: { [H3]: 71 / 61 } },
    ],
    rented: ["NVIDIA L40S"],
    oom: [],
  };

  it("reads each card at its pace on the form waiting: the A40, fast overall, is ranked at its H3 time", () => {
    const by = Object.fromEntries(rankGpus([A40, L40S, ADA], h3, measured, ASK).map((g) => [g.name, g]));
    expect(by["A40"]).toMatchObject({ seconds: 104, learned: 20, guess: false });
    expect(by["L40S"]).toMatchObject({ seconds: 61, learned: 3 });
    expect(by["RTX 6000 Ada"]).toMatchObject({ seconds: 71 });
    expect(by["A40"]!.perRender).toBeCloseTo((0.601 * 104) / 3600, 10);
    // another form: its pace overall, the A40 then the fastest and the cheapest
    const flux = rankGpus([A40, L40S, ADA], [{ files: [], ms: 61_000, family: "flux" }], measured, ASK);
    expect(flux.find((g) => g.name === "A40")!.seconds).toBe(Math.round(61 * 0.5));
    expect(flux[0]!.name).toBe("A40");
    // several forms waiting: each at its own pace, their mean
    const both = rankGpus([A40], [...h3, { files: [], ms: 61_000, family: "flux" }], measured, ASK);
    expect(both[0]!.seconds).toBe(Math.round((104 + 30.5) / 2));
  });

  it("a tie within 10 % a render goes to the faster card: the L40S before the A40, the 6000 Ada after", () => {
    // $0.0173 (A40, 104 s), $0.0187 (L40S, 61 s: 7.5 % dearer), $0.0197 (6000 Ada: 14 % dearer than the A40)
    const r = rankGpus([A40, L40S, ADA], h3, measured, ASK);
    expect(r.map((g) => g.name)).toEqual(["L40S", "A40", "RTX 6000 Ada"]);
    expect(firstFree(r)?.name).toBe("L40S");
    // the Costs tab's order, without the tie: the cheapest a render first
    expect(rankGpus([A40, L40S, ADA], h3, measured, { ...ASK, ties: false }).map((g) => g.name)).toEqual(["A40", "L40S", "RTX 6000 Ada"]);
    // fast and cheap are not value: no tie there
    expect(rankGpus([A40, L40S, ADA], h3, measured, { ...ASK, mode: "cheap" }).map((g) => g.name)).toEqual(["A40", "RTX 6000 Ada", "L40S"]);
  });

  it("at 9 % dearer the faster card is first, at 11 % the cheaper one", () => {
    // a card at the common pace for $0.36/h (1 ¢ a render of 100 s), one twice as fast whose hour makes it 9 % or 11 % dearer
    const learned = { gpus: [{ gpu: "NVIDIA A40", pace: 1, renders: 10 }, { gpu: "NVIDIA L40S", pace: 0.5, renders: 10 }], oom: [] };
    const at = (dearer: number) => rankGpus([offer("NVIDIA A40", "A40", 0.36, 48), offer("NVIDIA L40S", "L40S", 0.36 * 2 * (1 + dearer), 48)], [{ files: [], ms: 100_000 }], learned, ASK).map((g) => g.name);
    expect(TIE).toBe(0.1);
    expect(at(0.09)).toEqual(["L40S", "A40"]);
    expect(at(0.11)).toEqual(["A40", "L40S"]);
    // dearer and slower within 10 %: never first
    const slow = rankGpus([offer("NVIDIA A40", "A40", 0.36, 48), offer("NVIDIA L40S", "L40S", 0.18 * 1.05, 48)], [{ files: [], ms: 100_000 }], { gpus: [{ gpu: "NVIDIA A40", pace: 1, renders: 10 }, { gpu: "NVIDIA L40S", pace: 2, renders: 10 }], oom: [] }, ASK);
    expect(slow.map((g) => g.name)).toEqual(["A40", "L40S"]);
  });

  it("a card never rendered on is a guess counted 30 % dearer: it wins only when clearly cheaper, and never a tie", () => {
    const learned = { gpus: [measured.gpus[0]!], rented: ["NVIDIA L40S"], oom: [] };
    const l40s = (1.101 * 61) / 3600;
    // the 6000 Ada guessed from the L40S by the table: 61 s × 0.85 / 0.7
    const adaSeconds = (61 * roughSpeed("L40S")!) / roughSpeed("RTX 6000 Ada")!;
    const priced = (share: number) => offer("NVIDIA RTX 6000 Ada Generation", "RTX 6000 Ada", (l40s * share * 3600) / adaSeconds, 48);
    const rank = (share: number) => rankGpus([L40S, priced(share)], h3, learned, ASK);
    const ada = rank(0.8).find((g) => g.name === "RTX 6000 Ada")!;
    expect(ada).toMatchObject({ guess: true, learned: 0, seconds: Math.round(adaSeconds), timeSaid: "a guess from your L40S's renders, may be 30 % off" });
    expect(ada.perRender).toBeCloseTo(l40s * 0.8, 10);
    expect(GUESS_ERROR).toBe(0.3);
    // 20 % cheaper by its guess: counted 4 % dearer, behind
    expect(rank(0.8).map((g) => g.name)).toEqual(["L40S", "RTX 6000 Ada"]);
    // 30 % cheaper: counted 9 % cheaper, a tie, which a guess never wins
    expect(rank(0.7).map((g) => g.name)).toEqual(["L40S", "RTX 6000 Ada"]);
    // 40 % cheaper: counted 22 % cheaper, first
    expect(rank(0.6).map((g) => g.name)).toEqual(["RTX 6000 Ada", "L40S"]);
    // every card a guess: their order as their guesses say
    const guesses = rankGpus([A40, L40S, ADA], h3, { gpus: [{ gpu: "NVIDIA GeForce RTX 4090", pace: 1, renders: 30 }], oom: [] }, { ...ASK, ties: false });
    expect(guesses.every((g) => g.guess)).toBe(true);
    expect(guesses.map((g) => g.perRender)).toEqual([...guesses.map((g) => g.perRender)].sort((a, b) => a! - b!));
  });

  it("a deploy's overhead is shared by every render waiting, not by the few the ranking reads", () => {
    // 10 min of boot, fetch and idle; the server hands the first renders of the line alone, and says how many wait
    const learned = { ...measured, overheadMs: 10 * 60_000 };
    const one = rankGpus([A40, L40S], h3, learned, ASK);
    const a40 = one.find((g) => g.name === "A40")!;
    expect(a40.overhead).toBeCloseTo(0.601 / 6, 10);
    expect(a40.perRender).toBeCloseTo(a40.cost! + a40.overhead!, 10);
    // one render: the cheaper hour carries less overhead, the A40 well first
    expect(one.map((g) => g.name)).toEqual(["A40", "L40S"]);
    // 200 waiting: a twentieth of a cent each, and the L40S within 10 % again: the faster first
    const many = rankGpus([A40, L40S], h3, learned, { ...ASK, waiting: 200 });
    expect(many.find((g) => g.name === "A40")!.perRender).toBeCloseTo(a40.cost! + a40.overhead! / 200, 10);
    expect(many.map((g) => g.name)).toEqual(["L40S", "A40"]);
    // no session yet: a render's own cost
    expect(rankGpus([A40], h3, measured, ASK)[0]!.perRender).toBeCloseTo((0.601 * 104) / 3600, 10);
  });
});
