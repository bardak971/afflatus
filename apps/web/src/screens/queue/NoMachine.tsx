import { Cloud, ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useSettings } from "../../data";
import { openDeploy } from "../../deploy";
import { queryKeys } from "../../queryKeys";
import { useSayFailed } from "../../sayFailed";
import { Button } from "../../ui";
import { CAP_DAY_WHY, CAP_MONTH_WHY, CapBox } from "../settings/RentedCard";
import { SecretField } from "../settings/SecretField";

/**
 * The Queue's machine row when no machine can take work (where you render, card #20: no ComfyUI of the user's own, no pod
 * up): jobs wait here, and Deploy a GPU is at hand. Without a RunPod key, the key and the caps are asked right here, the
 * natural moment for a rented-only user whatever the first launch skipped: saved, Deploy opens.
 */
export function NoMachine({ waiting }: { waiting: number }) {
  const settings = useSettings();
  const client = useQueryClient();
  const sayFailed = useSayFailed({ id: "no-machine", href: "/settings/rented", go: "Open Rented GPUs" });
  const save = useMutation({
    mutationFn: (patch: Parameters<typeof api.saveSettings>[0]) => api.saveSettings(patch),
    onSuccess: (saved) => client.setQueryData(queryKeys.settings(), saved),
  });
  const hasKey = Boolean(settings.data?.hasRunpodKey);
  const caps = settings.data?.rentCaps ?? { day: 0, month: 0 };
  const saveCaps = (patch: Partial<typeof caps>) => save.mutate({ rentCaps: { ...caps, ...patch } }, { onError: sayFailed("The cap was not saved") });
  return (
    <div className="flex flex-col gap-3 rounded-card border border-line bg-panel p-3">
      <div className="flex items-center gap-3.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-control bg-raised text-ink-2"><Cloud size={17} /></span>
        <span className="flex min-w-0 grow flex-col">
          <b className="text-ink-strong">No machine yet</b>
          <span className="text-xs text-ink-3">
            {waiting ? "Its jobs wait here" : "Jobs wait here"} until one is up: a rented GPU, or your ComfyUI (<Link href="/settings/comfyui" className="underline underline-offset-2 hover:text-ink">Settings › ComfyUI</Link>).
          </span>
        </span>
        {hasKey && <Button tone="primary" onClick={() => openDeploy()}>Deploy a GPU…</Button>}
      </div>
      {!hasKey && (
        <div className="ml-[54px] flex flex-col gap-2 text-xs text-ink-2">
          <span>Deploy one on RunPod, with its API key:</span>
          <div className="flex max-w-[640px] items-center gap-2">
            <SecretField id="queue-runpod-key" label="RunPod API key" saved={false} placeholder="Your RunPod API key" valid={(key) => key.length >= 10} busy={save.isPending}
              onSave={(runpodKey) => save.mutateAsync({ runpodKey }).then(() => openDeploy(), (err: Error) => { sayFailed("The RunPod key was not saved")(err); throw err; })} />
            <a href="https://www.runpod.io/console/user/settings" target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-1 font-bold text-accent hover:underline">Make one <ExternalLink size={12} /></a>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-ink">Caps</span>
            <CapBox label="a day" value={caps.day} help={CAP_DAY_WHY} onSave={(day) => saveCaps({ day })} />
            <CapBox label="a month" value={caps.month} help={CAP_MONTH_WHY} onSave={(month) => saveCaps({ month })} />
            <span className="text-ink-3">kept in Settings › Rented GPUs · saved, the key opens Deploy</span>
          </div>
        </div>
      )}
    </div>
  );
}
