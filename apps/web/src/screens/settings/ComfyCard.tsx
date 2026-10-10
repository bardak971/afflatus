import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useSettings, useSetup } from "../../data";
import { gb } from "../../format";
import { Slider } from "../../Slider";
import { Button, ButtonLink, cx, ErrorNote, fieldClass } from "../../ui";
import { Block, Card, Fact, Row, Status } from "./Rows";
import { queryKeys } from "../../queryKeys";

const WHY_PACK = "It lets MiniMax H3 clips on a timeline continue from the clip before's own latent (the motion, the look and the voice carry across the join), and lets Afflatus read model files' headers through ComfyUI when it cannot read its disk.";

/**
 * The stops of "Unload models after", in minutes: a few minutes to a day, more of them where a choice matters
 * (5 or 10 minutes, not 731 or 732). 0 is never.
 */
const UNLOAD = [0, 5, 10, 15, 30, 60, 120, 240, 480, 1440];
/** The stop nearest a saved value (one saved before the stops, or typed into the API). */
const stopOf = (minutes: number) => (minutes <= 0 ? 0 : UNLOAD.reduce((best, v, i) => (i > 0 && Math.abs(v - minutes) < Math.abs(UNLOAD[best]! - minutes) ? i : best), 1));
const unloadSaid = (minutes: number) => (minutes <= 0 ? "never" : minutes < 60 ? `${minutes} min` : `${+(minutes / 60).toFixed(1)} h`);

/** Afflatus's node pack (MiniMax H3 continued in the latent): written into ComfyUI's folder when it is known, loaded after a ComfyUI restart. */
function NodePackRow() {
  const settings = useSettings();
  const pack = useQuery({ queryKey: queryKeys.nodePack(settings.data?.comfyDir), queryFn: api.nodePack, enabled: Boolean(settings.data), staleTime: 30_000 });
  if (!pack.data) return null;
  const p = pack.data;
  if (p.loaded) return <Row setting="comfy.pack" label="Node pack" help={WHY_PACK}><Status ok>Loaded</Status></Row>;
  if (p.written) {
    return (
      <Row setting="comfy.pack" tone="warn" label="Node pack: restart ComfyUI" help={`Afflatus's node pack was written to ComfyUI's custom_nodes folder: restart ComfyUI to load it. ${WHY_PACK}`}>
        <span className="text-xs text-warn-ink">written to custom_nodes</span>
      </Row>
    );
  }
  if (p.canWrite) {
    return <Row setting="comfy.pack" label="Node pack" help={`With the folder set, Afflatus puts its node pack in ComfyUI's custom_nodes. ${WHY_PACK}`}><span className="text-xs text-ink-3">goes into custom_nodes with the folder set</span></Row>;
  }
  return (
    <Row
      setting="comfy.pack"
      tone="warn"
      label="Node pack not installed"
      help={`ComfyUI's folder is not on this computer, so Afflatus cannot write its node pack there. Install it once by hand: download it, unpack it into ComfyUI's custom_nodes folder (it makes custom_nodes/afflatus-nodes/) and restart ComfyUI. ${WHY_PACK}`}
    >
      {/* a link (the zip is a download), drawn as the kit's danger button */}
      <ButtonLink href="/api/comfy/node-pack.zip" download tone="danger" size="sm">Download the node pack</ButtonLink>
    </Row>
  );
}

/** ComfyUI's address and folder, the test, and when its models are unloaded. */
export function ComfyCard() {
  const settings = useSettings();
  const setup = useSetup();
  const client = useQueryClient();
  const [url, setUrl] = useState("");
  const [dir, setDir] = useState("");
  // the boxes follow the saved values when those change, not every time the settings are read again (an address being typed stays)
  const savedUrl = settings.data?.comfyUrl;
  const savedDir = settings.data?.comfyDir;
  useEffect(() => {
    if (savedUrl !== undefined) setUrl(savedUrl);
  }, [savedUrl]);
  useEffect(() => {
    if (savedDir !== undefined) setDir(savedDir);
  }, [savedDir]);
  const unload = useMutation({ mutationFn: (minutes: number) => api.saveSettings({ unloadAfterMinutes: minutes }), onSuccess: (saved) => client.setQueryData(queryKeys.settings(), saved) });
  // the slider's value while it moves; saved only where it is let go
  const savedUnload = settings.data?.unloadAfterMinutes;
  const [minutes, setMinutes] = useState(0);
  useEffect(() => {
    if (savedUnload !== undefined) setMinutes(savedUnload);
  }, [savedUnload]);
  const saveDir = useMutation({
    mutationFn: () => api.saveSettings({ comfyDir: dir.trim() }),
    onSuccess: (saved) => client.setQueryData(queryKeys.settings(), saved),
  });
  /** Save the address if it changed, then ask ComfyUI again. Only reads: nothing is queued or loaded. */
  const test = useMutation({
    mutationFn: async () => {
      if (url !== settings.data?.comfyUrl) await api.saveSettings({ comfyUrl: url });
      return api.rescanSetup();
    },
    onSuccess: (scan) => {
      client.setQueryData(queryKeys.setup(), scan);
      void client.invalidateQueries({ queryKey: queryKeys.settings() });
    },
  });
  const comfy = setup.data?.comfy;
  return (
    <div className="flex flex-col gap-4">
      <Card id="comfyui" title="Connection" status={comfy && <Status ok={comfy.online}>{comfy.online ? "Connected" : "Not answering"}</Status>}>
        <Row setting="comfy.url" label="ComfyUI URL" htmlFor="comfy-url" help="The address ComfyUI listens on (8188 unless started with --port). Test again saves it first when it changed. Testing only reads what ComfyUI has: it never starts a render or loads a model.">
          <input id="comfy-url" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} className={cx("h-10 min-w-0 grow font-mono text-xs", fieldClass)} />
          <Button onClick={() => test.mutate()} disabled={test.isPending}>{test.isPending ? "Connecting…" : url !== settings.data?.comfyUrl ? "Save and test" : "Test again"}</Button>
        </Row>
        {(test.isError || comfy?.online === false) && (
          <Block>
            {test.isError && <ErrorNote>{test.error.message}</ErrorNote>}
            {comfy?.online === false && <ErrorNote>{comfy.error}</ErrorNote>}
          </Block>
        )}
        {comfy?.online && (
          <Row label="ComfyUI" start>
            <Fact tip="ComfyUI version">v{comfy.version.replace(/^v/, "")}</Fact>
            <Fact tip={`${comfy.device}: ${gb(comfy.vramTotal)} VRAM, ${gb(comfy.vramFree)} free`}><span className="max-w-[340px] truncate">{comfy.device} · {gb(comfy.vramTotal)} · {gb(comfy.vramFree).replace(" GB", "")} free</span></Fact>
            <Fact tip="Node types this ComfyUI has">{comfy.nodes} nodes</Fact>
          </Row>
        )}
        <Row setting="comfy.folder" label="Folder on this computer" htmlFor="comfy-dir" help={`Optional: ComfyUI's own folder, the one with main.py. It lets "Open in ComfyUI" show the workflow straight away, and Afflatus write its node pack into custom_nodes. Leave it empty when ComfyUI runs on another computer.`}>
          <input id="comfy-dir" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="D:\ComfyUI  —  empty when ComfyUI runs elsewhere" spellCheck={false} className={cx("h-10 min-w-0 grow font-mono text-xs", fieldClass)} />
          <Button onClick={() => saveDir.mutate()} disabled={saveDir.isPending || dir.trim() === (settings.data?.comfyDir ?? "")}>Save</Button>
        </Row>
        {saveDir.isError && <Block><ErrorNote>{saveDir.error.message}</ErrorNote></Block>}
        <NodePackRow />
      </Card>

      {settings.data && (
        <Card title="VRAM">
          <Row setting="comfy.unload" label="Unload models after" help={`Minutes without a render, then ComfyUI's models are unloaded and the VRAM is freed; the next render loads them again. 0 = never: they stay loaded until something else needs the VRAM. "Unload models" in the Queue does it by hand.`}>
            {/* a stepped scale: the slider walks the stops, what is saved is the stop's minutes */}
            <Slider label="Minutes without a render before ComfyUI's models are unloaded" value={stopOf(minutes)} min={0} max={UNLOAD.length - 1} box={false} format={(i) => unloadSaid(UNLOAD[i]!)} onChange={(i) => setMinutes(UNLOAD[i]!)} onCommit={(i) => unload.mutate(UNLOAD[i]!)} className="max-w-[320px] grow" />
            <span className="w-16 shrink-0 text-right font-mono text-xs text-ink">{unloadSaid(minutes)}</span>
          </Row>
          {unload.isError && <Block><ErrorNote>{unload.error.message}</ErrorNote></Block>}
        </Card>
      )}
    </div>
  );
}
