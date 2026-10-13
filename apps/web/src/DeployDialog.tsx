import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Cpu } from "lucide-react";
import { api, type Availability, type DeployAsk, type GpuOffer } from "./api";
import { useSettings } from "./data";
import { DEPLOYED_READS } from "./deployReads";
import { Dialog, DialogFoot, DialogHead, DIALOG } from "./Dialog";
import { usd } from "./format";
import { Keys } from "./Keys";
import { queryKeys } from "./queryKeys";
import { Select } from "./Select";
import { Button, cx, ErrorNote, Help, Segmented } from "./ui";

/** What a first deploy opens with: Afflatus's image, Secure Cloud, no volume, terminated after 10 min idle. */
const FIRST: Omit<DeployAsk, "gpu"> = { cloud: "SECURE", template: "afflatus", volume: "", disk: 120, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15 };
const IDLE = [5, 10, 15, 30, 60, 120, 0];
const WATCH = [5, 10, 15, 30, 60, 0];
const DISKS = [60, 120, 200, 400];
const minutesSaid = (n: number) => (n === 0 ? "never" : n < 60 ? `${n} min` : `${n / 60} h`);
/** How free a GPU is, in a word, and the freest first. */
const FREE_SAID: Record<Availability, string> = { HIGH: "plenty", MEDIUM: "free", LOW: "few left", NONE: "none" };
const FREEST: Record<Availability, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };

const WHY_TEMPLATE = "Afflatus: ComfyUI 0.37 with its Manager and the Afflatus node pack. Its ComfyUI is locked from its first second (its token a RunPod secret), its watchdog armed, only ComfyUI's port open. RunPod's ComfyUI: RunPod's own image, without the Afflatus pack: not locked (anyone with its address can use it), no watchdog, no H3 continuation. Either pulls its image at its first start: a few minutes on a host that never had it.";
const WHY_CLOUD = "Secure Cloud: RunPod's own data centers. Community Cloud: hosts run by others, cheaper, fewer guarantees: some have a GPU that does not work (the Afflatus image finds it at its start, and the pod is terminated within minutes, its pull time billed). Both bill by the second while the pod exists.";
const WHY_DISK = "No volume: the models are fetched onto the pod's own disk at each deploy, and go with it when it is terminated ($0.10/GB a month while it runs, nothing after). A network volume keeps them between deploys, so a pod is ready in a minute ($0.07/GB a month, billed with or without a pod), and ties the pod to the volume's data center.";
const WHY_DONE = "Idle: nothing rendering on it and nothing waiting that it could take. Terminate: nothing billed after, nothing left on RunPod (the pod, its secret). Watchdog: if this PC goes silent (crash, sleep, no internet), the node pack on the pod stops it by itself after that long (Afflatus's image only).";

/**
 * Deploy a GPU: what RunPod has free now (read again every 15 s), by price, with the image, the cloud, the disk and what
 * ends it. Deploy is the user's click: billed from then. The choices are kept for the next time ("Deploy again").
 */
export function DeployDialog({ onClose }: { onClose(): void }) {
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
  const offers = (gpus.data?.gpus ?? []).map((g) => ({ ...g, places: placesOf(g) })).filter((g) => g.places.length).sort((a, b) => a.price - b.price || b.memory - a.memory);
  const picked = offers.find((g) => g.id === want.gpu) ?? null;
  // the one picked (or deployed last time) is not free now: said, with the cheapest free one as large
  const gone = !picked && want.gpu && gpus.isSuccess ? gpus.data.gpus.find((g) => g.id === want.gpu) ?? { id: want.gpu, name: want.gpu.replace(/^NVIDIA (GeForce )?/, ""), memory: 0 } : null;
  const instead = gone ? offers.find((g) => g.memory >= gone.memory) ?? null : null;
  const deploy = useMutation({
    mutationFn: () => api.deployGpu(want),
    onSuccess: ({ id }) => {
      for (const queryKey of DEPLOYED_READS) void client.invalidateQueries({ queryKey });
      onClose();
      go(`/settings?machine=${encodeURIComponent(id)}`);
    },
  });
  return (
    <Dialog label="Deploy a GPU" onClose={onClose} className={cx(DIALOG.replace("max-w-md", "max-w-[640px]"), "max-h-[calc(100vh-48px)]")}>
      <DialogHead icon={<Cpu size={16} />} title="Deploy a GPU" sub="RunPod · what is free now" onClose={onClose} />
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1">
        <section className="flex flex-col gap-1.5">
          <span className="flex items-center gap-2 text-xs font-semibold text-ink-2">
            GPU · free now · by price
            <span className="grow" />
            <Segmented<DeployAsk["cloud"]> size="sm" label="Cloud" value={want.cloud} options={[{ value: "SECURE", label: "Secure" }, { value: "COMMUNITY", label: "Community" }]} onChange={(cloud) => set({ cloud })} />
            <Help text={WHY_CLOUD} />
          </span>
          {gpus.isError && <ErrorNote>{gpus.error.message}</ErrorNote>}
          {gpus.isPending && <span className="px-1 py-2 text-xs text-ink-3">Asking RunPod…</span>}
          {gpus.isSuccess && !offers.length && <span className="px-1 py-2 text-xs text-ink-2">Nothing free {volume ? `in ${volume.dataCenter}, where the volume is` : "on this cloud"} now. RunPod's stock moves by the minute: this list is read again every 15 s.</span>}
          <div role="radiogroup" aria-label="GPU" className="flex max-h-[280px] flex-col overflow-y-auto rounded-xl border border-line">
            {offers.map((g) => (
              <button
                key={g.id}
                type="button"
                role="radio"
                aria-checked={g.id === want.gpu}
                onClick={() => set({ gpu: g.id })}
                className={cx("grid grid-cols-[minmax(0,1fr)_90px_80px_76px] items-center gap-3 border-b border-line/60 px-3 py-2 text-left text-[13px] last:border-b-0", g.id === want.gpu ? "bg-accent-wash" : "hover:bg-hover")}
              >
                <span className="min-w-0 truncate"><span className="font-semibold">{g.name}</span> <span className="text-ink-3">· {g.memory} GB</span></span>
                <span className="truncate text-xs text-ink-2">{g.places[0]!.id}</span>
                <span className={cx("text-xs", g.places[0]!.availability === "LOW" ? "text-warn-ink" : "text-ink-2")}>{FREE_SAID[g.places[0]!.availability]}</span>
                <span className="text-right font-mono text-xs">{usd(g.price)}/h</span>
              </button>
            ))}
          </div>
          {gone && (
            <span className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-wash px-3 py-2 text-xs text-warn-ink">
              <span className="grow">{gone.name} is not free {volume ? `in ${volume.dataCenter}` : ""} now{instead ? `: the ${instead.name} is, at ${usd(instead.price)}/h` : ""}.</span>
              {instead && <Button size="sm" onClick={() => set({ gpu: instead.id })}>Pick the {instead.name}</Button>}
            </span>
          )}
        </section>

        <section className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-3 gap-y-3 text-[13px]">
          <span className="flex items-center gap-1.5 font-semibold text-ink-2">Image <Help text={WHY_TEMPLATE} /></span>
          <Segmented<DeployAsk["template"]> label="Image" value={want.template} options={[{ value: "afflatus", label: images.data?.afflatus === false ? "Afflatus · not published" : "Afflatus · locked" }, { value: "runpod", label: "RunPod's ComfyUI · not locked" }]} onChange={(template) => set({ template })} />

          <span className="flex items-center gap-1.5 font-semibold text-ink-2">Disk <Help text={WHY_DISK} /></span>
          <span className="flex flex-wrap items-center gap-2">
            <span className="w-[200px]">
              <Select size="sm" label="Network volume" value={want.volume || "none"} onChange={(v) => set({ volume: v === "none" ? "" : v })} options={[{ value: "none", label: "No volume" }, ...(volumes.data?.volumes ?? []).map((v) => ({ value: v.id, label: v.name, note: `${v.dataCenter} · ${v.size} GB` }))]} />
            </span>
            {!volume && (
              <span className="w-[110px]">
                <Select size="sm" label="Its own disk" value={String(want.disk)} onChange={(v) => set({ disk: Number(v) })} options={DISKS.map((n) => ({ value: String(n), label: `${n} GB` }))} />
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

        {imageMissing && <ErrorNote>{want.template === "afflatus" ? "The Afflatus image is not published yet, or not public: RunPod could not pull it. Deploy with RunPod's ComfyUI meanwhile." : "RunPod's ComfyUI image cannot be pulled from Docker Hub now."}</ErrorNote>}
        {want.template === "runpod" && <ErrorNote>RunPod's ComfyUI has no Afflatus pack: it is not locked, so anyone who finds its address can run work on it, and nothing stops it if this PC goes silent.</ErrorNote>}
        {deploy.isError && <ErrorNote>{deploy.error.message}</ErrorNote>}
      </div>
      <DialogFoot info={picked ? `Billed from deploy · ${picked.name} in ${picked.places[0]!.id}` : "Pick a GPU"}>
        <Button tone="quiet" onClick={onClose}>Cancel <Keys keys="Esc" size="sm" /></Button>
        <Button tone="primary" onClick={() => deploy.mutate()} disabled={!picked || imageMissing || deploy.isPending}>{deploy.isPending ? "Deploying…" : picked ? `Deploy · ${usd(picked.price)}/h` : "Deploy"}</Button>
      </DialogFoot>
    </Dialog>
  );
}
