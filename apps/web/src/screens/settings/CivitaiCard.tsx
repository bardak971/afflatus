import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { api, type SettingsPatch } from "../../api";
import { useSettings } from "../../data";
import { DownloadRow, useDownloads } from "../../GetFile";
import { MANAGER_CAUTION, NO_ROUTE } from "../../useGetFile";
import { Button, buttonClass, cx, ErrorNote, fieldClass, Toggle } from "../../ui";
import { Block, Card, Row, Status } from "./Rows";
import { queryKeys } from "../../queryKeys";

const MANAGER_HOWTO = "ComfyUI has ComfyUI-Manager built in since 0.3.7x, off until asked for: in ComfyUI's folder run pip install -r manager_requirements.txt with its own Python (the venv's, or python_embeded in the portable build), then start ComfyUI with --enable-manager. On an older ComfyUI, clone https://github.com/Comfy-Org/ComfyUI-Manager into its custom_nodes folder instead. Either way, restart ComfyUI, then Test again in the ComfyUI tab. The desktop build has it on already. A ComfyUI that listens on the network (--listen) also needs network_mode = personal_cloud in Manager's config.ini, or it refuses the download.";

/** Whether Afflatus may ask Civitai where a missing file can be had. Off unless turned on here. */
export function CivitaiCard() {
  const settings = useSettings();
  const client = useQueryClient();
  const [key, setKey] = useState("");
  const [hfToken, setHfToken] = useState("");
  const save = useMutation({
    mutationFn: (patch: SettingsPatch) => api.saveSettings(patch),
    onSuccess: () => {
      setKey("");
      setHfToken("");
      // whether ComfyUI-Manager is there is only asked once downloading is turned on
      void client.invalidateQueries({ queryKey: queryKeys.downloads() });
      return client.invalidateQueries({ queryKey: queryKeys.settings() });
    },
  });
  const on = Boolean(settings.data?.civitaiLookups);
  const fetching = Boolean(settings.data?.downloadModels);
  const downloads = useDownloads();
  const manager = fetching ? downloads.data?.manager : undefined;
  const via = fetching ? downloads.data?.via : undefined;
  return (
    <Card title="Missing models">
      <Row
        setting="server.downloadModels"
        label="Download missing models"
        sub={via === "afflatus" ? "straight into ComfyUI's model folders" : via === "pack" ? "through the Afflatus node pack" : via === "manager" ? "through ComfyUI-Manager" : undefined}
        help={`On: a missing model file gets a "Download" button, from the URL the workflow's author gave, or from Civitai once it is found there. When Afflatus can write ComfyUI's model folders (ComfyUI on this machine), it downloads the file there itself: straight to disk, resumed after a cut, named only once complete, two at a time. Otherwise the Afflatus node pack does the same on ComfyUI's machine, or, last, ComfyUI-Manager saves it (the file passes through Afflatus, which shows the progress). Nothing is downloaded until you press the button. Off: Afflatus never downloads anything; missing models only get links to open in your browser.`}
      >
        <Toggle bare on={fetching} onChange={(v) => save.mutate({ downloadModels: v })} label="Download missing models into ComfyUI" />
      </Row>
      {via === "afflatus" && <Row label="Downloads by"><Status ok>Afflatus, into ComfyUI's model folders</Status></Row>}
      {via === "pack" && <Row label="Downloads by"><Status ok>the Afflatus node pack, on ComfyUI's machine</Status></Row>}
      {via === "manager" && manager?.found && (
        <Row tone="warn" label="Downloads by ComfyUI-Manager" help={MANAGER_CAUTION}><Status ok>found{manager.version ? ` · ${manager.version}` : ""}</Status></Row>
      )}
      {via === "none" && (
        <Row tone="warn" label="Nothing can download" help={`${NO_ROUTE} ${MANAGER_HOWTO}`}>
          <Link href="/settings" className={buttonClass({ tone: "danger", size: "sm" })}>Test again in ComfyUI</Link>
        </Row>
      )}
      {(downloads.data?.items.length ?? 0) > 0 && (
        <Block className="gap-1.5">
          {downloads.data!.items.map((d) => <DownloadRow key={d.id} d={d} named />)}
        </Block>
      )}
      <Row
        setting="server.civitaiLookups"
        label="Search Hugging Face and Civitai"
        help={`On: when a model file is missing, "Search" asks Hugging Face for a file of exactly that name, and Civitai (civitai.com and civitai.red) for models with a close name. What is found is shown with a link, and with a Download button when downloading is on. Your own model files are also matched once to the site that has them, so that a rented GPU fetches them from there instead of from this PC: Civitai is sent each file's SHA-256 (a fingerprint of its content, not the file), Hugging Face its name. Off: Afflatus never contacts Hugging Face or Civitai; missing models still get links that open a search in your browser.`}
      >
        <Toggle bare on={on} onChange={(v) => save.mutate({ civitaiLookups: v })} label="Search Hugging Face and Civitai for missing models" />
      </Row>
      {/* a saved key says so in the ok colour, and the box shows it as dots (never the key: it is not sent back) */}
      {on && (
        <Row setting="models.civitaiKey" label="Civitai API key" sub={settings.data?.hasCivitaiKey ? <span className="text-good">✓ saved</span> : undefined} help="Only needed for models Civitai hides from visitors without an account. Kept by Afflatus, never shown again.">
          <input type="password" aria-label="Civitai API key" value={key} autoComplete="off" placeholder={settings.data?.hasCivitaiKey ? "•••••••••••••••• · type a new one to replace it" : "none"} onChange={(e) => setKey(e.target.value)} className={cx("h-10 min-w-0 grow font-mono text-xs placeholder:font-sans", fieldClass)} />
          <Button onClick={() => save.mutate({ civitaiKey: key })} disabled={!key || save.isPending}>Save</Button>
          {settings.data?.hasCivitaiKey && <Button onClick={() => save.mutate({ civitaiKey: "" })} disabled={save.isPending}>Remove key</Button>}
        </Row>
      )}
      {on && (
        <Row setting="models.huggingFaceToken" label="Hugging Face token" sub={settings.data?.hasHuggingFaceToken ? <span className="text-good">✓ saved</span> : undefined} help="Only needed for gated models (Flux dev and others): a Hugging Face access token (huggingface.co › Settings › Access Tokens, read), whose account accepted the model's terms on its page. Kept by Afflatus, never shown again.">
          <input type="password" aria-label="Hugging Face token" value={hfToken} autoComplete="off" placeholder={settings.data?.hasHuggingFaceToken ? "•••••••••••••••• · type a new one to replace it" : "none"} onChange={(e) => setHfToken(e.target.value)} className={cx("h-10 min-w-0 grow font-mono text-xs placeholder:font-sans", fieldClass)} />
          <Button onClick={() => save.mutate({ huggingFaceToken: hfToken })} disabled={!hfToken || save.isPending}>Save</Button>
          {settings.data?.hasHuggingFaceToken && <Button onClick={() => save.mutate({ huggingFaceToken: "" })} disabled={save.isPending}>Remove token</Button>}
        </Row>
      )}
      {save.isError && <Block><ErrorNote>{save.error.message}</ErrorNote></Block>}
    </Card>
  );
}
