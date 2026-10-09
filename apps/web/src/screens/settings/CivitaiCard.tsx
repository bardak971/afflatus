import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { api } from "../../api";
import { useSettings } from "../../data";
import { DownloadRow, useDownloads } from "../../GetFile";
import { Button, cx, ErrorNote, fieldClass, Toggle } from "../../ui";
import { Block, Card, Row, Status, warnButton } from "./Rows";

const MANAGER_HOWTO = "ComfyUI has ComfyUI-Manager built in since 0.3.7x, off until asked for: in ComfyUI's folder run pip install -r manager_requirements.txt with its own Python (the venv's, or python_embeded in the portable build), then start ComfyUI with --enable-manager. On an older ComfyUI, clone https://github.com/Comfy-Org/ComfyUI-Manager into its custom_nodes folder instead. Either way, restart ComfyUI, then Test again in the ComfyUI tab. The desktop build has it on already. A ComfyUI that listens on the network (--listen) also needs network_mode = personal_cloud in Manager's config.ini, or it refuses the download.";

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
  const manager = fetching ? downloads.data?.manager : undefined;
  return (
    <Card title="Missing models">
      <Row
        setting="server.downloadModels"
        label="Download missing models"
        sub="through ComfyUI-Manager"
        help={`On: a missing model file gets a "Download" button, from the URL the workflow's author gave, or from Civitai once it is found there. ComfyUI-Manager saves it in the right models folder; the file passes through Afflatus, which shows the progress. Nothing is downloaded until you press the button. Off: Afflatus never asks ComfyUI to download anything; missing models only get links to open in your browser.`}
      >
        <Toggle bare on={fetching} onChange={(v) => save.mutate({ downloadModels: v })} label="Download missing models into ComfyUI (ComfyUI-Manager)" />
      </Row>
      {manager && (manager.found ? (
        <Row label="ComfyUI-Manager"><Status ok>found{manager.version ? ` · ${manager.version}` : ""}</Status></Row>
      ) : (
        <Row tone="warn" label="ComfyUI-Manager not found" help={`Downloading needs ComfyUI-Manager in your ComfyUI, and it was not found (or ComfyUI is not answering). ${MANAGER_HOWTO}`}>
          <Link href="/settings" className={warnButton}>Test again in ComfyUI</Link>
        </Row>
      ))}
      {(downloads.data?.items.length ?? 0) > 0 && (
        <Block className="gap-1.5">
          {downloads.data!.items.map((d) => <DownloadRow key={d.id} d={d} named />)}
        </Block>
      )}
      <Row
        setting="server.civitaiLookups"
        label="Search Hugging Face and Civitai"
        help={`On: when a model file is missing, "Search" asks Hugging Face for a file of exactly that name, and Civitai (civitai.com and civitai.red) for models with a close name. Only the filename is sent, and only when you press the button. What is found is shown with a link, and with a Download button when downloading is on. Off: Afflatus never contacts Hugging Face or Civitai; missing models still get links that open a search in your browser.`}
      >
        <Toggle bare on={on} onChange={(v) => save.mutate({ civitaiLookups: v })} label="Search Hugging Face and Civitai for missing models" />
      </Row>
      {on && (
        <Row setting="models.civitaiKey" label="Civitai API key" sub={settings.data?.hasCivitaiKey ? "one is saved" : undefined} help="Only needed for models Civitai hides from visitors without an account. Kept by Afflatus, never shown again.">
          <input type="password" aria-label="Civitai API key" value={key} autoComplete="off" placeholder={settings.data?.hasCivitaiKey ? "leave empty to keep it" : "none"} onChange={(e) => setKey(e.target.value)} className={cx("h-10 min-w-0 grow font-mono text-xs placeholder:font-sans", fieldClass)} />
          <Button onClick={() => save.mutate({ civitaiKey: key })} disabled={!key || save.isPending}>Save</Button>
          {settings.data?.hasCivitaiKey && <Button onClick={() => save.mutate({ civitaiKey: "" })} disabled={save.isPending}>Remove key</Button>}
        </Row>
      )}
      {save.isError && <Block><ErrorNote>{save.error.message}</ErrorNote></Block>}
    </Card>
  );
}
