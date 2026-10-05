import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useSettings } from "../../data";
import { DownloadRow, useDownloads } from "../../GetFile";
import { Button, cx, ErrorNote, Toggle } from "../../ui";

/** Whether Afflatus may ask Civitai where a missing file can be had. Off unless turned on here. */
export function CivitaiCard() {
  const settings = useSettings();
  const client = useQueryClient();
  const [key, setKey] = useState("");
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.saveSettings(patch),
    onSuccess: () => {
      setKey("");
      // whether ComfyUI-Manager is there is only asked once downloading is turned on
      void client.invalidateQueries({ queryKey: ["downloads"] });
      return client.invalidateQueries({ queryKey: ["settings"] });
    },
  });
  const on = Boolean(settings.data?.civitaiLookups);
  const fetching = Boolean(settings.data?.downloadModels);
  const downloads = useDownloads();
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <h2 className="text-[15px] font-bold">Missing models</h2>
      <Toggle on={fetching} onChange={(v) => save.mutate({ downloadModels: v })} label="Download missing models into ComfyUI (ComfyUI-Manager)" />
      <div className="text-xs text-ink-3">
        {fetching
          ? "A missing model file gets a \"Download\" button: from the URL the workflow's author gave, or from Civitai once it is found there. ComfyUI-Manager saves it in the right models folder; the file passes through Afflatus, which shows the progress. Nothing is downloaded until you press the button."
          : "Off: Afflatus never asks ComfyUI to download anything. Missing models only get links to open in your browser."}
      </div>
      {fetching && downloads.data && (
        <div className={cx("text-xs", downloads.data.manager.found ? "text-good" : "text-warn-ink")}>
          {downloads.data.manager.found
            ? `ComfyUI-Manager ${downloads.data.manager.version ?? ""} found.`
            : "This needs ComfyUI-Manager in your ComfyUI, and it was not found (or ComfyUI is not answering)."}
          {!downloads.data.manager.found && (
            <div className="mt-1 text-ink-2">
              ComfyUI has it built in since 0.3.7x, off until asked for: in ComfyUI's folder run <code className="font-mono">pip install -r manager_requirements.txt</code> with its own Python (the venv's, or <code className="font-mono">python_embeded</code> in the portable build), then start ComfyUI with <code className="font-mono">--enable-manager</code>. On an older ComfyUI, clone <code className="font-mono">https://github.com/Comfy-Org/ComfyUI-Manager</code> into its <code className="font-mono">custom_nodes</code> folder instead. Either way, restart ComfyUI, then Test again in the ComfyUI tab. The desktop build has it on already. A ComfyUI that listens on the network (<code className="font-mono">--listen</code>) also needs <code className="font-mono">network_mode = personal_cloud</code> in Manager's <code className="font-mono">config.ini</code>, or it refuses the download.
            </div>
          )}
        </div>
      )}
      {(downloads.data?.items.length ?? 0) > 0 && (
        <div className="flex flex-col gap-1.5">
          {downloads.data!.items.map((d) => <DownloadRow key={d.id} d={d} named />)}
        </div>
      )}
      <Toggle on={on} onChange={(v) => save.mutate({ civitaiLookups: v })} label="Search Hugging Face and Civitai for missing models" />
      <div className="text-xs text-ink-3">
        {on
          ? "When a model file is missing, \"Search\" asks Hugging Face for a file of exactly that name, and Civitai (civitai.com and civitai.red) for models with a close name. Only the filename is sent, and only when you press the button. What is found is shown with a link, and with a Download button when downloading is turned on above."
          : "Off: Afflatus never contacts Hugging Face or Civitai. Missing models still get links that open a search in your browser."}
      </div>
      {on && (
        <div className="flex items-end gap-2">
          <label className="flex min-w-0 grow flex-col gap-1.5">
            <span className="text-xs text-ink-2">Civitai API key {settings.data?.hasCivitaiKey ? "(one is saved)" : "(only needed for models hidden without an account)"}</span>
            <input type="password" value={key} autoComplete="off" placeholder={settings.data?.hasCivitaiKey ? "leave empty to keep it" : "none"} onChange={(e) => setKey(e.target.value)} className="h-10 min-w-0 rounded-lg border border-line bg-raised px-3 font-mono text-xs placeholder:font-sans placeholder:text-ink-3" />
          </label>
          <Button onClick={() => save.mutate({ civitaiKey: key })} disabled={!key || save.isPending}>Save</Button>
          {settings.data?.hasCivitaiKey && <Button onClick={() => save.mutate({ civitaiKey: "" })} disabled={save.isPending}>Remove key</Button>}
        </div>
      )}
      {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
    </section>
  );
}
