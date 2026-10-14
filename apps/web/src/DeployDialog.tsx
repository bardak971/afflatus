import { useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Bookmark, ChevronDown, CircleAlert, Cpu, RotateCw, Search } from "lucide-react";
import { ContextMenu, useMenu } from "./ContextMenu";
import { api, type Availability, type DeployAsk, type GpuOffer, type HuntAsk, type NetworkVolume } from "./api";
import { useQueue, useSettings } from "./data";
import { huntReads, type DeployOpening } from "./deploy";
import { HuntSection } from "./DeployHunt";
import { DeployModels, SaveAsSet, type ModelsPicked } from "./DeployModels";
import { DEPLOYED_READS } from "./deployReads";
import { Dialog, DialogHead, DIALOG } from "./Dialog";
import { gb, plural, usd } from "./format";
import { useDebounced, useNow } from "./hooks";
import { ceilingFor, firstPick } from "./huntSaid";
import { Keys } from "./Keys";
import { queryKeys } from "./queryKeys";
import { Select } from "./Select";
import { Button, cx, ErrorNote, fieldClass, Help, Segmented } from "./ui";

/** What a first deploy opens with: Afflatus's image, Secure Cloud, no volume, terminated after 10 min idle. */
const FIRST: Omit<DeployAsk, "gpu"> = { cloud: "SECURE", template: "afflatus", volume: "", disk: 120, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15, set: "", files: [], leaveOut: [], accept: [], again: false };
const IDLE = [5, 10, 15, 30, 60, 120, 0];
const WATCH = [5, 10, 15, 30, 60, 0];
const DISKS = [60, 120, 200, 400];
const minutesSaid = (n: number) => (n === 0 ? "never" : n < 60 ? `${n} min` : `${n / 60} h`);
/** RunPod's stock of a GPU in a data center, in its words, and the highest first. */
const STOCK_SAID: Record<Availability, string> = { HIGH: "high", MEDIUM: "medium", LOW: "low", NONE: "none" };
const FREEST: Record<Availability, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };
const WHY_STOCK = "RunPod's stock: how many of these GPUs are idle in that data center now (high, medium, low). It is not a reservation: one can be taken between this list and your Deploy. Afflatus then tries the GPU's other data centers, and says so when none is left: nothing is made, nothing billed.";
const WHY_PLACE = "The data center the pod would run in: the one with the highest stock of that GPU. The price is the same in every region; the distance hardly shows (Afflatus sends prompts and gets renders back, models come from Hugging Face and Civitai). A network volume keeps its pods in its own data center.";

/** The columns the list of GPUs sorts by: a click on one sorts by it, a second click the other way. */
type SortKey = "name" | "memory" | "place" | "stock" | "price";
const SORTS: Array<{ key: SortKey; label: string; help?: string; className?: string }> = [
  { key: "name", label: "GPU" },
  { key: "memory", label: "VRAM", className: "justify-end" },
  { key: "place", label: "Data center", help: WHY_PLACE },
  { key: "stock", label: "Stock", help: WHY_STOCK },
  { key: "price", label: "$/h", className: "justify-end" },
];

const WHY_TEMPLATE = "Afflatus: ComfyUI 0.37 with its Manager, the Afflatus node pack, and the packs most video forms use built in (DaSiWa's nodes, VideoHelperSuite, KJNodes, the MMH3 upscale). Its ComfyUI is locked from its first second (its token a RunPod secret), its watchdog armed, only ComfyUI's port open. RunPod's ComfyUI: RunPod's own image, without the Afflatus pack: not locked (anyone with its address can use it), no watchdog, no H3 continuation. Either pulls its image at its first start: a few minutes on a host that never had it.";
const WHY_CLOUD = "Secure Cloud: RunPod's own data centers. Community Cloud: hosts run by others, cheaper, fewer guarantees: some have a GPU that does not work (the Afflatus image finds it at its start, and the pod is terminated within minutes, its pull time billed). Both bill by the second while the pod exists.";
const WHY_DISK = "No volume: the models are fetched onto the pod's own disk at each deploy, and go with it when it is terminated ($0.10/GB a month while it runs, nothing after). A network volume keeps them between deploys, so a pod is ready in a minute ($0.07/GB a month, billed with or without a pod), and ties the pod to the volume's data center.";
const WHY_DONE = "Idle: nothing rendering on it and nothing waiting that it could take. Terminate: nothing billed after, nothing left on RunPod (the pod, its secret). Watchdog: if this PC goes silent (crash, sleep, no internet), the node pack on the pod stops it by itself after that long (Afflatus's image only).";

/** The Deploy dialog's choices as a hunt sends them: all but the GPU, which the hunt picks. */
const withoutGpu = (ask: DeployAsk): Omit<DeployAsk, "gpu"> => {
  const choices: Partial<DeployAsk> = { ...ask };
  delete choices.gpu;
  return choices as Omit<DeployAsk, "gpu">;
};

/** What a volume holds, as its option says it: the picked set's state on it, or how many files, as last seen. */
const heldSaid = (v: NetworkVolume, set: string): string | undefined => {
  if (!v.holds) return "what it holds: not known yet";
  const s = v.sets.find((x) => x.id === set);
  if (s) return s.missing.count ? `${s.name}: ${s.missing.bytes ? gb(s.missing.bytes) : plural(s.missing.count, "file")} missing` : `${s.name}: all there`;
  return `holds ${plural(v.holds.count, "model file")}`;
};

/**
 * Deploy a GPU: what RunPod has free now (read again every 15 s), by price, with the image, the cloud, the disk and what
 * ends it. Deploy is the user's click: billed from then. The choices are kept for the next time ("Deploy again").
 *
 * With a RunPod key, a GPU picked that is not free (one out of stock in the list, the last deploy's gone) turns it to the
 * hunt (DeployHunt.tsx): Afflatus deploys the best GPU that comes free, with these same choices. Opened on "change", or
 * on the hunt with one under way, it changes that hunt's own choices instead (its deploy choices stay the start's).
 */
export function DeployDialog({ onClose, opening = "deploy" }: { onClose(): void; opening?: DeployOpening }) {
  const settings = useSettings();
  const client = useQueryClient();
  const [, go] = useLocation();
  const [want, setWant] = useState<DeployAsk>(() => settings.data?.lastDeploy ?? { ...FIRST, gpu: "" });
  const set = (change: Partial<DeployAsk>) => setWant((w) => ({ ...w, ...change }));
  const gpus = useQuery({ queryKey: queryKeys.runpodGpus(want.cloud), queryFn: ({ signal }) => api.runpodGpus(want.cloud, { signal }), refetchInterval: 15_000, staleTime: 10_000, retry: false });
  const images = useQuery({ queryKey: queryKeys.runpodImages(), queryFn: ({ signal }) => api.runpodImages({ signal }), staleTime: 60_000, retry: false });
  // an image its registry says is not there (not published yet, or private): RunPod could not pull it
  const imageMissing = images.data?.[want.template] === false;
  const volumes = useQuery({ queryKey: queryKeys.runpodVolumes(), queryFn: ({ signal }) => api.runpodVolumes({ signal }), staleTime: 60_000, retry: false });
  const volume = volumes.data?.volumes.find((v) => v.id === want.volume) ?? null;
  // a volume of the last deploy that is not on the account any more: none, as the field shows
  const volumeGone = Boolean(want.volume) && volumes.isSuccess && !volume;
  useEffect(() => {
    if (volumeGone) setWant((w) => ({ ...w, volume: "" }));
  }, [volumeGone]);
  // without a volume a stop keeps nothing (and its GPU may be taken): terminated
  useEffect(() => {
    if (!want.volume && want.idleDo === "stop") setWant((w) => ({ ...w, idleDo: "terminate" }));
  }, [want.volume, want.idleDo]);
  // free where it may run: anywhere, or in the volume's data center; the cheapest first. RunPod saying it is free without
  // saying where: wherever it puts it
  const placesOf = (g: GpuOffer) => (!g.dataCenters.length && !volume && g.availability !== "NONE" ? [{ id: "any", availability: g.availability }] : g.dataCenters.filter((d) => d.availability !== "NONE" && (!volume || d.id === volume.dataCenter)).sort((a, b) => FREEST[a.availability] - FREEST[b.availability]));
  const [sort, setSort] = useState<{ key: SortKey; up: boolean }>({ key: "price", up: true });
  const byKey: Record<SortKey, (a: GpuOffer & { places: Array<{ id: string; availability: Availability }> }, b: typeof a) => number> = {
    name: (a, b) => a.name.localeCompare(b.name),
    memory: (a, b) => a.memory - b.memory,
    place: (a, b) => a.places[0]!.id.localeCompare(b.places[0]!.id),
    stock: (a, b) => FREEST[a.places[0]!.availability] - FREEST[b.places[0]!.availability],
    price: (a, b) => a.price - b.price,
  };
  // the cheapest first, unless a column says otherwise; equal ones by price, then the larger first
  // what is typed narrows the list: a GPU's name or its VRAM ("5090", "48 gb")
  const [q, setQ] = useState("");
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (g: GpuOffer) => words.every((w) => `${g.name} ${g.memory}gb ${g.memory} gb`.toLowerCase().includes(w));
  // what is free whatever is typed: the GPU picked stays picked while the list is narrowed to others
  const free = (gpus.data?.gpus ?? []).map((g) => ({ ...g, places: placesOf(g) })).filter((g) => g.places.length);
  const offers = free.filter(matches).sort((a, b) => (sort.up ? 1 : -1) * byKey[sort.key](a, b) || a.price - b.price || b.memory - a.memory);
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, up: !s.up } : { key, up: key !== "memory" }));
  // how long ago RunPod's stock was read (it is read again every 15 s, or now)
  const now = useNow(1000);
  const readAgo = gpus.dataUpdatedAt ? Math.max(0, Math.round((now - gpus.dataUpdatedAt) / 1000)) : null;
  const picked = free.find((g) => g.id === want.gpu) ?? null;
  // the one picked (or deployed last time) is not free now: said, with the cheapest free one as large
  const gone = !picked && want.gpu && gpus.isSuccess ? gpus.data.gpus.find((g) => g.id === want.gpu) ?? { id: want.gpu, name: want.gpu.replace(/^NVIDIA (GeForce )?/, ""), memory: 0 } : null;
  const instead = gone ? free.slice().sort((a, b) => a.price - b.price).find((g) => g.memory >= gone.memory) ?? null : null;
  // with a key, the GPUs not free now are listed after the others: one picked is hunted for
  const keyed = Boolean(settings.data?.hasRunpodKey);
  const outOfStock = keyed ? (gpus.data?.gpus ?? []).filter((g) => !placesOf(g).length && matches(g)).sort((a, b) => a.price - b.price) : [];

  // the hunt: asked for (Ctrl+K, the hunt's card), or the GPU wanted not free. A hunt under way is changed, not started again
  const [huntAsked, setHuntAsked] = useState(opening !== "deploy");
  const hunting = keyed && (huntAsked || Boolean(gone));
  const queueHunt = useQueue().data?.hunt ?? null;
  const changing = hunting && (opening === "change" || Boolean(queueHunt));
  const kept = useQuery({ queryKey: queryKeys.hunt(), queryFn: ({ signal }) => api.hunt({ signal }), enabled: changing }).data?.hunt ?? null;
  const goneOffer = gone ? gpus.data?.gpus.find((g) => g.id === gone.id) : undefined;
  const [huntChange, setHuntChange] = useState<Partial<HuntAsk>>({});
  const huntBase: HuntAsk = changing && kept
    ? { mode: kept.mode, ceiling: kept.ceiling, leftOut: kept.leftOut, hold: kept.hold, giveUpMinutes: Math.round((Date.parse(kept.giveUpAt) - Date.parse(kept.startedAt)) / 60_000) }
    : { mode: "value", ceiling: ceilingFor(goneOffer?.price), leftOut: [], hold: "rest", giveUpMinutes: 120 };
  const huntAsk = { ...huntBase, ...huntChange };
  // the ranking for these choices, asked once they stop changing (a tick, a price typed); the last one stays shown meanwhile
  const rankAsk = JSON.stringify({ mode: huntAsk.mode, ceiling: huntAsk.ceiling, leftOut: huntAsk.leftOut, cloud: changing ? kept?.deploy.cloud : want.cloud, volume: changing ? kept?.deploy.volume : want.volume });
  const rankAsked = useDebounced(rankAsk, 300, true, rankAsk);
  const rank = useQuery({
    queryKey: queryKeys.huntRank(rankAsked),
    queryFn: ({ signal }) => api.huntRank(JSON.parse(rankAsked) as Parameters<typeof api.huntRank>[0], { signal }),
    enabled: hunting && (!changing || Boolean(kept)),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    retry: false,
  });
  const pick = firstPick(rank.data?.ranking);
  // a GPU free now to deploy in place of the hunt: the one picked (the dialog opened on the hunt), else the cheapest as large
  const alt = picked ?? instead;
  const held = rank.data?.held ?? null;
  // the files the Models part ticked, and whether every licence of them was accepted
  const [models, setModels] = useState<ModelsPicked>({ files: [], leaveOut: [], accept: [], ready: true, bytes: 0 });
  // the pod's own disk holds the files (with room for ComfyUI and its packs): a larger one proposed when they would not fit
  const diskNeed = Math.ceil(models.bytes / 2 ** 30 + 30);
  const diskFits = Boolean(want.volume) || diskNeed <= want.disk;
  const deploy = useMutation({
    mutationFn: () => api.deployGpu({ ...want, files: models.files, leaveOut: models.leaveOut, accept: models.accept }),
    onSuccess: ({ id }) => {
      for (const queryKey of DEPLOYED_READS) void client.invalidateQueries({ queryKey });
      onClose();
      go(`/settings?machine=${encodeURIComponent(id)}`);
    },
  });
  // the hunt started with these choices, or the hunt under way changed (only what was changed here is sent)
  const huntGo = useMutation({
    mutationFn: () => (changing ? api.changeHunt(huntChange) : api.startHunt({ ...huntAsk, deploy: { ...withoutGpu(want), files: models.files, leaveOut: models.leaveOut, accept: models.accept, again: false } })),
    onSuccess: async () => {
      await huntReads(client);
      onClose();
    },
  });
  const more = useMenu<true>();
  // the choices kept as the next deploy's without deploying (Settings › Rented GPUs › Next deploy); the files are a deploy's own
  const saveNext = useMutation({
    mutationFn: () => api.saveSettings({ lastDeploy: { ...want, files: [], leaveOut: [], accept: [], again: false } }),
    onSuccess: (saved) => {
      client.setQueryData(queryKeys.settings(), saved);
      onClose();
    },
  });
  return (
    <Dialog label="Deploy a GPU" onClose={onClose} className={cx(DIALOG.replace("max-w-md", "max-w-[860px]"), "max-h-[calc(100vh-48px)]")}>
      <DialogHead icon={<Cpu size={16} />} title="Deploy a GPU" sub={changing ? "RunPod · the hunt under way" : hunting ? `RunPod · ${want.cloud === "SECURE" ? "Secure" : "Community"} Cloud · the best GPU that comes free` : "RunPod · what is in stock now"} onClose={onClose} />
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1">
        {hunting ? (
          <HuntSection
            ask={huntAsk}
            change={(c) => setHuntChange((was) => ({ ...was, ...c }))}
            ranking={rank.data?.ranking ?? null}
            failed={rank.isError ? rank.error.message : null}
            pending={rank.isFetching}
            volume={changing ? (kept?.dataCenter ? { name: volumes.data?.volumes.find((v) => v.id === kept.deploy.volume)?.name ?? "its network volume", dataCenter: kept.dataCenter } : null) : volume}
            warning={changing ? null : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] bg-warn-wash px-3.5 py-2.5 text-[13px] text-warn-ink">
                <CircleAlert size={16} className="shrink-0" />
                <span className="min-w-0 grow">
                  {gone ? `No ${gone.name} is free ${volume ? `in ${volume.dataCenter} ` : ""}right now. Hunt for one, or for the best GPU that comes free.` : `The best GPU below is deployed the moment one comes free${volume ? ` in ${volume.dataCenter}` : ""}.`}
                  {alt && ` The ${alt.name} is free now, at ${usd(alt.price)}/h.`}
                </span>
                {alt && <Button size="sm" onClick={() => { set({ gpu: alt.id }); setHuntAsked(false); }}>Deploy it instead</Button>}
                <Segmented<DeployAsk["cloud"]> size="sm" label="Cloud" value={want.cloud} options={[{ value: "SECURE", label: "Secure" }, { value: "COMMUNITY", label: "Community" }]} onChange={(cloud) => set({ cloud })} />
                <Help text={WHY_CLOUD} />
              </div>
            )}
          />
        ) : (
        <section className="flex flex-col gap-1.5">
          <span className="flex items-center gap-2 text-xs font-semibold text-ink-2">
            GPU · in stock now
            {readAgo !== null && <span className="font-normal text-ink-3">read {readAgo} s ago</span>}
            <button type="button" aria-label="Read RunPod's stock now" data-tip="Read now (every 15 s by itself)" onClick={() => void gpus.refetch()} disabled={gpus.isFetching} className="grid size-6 place-items-center rounded-md text-ink-3 hover:bg-hover hover:text-ink disabled:opacity-50">
              <RotateCw size={12} className={cx(gpus.isFetching && "animate-spin")} />
            </button>
            <span className="grow" />
            <input aria-label="Find a GPU" placeholder="Find: 5090, 48 GB…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" && q) { e.stopPropagation(); setQ(""); } }} className={cx(fieldClass, "h-7 w-36 px-2 text-xs font-normal")} />
            <Segmented<DeployAsk["cloud"]> size="sm" label="Cloud" value={want.cloud} options={[{ value: "SECURE", label: "Secure" }, { value: "COMMUNITY", label: "Community" }]} onChange={(cloud) => set({ cloud })} />
            <Help text={WHY_CLOUD} />
          </span>
          {/* one height whatever the cloud, the stock or the answer: the dialog does not move under the pointer */}
          <div role="radiogroup" aria-label="GPU" className="flex h-[300px] flex-col overflow-y-auto rounded-xl border border-line">
            {gpus.isError && <div className="p-3"><ErrorNote>{gpus.error.message}</ErrorNote></div>}
            {gpus.isPending && <span className="px-3 py-2.5 text-xs text-ink-3">Asking RunPod…</span>}
            {gpus.isSuccess && !offers.length && <span className="px-3 py-2.5 text-xs text-ink-2">{words.length && gpus.data?.gpus.some((g) => placesOf(g).length) ? `No GPU in stock matches “${q}”.` : `Nothing in stock ${volume ? `in ${volume.dataCenter}, where the volume is` : "on this cloud"} now. RunPod's stock moves by the minute: this list is read again every 15 s.`}</span>}
            {offers.length > 0 && (
              <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_64px_90px_70px_76px] items-center gap-3 border-b border-line bg-panel px-3 py-1.5 text-[11px] font-semibold text-ink-3">
                {SORTS.map((c) => (
                  <span key={c.key} className={cx("flex items-center gap-1", c.className)}>
                    <button type="button" onClick={() => sortBy(c.key)} aria-label={`Sort by ${c.label}`} className={cx("hover:text-ink", sort.key === c.key && "text-ink")}>
                      {c.label}{sort.key === c.key ? (sort.up ? " ↑" : " ↓") : ""}
                    </button>
                    {c.help && <Help text={c.help} />}
                  </span>
                ))}
              </div>
            )}
            {offers.map((g) => (
              <button
                key={g.id}
                type="button"
                role="radio"
                aria-checked={g.id === want.gpu}
                onClick={() => set({ gpu: g.id })}
                className={cx("grid grid-cols-[minmax(0,1fr)_64px_90px_70px_76px] items-center gap-3 border-b border-line/60 px-3 py-2 text-left text-[13px] last:border-b-0", g.id === want.gpu ? "bg-accent-wash" : "hover:bg-hover")}
              >
                <span className="min-w-0 truncate font-semibold">{g.name}</span>
                <span className="text-right font-mono text-xs text-ink-2">{g.memory} GB</span>
                <span className="truncate text-xs text-ink-2">{g.places[0]!.id}</span>
                <span className="text-xs text-ink-2">{STOCK_SAID[g.places[0]!.availability]}</span>
                <span className="text-right font-mono text-xs">{usd(g.price)}/h</span>
              </button>
            ))}
            {/* the GPUs RunPod has none of now, after the others: one picked turns the dialog to its hunt */}
            {outOfStock.length > 0 && (
              <>
                <span className="border-b border-line/60 px-3 pt-3 pb-1.5 text-[11px] font-semibold text-ink-3">Not in stock now · pick one to hunt for it</span>
                {outOfStock.map((g) => (
                  <button key={g.id} type="button" role="radio" aria-checked={false} onClick={() => set({ gpu: g.id })} className="grid grid-cols-[minmax(0,1fr)_64px_90px_70px_76px] items-center gap-3 border-b border-line/60 px-3 py-2 text-left text-[13px] text-ink-2 last:border-b-0 hover:bg-hover">
                    <span className="min-w-0 truncate font-semibold">{g.name}</span>
                    <span className="text-right font-mono text-xs">{g.memory} GB</span>
                    <span className="text-xs">{volume ? volume.dataCenter : "anywhere"}</span>
                    <span className="text-xs">none</span>
                    <span className="text-right font-mono text-xs">{usd(g.price)}/h</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </section>
        )}

        {!changing && (
        <section className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-3 gap-y-3 text-[13px]">
          <span className="flex items-center gap-1.5 font-semibold text-ink-2">Image <Help text={WHY_TEMPLATE} /></span>
          <Segmented<DeployAsk["template"]> label="Image" value={want.template} options={[{ value: "afflatus", label: images.data?.afflatus === false ? "Afflatus · not published" : "Afflatus · locked" }, { value: "runpod", label: "RunPod's ComfyUI · not locked" }]} onChange={(template) => set({ template })} />

          <span className="flex items-center gap-1.5 font-semibold text-ink-2">Disk <Help text={WHY_DISK} /></span>
          <span className="flex flex-wrap items-center gap-2">
            <span className="w-[280px]">
              <Select size="sm" label="Network volume" value={want.volume || "none"} onChange={(v) => set({ volume: v === "none" ? "" : v })} options={[{ value: "none", label: "No volume" }, ...(volumes.data?.volumes ?? []).map((v) => ({ value: v.id, label: v.name, note: v.usedBy ? `in use by ${v.usedBy.name} · ${v.usedBy.status === "RUNNING" ? "running" : "starting"}` : `${v.dataCenter} · ${v.size} GB`, detail: v.usedBy ? undefined : heldSaid(v, want.set), disabled: Boolean(v.usedBy) }))]} />
            </span>
            {!volume && (
              <span className="w-[110px]">
                <Select size="sm" label="Its own disk" value={String(want.disk)} onChange={(v) => set({ disk: Number(v) })} options={[...new Set([...DISKS, want.disk])].sort((a, b) => a - b).map((n) => ({ value: String(n), label: `${n} GB` }))} />
              </span>
            )}
            <span className="text-xs text-ink-3">{volume ? `models kept on it · GPUs of ${volume.dataCenter} only` : "models fetched at each deploy"}</span>
          </span>

          <span className="flex items-center gap-1.5 font-semibold text-ink-2">When done <Help text={WHY_DONE} /></span>
          <span className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
            <span className="w-[130px]"><Select size="sm" label="What when idle" value={want.idleDo} onChange={(v) => set({ idleDo: v as DeployAsk["idleDo"] })} options={volume ? [{ value: "terminate", label: "Terminate it" }, { value: "stop", label: "Stop it", note: "its GPU may be taken meanwhile" }] : [{ value: "terminate", label: "Terminate it" }]} /></span>
            after
            <span className="w-[92px]"><Select size="sm" label="Minutes idle" value={String(want.idleMinutes)} onChange={(v) => set({ idleMinutes: Number(v) })} options={IDLE.map((n) => ({ value: String(n), label: minutesSaid(n) }))} /></span>
            idle · watchdog
            <span className="w-[92px]"><Select size="sm" label="Watchdog minutes" value={String(want.watchdogMinutes)} onChange={(v) => set({ watchdogMinutes: Number(v) })} options={WATCH.map((n) => ({ value: String(n), label: n === 0 ? "off" : minutesSaid(n) }))} /></span>
          </span>
        </section>
        )}

        {/* a hunt under way deploys with the choices it was started with: only its own are changed */}
        {changing ? (
          <span className="text-xs text-ink-3">It deploys with the choices it was started with (image, disk, when done, models). To change those, cancel it and hunt again.</span>
        ) : (
          <>
        <DeployModels want={want} set={set} rate={(hunting ? pick?.price : picked?.price) ?? null} gpu={(hunting ? pick?.name : picked?.name) ?? null} onPicked={setModels} />
        {!diskFits && (
          <span className="flex items-center gap-2 text-xs text-warn-ink">
            These files take about {diskNeed - 30} GB, with ComfyUI {diskNeed} GB: its disk of {want.disk} GB is too small.
            <Button size="sm" onClick={() => set({ disk: DISKS.find((n) => n >= diskNeed) ?? Math.min(2000, Math.ceil(diskNeed / 50) * 50) })}>Use {DISKS.find((n) => n >= diskNeed) ?? Math.min(2000, Math.ceil(diskNeed / 50) * 50)} GB</Button>
          </span>
        )}
        <SaveAsSet files={models.files} />
          </>
        )}

        {volume?.usedBy && (
          <span className="flex items-center gap-2 text-xs text-warn-ink">
            The volume {volume.name} is in use by {volume.usedBy.name}: one pod at a time on a volume.
            <Button size="sm" onClick={() => set({ volume: "" })}>Deploy without it</Button>
          </span>
        )}
        {imageMissing && <ErrorNote>{want.template === "afflatus" ? "The Afflatus image is not published yet, or not public: RunPod could not pull it. Deploy with RunPod's ComfyUI meanwhile." : "RunPod's ComfyUI image cannot be pulled from Docker Hub now."}</ErrorNote>}
        {want.template === "runpod" && <ErrorNote>RunPod's ComfyUI has no Afflatus pack: it is not locked, so anyone who finds its address can run work on it, and nothing stops it if this PC goes silent.</ErrorNote>}
        {deploy.isError && <ErrorNote>{deploy.error.message}</ErrorNote>}
        {huntGo.isError && <ErrorNote>{huntGo.error.message}</ErrorNote>}
        {saveNext.isError && <ErrorNote>{saveNext.error.message}</ErrorNote>}
      </div>
      {/* the note takes what width there is and wraps; the buttons keep their place (they never move under the pointer) */}
      <div className="-mx-5 -mb-5 mt-1 flex items-center gap-3 border-t border-line px-5 py-3.5">
        <span className="min-w-0 grow text-xs text-ink-3">
          {hunting
            ? changing
              ? "Changed at once; RunPod is asked again now. Nothing is billed until a pod is made."
              : held === 0
                ? <span className="text-warn-ink">Nothing waits for a GPU: queue the renders first.</span>
                : `${held === null ? "" : `${plural(held, "render")} waiting. `}RunPod is asked every 30 s; nothing is billed until a pod is made, and none is made when no render waits.`
            : picked
            ? `Billed from deploy · ${picked.name} ${picked.places[0]!.id === "any" ? "on Community Cloud" : `in ${picked.places[0]!.id}`}`
            : gone
              // the one picked last time, not in stock on this cloud now: said where the choice is made, nothing moves above
              ? <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-warn-ink">{gone.name} not in stock {volume ? `in ${volume.dataCenter} ` : ""}now{instead ? `; the ${instead.name} is, at ${usd(instead.price)}/h` : ""}{instead && <Button size="sm" onClick={() => set({ gpu: instead.id })}>Pick it</Button>}</span>
              : "Pick a GPU"}
        </span>
        <Button tone="quiet" onClick={onClose} className="shrink-0">Cancel <Keys keys="Esc" size="sm" /></Button>
        {/* Deploy, and on its slice what else can be done with these choices: kept as the next deploy's, without deploying */}
        <span className="flex shrink-0">
          {hunting ? (
            <button type="button" onClick={() => huntGo.mutate()} disabled={huntGo.isPending || (changing ? !kept : imageMissing || !models.ready || !diskFits || Boolean(volume?.usedBy) || held === 0)} className="flex h-10 min-w-[150px] items-center justify-center gap-2 rounded-l-lg bg-accent px-4 text-[13px] font-bold text-accent-ink hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50">
              <Search size={15} />
              {huntGo.isPending ? (changing ? "Changing…" : "Starting…") : `${changing ? "Change" : "Hunt"} · up to ${usd(huntAsk.ceiling)}/h`}
            </button>
          ) : (
          <button type="button" onClick={() => deploy.mutate()} disabled={!picked || imageMissing || deploy.isPending || !models.ready || !diskFits || Boolean(volume?.usedBy)} className="flex h-10 min-w-[150px] items-center justify-center rounded-l-lg bg-accent px-4 text-[13px] font-bold text-accent-ink hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50">
            {deploy.isPending ? "Deploying…" : picked ? `Deploy · ${usd(picked.price)}/h` : "Deploy"}
          </button>
          )}
          <button type="button" aria-label="More: save as the next deploy" data-tip="Save these choices as the next deploy's, without deploying" onClick={(e) => more.open(e, true)} disabled={!want.gpu || changing} className="flex h-10 w-9 items-center justify-center rounded-r-lg border-l border-accent-ink/25 bg-accent text-accent-ink hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50">
            <ChevronDown size={15} />
          </button>
        </span>
        {more.menu && <ContextMenu at={more.menu.at} label="Deploy" items={[{ label: "Save as next deploy", note: "without deploying", icon: <Bookmark size={14} />, run: () => saveNext.mutate() }]} onClose={more.close} />}
      </div>
    </Dialog>
  );
}
