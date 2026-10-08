import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useSettings, useSetup } from "../../data";
import { gb } from "../../format";
import { Button, cx, ErrorNote, NumberBox } from "../../ui";

/** Afflatus's node pack (MiniMax H3 continued in the latent): written into ComfyUI's folder when it is known, loaded after a ComfyUI restart. */
function NodePackLine() {
  const settings = useSettings();
  const pack = useQuery({ queryKey: ["node-pack", settings.data?.comfyDir], queryFn: api.nodePack, enabled: Boolean(settings.data), staleTime: 30_000 });
  if (!pack.data) return null;
  const p = pack.data;
  const why = "It lets MiniMax H3 clips on a timeline continue from the clip before's own latent (the motion, the look and the voice carry across the join), and lets Afflatus read model files' headers through ComfyUI when it cannot read its disk.";
  return (
    <div className="flex flex-col gap-1.5 text-xs text-ink-2">
      {p.loaded ? (
        <span>Afflatus's node pack is loaded in ComfyUI. {why}</span>
      ) : p.written ? (
        <span className="text-warn-ink">Afflatus's node pack was written to ComfyUI's custom_nodes folder: <span className="font-semibold">restart ComfyUI</span> to load it. {why}</span>
      ) : p.canWrite ? (
        <span>With the folder set, Afflatus puts its node pack in ComfyUI's custom_nodes. {why}</span>
      ) : (
        <span>
          ComfyUI's folder is not on this computer, so Afflatus cannot write its node pack there. Install it once by hand:{" "}
          <a href="/api/comfy/node-pack.zip" download className="font-semibold text-ink underline">download the node pack</a>, unpack it into ComfyUI's <span className="font-mono">custom_nodes</span> folder (it makes <span className="font-mono">custom_nodes/afflatus-nodes/</span>) and restart ComfyUI. {why}
        </span>
      )}
    </div>
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
  const unload = useMutation({ mutationFn: (minutes: number) => api.saveSettings({ unloadAfterMinutes: minutes }), onSuccess: (saved) => client.setQueryData(["settings"], saved) });
  const saveDir = useMutation({
    mutationFn: () => api.saveSettings({ comfyDir: dir.trim() }),
    onSuccess: (saved) => client.setQueryData(["settings"], saved),
  });
  /** Save the address if it changed, then ask ComfyUI again. Only reads: nothing is queued or loaded. */
  const test = useMutation({
    mutationFn: async () => {
      if (url !== settings.data?.comfyUrl) await api.saveSettings({ comfyUrl: url });
      return api.rescanSetup();
    },
    onSuccess: (scan) => {
      client.setQueryData(["setup"], scan);
      void client.invalidateQueries({ queryKey: ["settings"] });
    },
  });
  const comfy = setup.data?.comfy;
  return (
    <section id="comfyui" className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-bold">ComfyUI</h2>
        {comfy && (
          <span className={cx("flex items-center gap-1.5 font-semibold", comfy.online ? "text-good" : "text-warn-ink")}>
            <span className={cx("h-2 w-2 rounded-full", comfy.online ? "bg-good" : "bg-warn")} />
            {comfy.online ? "Connected" : "Not answering"}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="comfy-url" className="text-xs text-ink-2">ComfyUI URL</label>
        <div className="flex gap-2">
          <input
            id="comfy-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
            className="h-10 min-w-0 grow rounded-lg border border-line bg-raised px-3 font-mono text-xs"
          />
          <Button onClick={() => test.mutate()} disabled={test.isPending}>{test.isPending ? "Connecting…" : url !== settings.data?.comfyUrl ? "Save and test" : "Test again"}</Button>
        </div>
      </div>
      {test.isError && <ErrorNote>{test.error.message}</ErrorNote>}
      {comfy?.online === false && <ErrorNote>{comfy.error}</ErrorNote>}
      {comfy?.online && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-ink-2">
          <dt>Version</dt><dd className="text-ink">{comfy.version}</dd>
          <dt>GPU</dt><dd className="text-ink">{comfy.device}</dd>
          <dt>VRAM</dt><dd className="text-ink">{gb(comfy.vramTotal)} ({gb(comfy.vramFree)} free)</dd>
          <dt>Node types</dt><dd className="text-ink">{comfy.nodes}</dd>
        </dl>
      )}
      <div className="text-xs text-ink-3">Testing only reads what ComfyUI has. It never starts a render or loads a model.</div>
      <div className="flex flex-col gap-1.5 border-t border-line pt-3">
        <label htmlFor="comfy-dir" className="text-xs text-ink-2">ComfyUI folder on this computer <span className="text-ink-3">(optional: the one with main.py; lets "Open in ComfyUI" show the workflow straight away)</span></label>
        <div className="flex gap-2">
          <input
            id="comfy-dir"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="D:\ComfyUI  —  empty when ComfyUI runs elsewhere"
            spellCheck={false}
            className="h-10 min-w-0 grow rounded-lg border border-line bg-raised px-3 font-mono text-xs"
          />
          <Button onClick={() => saveDir.mutate()} disabled={saveDir.isPending || dir.trim() === (settings.data?.comfyDir ?? "")}>Save</Button>
        </div>
        {saveDir.isError && <ErrorNote>{saveDir.error.message}</ErrorNote>}
        <NodePackLine />
      </div>
      {settings.data && (
        <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
          <span className="min-w-0">
            Unload models after
            <span className="block text-xs text-ink-2">{settings.data.unloadAfterMinutes > 0 ? "minutes without a render: the VRAM is freed. The next render loads them again." : "0 = never: they stay loaded until something else needs the VRAM. \"Unload models\" in the Queue does it manually."}</span>
          </span>
          <NumberBox
            label="Minutes without a render before ComfyUI's models are unloaded"
            value={settings.data.unloadAfterMinutes}
            min={0}
            max={1440}
            unit="min"
            onCommit={(v) => unload.mutate(v)}
          />
        </div>
      )}
      {unload.isError && <ErrorNote>{unload.error.message}</ErrorNote>}
    </section>
  );
}
