import { lazy, Suspense } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { api, type DeployAsk } from "./api";
import { ask } from "./Confirm";
import { useSettings } from "./data";
import { DEPLOYED_READS } from "./deployReads";
import { usd } from "./format";
import { useSayFailed } from "./sayFailed";

/**
 * Deploy a GPU: the dialog (DeployDialog.tsx), opened from Settings › Rented GPUs, the ComfyUI tab's "Add a ComfyUI", the
 * machines pill and Ctrl+K; one at a time, over everything. Afflatus never deploys on its own: every deploy is a click.
 */
const useDeploy = create<{ open: boolean }>(() => ({ open: false }));
export const openDeploy = () => useDeploy.setState({ open: true });

const DeployDialog = lazy(() => import("./DeployDialog").then((m) => ({ default: m.DeployDialog })));

export function DeployHost() {
  const open = useDeploy((s) => s.open);
  if (!open) return null;
  return <Suspense fallback={null}><DeployDialog onClose={() => useDeploy.setState({ open: false })} /></Suspense>;
}

/** A last deploy said in a few words: "A40 · Afflatus · no volume". */
export const lastSaid = (last: DeployAsk, name?: string) => [name ?? last.gpu.replace(/^NVIDIA (GeForce )?/, ""), last.template === "afflatus" ? "Afflatus" : "RunPod's ComfyUI", last.volume ? "network volume" : "no volume", last.set ? "its Model set" : ""].filter(Boolean).join(" · ");

/**
 * "Deploy again": the last deploy's choices, after one question that says the rate as RunPod says it now. Its GPU not
 * free any more (or the rate not read): the dialog opens instead, to pick another.
 */
export function useDeployAgain() {
  const last = useSettings().data?.lastDeploy ?? null;
  const client = useQueryClient();
  const sayFailed = useSayFailed({ id: "deploy-again", href: "/settings/rented", go: "Open Rented GPUs" });
  const run = useMutation({
    mutationFn: async () => {
      if (!last) return null;
      // free where it would run: anywhere, or where its volume is
      const [gpus, volumes] = await Promise.all([api.runpodGpus(last.cloud).catch(() => null), last.volume ? api.runpodVolumes().catch(() => null) : null]);
      const at = last.volume ? volumes?.volumes.find((v) => v.id === last.volume)?.dataCenter : null;
      const offer = (last.volume && !at) ? undefined : gpus?.gpus.find((g) => g.id === last.gpu && (at ? g.dataCenters.some((d) => d.id === at && d.availability !== "NONE") : g.availability !== "NONE"));
      if (!offer) {
        openDeploy();
        return null;
      }
      if (!(await ask({ title: `Deploy another ${offer.name}?`, text: `${lastSaid(last, offer.name)}, on RunPod at ${usd(offer.price)}/h: billed from now until it is ${last.idleDo === "stop" ? "stopped" : "terminated"} (${last.idleMinutes ? `after ${last.idleMinutes} min idle, or ` : ""}by you).`, yes: "Deploy" }))) return null;
      // its Model set's files come again (the server reads the set as it is now)
      return api.deployGpu({ ...last, again: true });
    },
    onSuccess: () => {
      for (const queryKey of DEPLOYED_READS) void client.invalidateQueries({ queryKey });
    },
    onError: sayFailed("Not deployed"),
  });
  return { last, run };
}
