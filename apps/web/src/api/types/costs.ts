/** The Queue's Costs tab (GET /api/costs; the server's costs.ts): what the rented GPUs cost and where it went, and this PC's electricity. */

export type CostPart = "render" | "boot" | "fetch" | "idle" | "failed";
export type PartMs = Record<CostPart, number>;
/** Booting's parts: pulling the image, the node packs' installs, starting ComfyUI, a start that failed, and a boot not known in parts. */
export type BootPart = "pull" | "packs" | "comfy" | "startFailed" | "boot";
export type BootMs = Record<BootPart, number>;
export type ItemRef = { kind: "timeline" | "draft"; id: string; name: string };

/** A model where it ran: a pod's GPU, a GPU not tried yet (a guess from the GPU hunt's ranking), or one of this PC's machines. */
export interface RenderCostRow {
  key: string;
  model: string;
  file: string;
  where: "pod" | "guess" | "home";
  on: string;
  /** p50 (ms), from `renders` renders (0 for a guess). */
  ms: number | null;
  renders: number;
  /** USD a render: a pod's or a guess's. */
  usd: number | null;
  /** This PC's electricity a render, in the user's money; null without a price or a reading. */
  local: number | null;
  /** This PC's p50 energy a render (Wh); null when never read. */
  wh: number | null;
  best: boolean;
}

export interface CostAdvice {
  kind: CostPart | BootPart | "gpu";
  title: string;
  why: string;
  /** What it would have saved over the window (USD); null: no figure. */
  save: number | null;
}

export interface PodSession {
  id: string;
  machine: string;
  gpu: string | null;
  rate: number;
  from: number;
  to: number;
  open: boolean;
  usd: number;
  /** Its time by part (ms), adding up to its length. */
  parts: PartMs;
  /** Its Booting by part (ms), adding up to it; the step its start failed at; its node packs' installs, as its boot log said them. */
  boot: BootMs;
  startFailed: string | null;
  packs: Array<{ pack: string; ms: number }>;
  /** What was worked out rather than kept (an older session's boot, its files). */
  estimated: string[];
  why: string;
  idleMinutes: number;
  fetched: { files: number; bytes: number };
  renders: Array<{ id: string; at: number; ms: number; status: string; model: string; usd: number; item: ItemRef | null }>;
}

export interface ProjectCost {
  /** null: the Inbox. */
  id: string | null;
  name: string;
  usd: number;
  renders: number;
  timelines: number;
  drafts: number;
  items: Array<ItemRef & { usd: number; renders: number; models: string[] }>;
}

export interface HomeCost {
  machine: string;
  name: string;
  gpu: string | null;
  renders: number;
  /** Of them, those whose GPU power was read. */
  read: number;
  wh: number;
  avgW: number | null;
  cost: number | null;
}

export interface CostsView {
  from: number;
  to: number;
  step: number;
  times: number[];
  billed: boolean;
  billReadAt: number | null;
  /** A RunPod key or a rented pod: the pods' figures mean something. */
  runpod: boolean;
  month: number;
  today: { usd: number; sessions: number; ms: number };
  caps: { day: number; month: number };
  /** USD a day at this pace: the pods over the last 7 days, and storage. */
  pace7: number;
  storageDay: number;
  monthEnd: number;
  /** This month's bill beyond Afflatus's count of the pods' time (below 0: under it). */
  notSplit: number;
  balance: number | null;
  /** How long the balance lasts at pace7 + storageDay (the one Settings says); and at what is spent an hour now (ms). */
  runwayDays: number | null;
  spendPerHr: number | null;
  runwayNowMs: number | null;
  storage: { perMonth: number; volumes: number; stoppedDisks: number } | null;
  where: { ms: PartMs; usd: Record<CostPart, number>; boot: { ms: BootMs; usd: BootMs }; estimated: boolean };
  spend: { gpus: string[]; values: number[][] };
  projects: ProjectCost[];
  sessions: PodSession[];
  renderCosts: RenderCostRow[];
  advice: CostAdvice[];
  home: HomeCost[];
  kwh: { price: number | null; currency: string };
}
