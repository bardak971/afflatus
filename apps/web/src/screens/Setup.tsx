import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useRecipes, useSettings, useSetup, useStorage } from "../data";
import { Link } from "wouter";
import { fileLabel, gb, recipeLabel, size } from "../format";
import { allowNotifications, useNotify } from "../store";
import { DownloadRow, GetFile, useDownloads } from "../GetFile";
import { Button, cx, ErrorNote, Toggle } from "../ui";

/** Where the space goes, and the two ways to get some back. */
function StorageCard() {
  const storage = useStorage();
  const client = useQueryClient();
  const [emptying, setEmptying] = useState(false);
  const done = () => {
    void client.invalidateQueries({ queryKey: ["assets"] });
    void client.invalidateQueries({ queryKey: ["timelines"] });
  };
  const idle = useMutation({ mutationFn: api.binIdleTakes, onSuccess: done });
  const empty = useMutation({ mutationFn: api.emptyBin, onSuccess: done });
  const s = storage.data;
  const parts = s ? [
    { label: "Videos that play, or are in your library", bytes: s.videos, tone: "bg-accent" },
    { label: "Takes that never play", bytes: s.idleTakes.bytes, tone: "bg-warn" },
    { label: "Pictures", bytes: s.pictures, tone: "bg-picture" },
    { label: "Sounds", bytes: s.sounds, tone: "bg-good" },
    { label: "Bin", bytes: s.bin.bytes, tone: "bg-ink-3" },
  ] : [];
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-bold">Storage</h2>
        {s && <span className="text-ink-2">{size(s.total)} used</span>}
      </div>
      {storage.isError && <ErrorNote>{storage.error.message}</ErrorNote>}
      {s && s.total > 0 && (
        <div className="flex h-2.5 overflow-hidden rounded-full bg-line">
          {parts.map((p) => <div key={p.label} className={p.tone} style={{ width: `${(p.bytes / s.total) * 100}%` }} />)}
        </div>
      )}
      {s && (
        <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2.5 gap-y-1.5">
          {parts.map((p) => (
            <div key={p.label} className="contents">
              <span className={cx("h-2.5 w-2.5 rounded-sm", p.tone)} />
              <dt className="text-ink-2">{p.label}</dt>
              <dd className="font-mono">{size(p.bytes)}</dd>
            </div>
          ))}
        </dl>
      )}
      {s && s.idleTakes.count > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2.5">
          <span>{s.idleTakes.count} take{s.idleTakes.count > 1 ? "s are" : " is"} not the one that plays in {s.idleTakes.count > 1 ? "their" : "its"} clip.</span>
          <Button size="sm" disabled={idle.isPending} onClick={() => idle.mutate()}>Move {s.idleTakes.count > 1 ? "them" : "it"} to the bin · {size(s.idleTakes.bytes)}</Button>
        </div>
      )}
      {s && s.bin.count > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2.5">
          <span>Bin: {s.bin.count} thing{s.bin.count > 1 ? "s" : ""}, kept 7 days before {s.bin.count > 1 ? "they are" : "it is"} deleted.</span>
          {emptying ? (
            <span className="flex items-center gap-1.5">
              <span className="text-xs text-ink-2">This cannot be undone.</span>
              <Button size="sm" tone="danger" disabled={empty.isPending} onClick={() => { empty.mutate(); setEmptying(false); }}>Erase {size(s.bin.bytes)}</Button>
              <Button size="sm" tone="quiet" onClick={() => setEmptying(false)}>Cancel</Button>
            </span>
          ) : (
            <Button size="sm" onClick={() => setEmptying(true)}>Empty it now</Button>
          )}
        </div>
      )}
      {(idle.isError || empty.isError) && <ErrorNote>{(idle.error ?? empty.error)?.message}</ErrorNote>}
      <div className="text-xs text-ink-3">
        Results you do not keep go to the bin after 24 hours{s && s.unkept.count ? ` (${s.unkept.count} now, ${size(s.unkept.bytes)})` : ""}. What is on a timeline is always kept.
      </div>
    </section>
  );
}

/** The language model the designer writes with: any address that speaks the OpenAI way. */
function DesignerCard() {
  const settings = useSettings();
  const client = useQueryClient();
  const [form, setForm] = useState<{ baseUrl: string; model: string; apiKey: string } | null>(null);
  useEffect(() => {
    if (settings.data && !form) setForm({ baseUrl: settings.data.llm.baseUrl, model: settings.data.llm.model, apiKey: "" });
  }, [settings.data, form]);
  const llm = settings.data?.llm;
  const dirty = form && llm ? form.baseUrl !== llm.baseUrl || form.model !== llm.model || form.apiKey !== "" : false;
  const save = async (patch: Record<string, unknown>) => {
    await api.saveSettings({ llm: patch });
    await client.invalidateQueries({ queryKey: ["settings"] });
  };
  const test = useMutation({
    mutationFn: async () => {
      if (form && dirty) await save({ baseUrl: form.baseUrl.trim(), model: form.model.trim(), ...(form.apiKey ? { apiKey: form.apiKey } : {}) });
      setForm((f) => (f ? { ...f, apiKey: "" } : f));
      return api.designerTest();
    },
  });
  const vision = useMutation({ mutationFn: (on: boolean) => save({ vision: on }) });
  const input = "h-10 min-w-0 rounded-lg border border-line bg-raised px-3 font-mono text-xs placeholder:font-sans placeholder:text-ink-3";
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-bold">The designer</h2>
        {test.isSuccess && !dirty && <span className="flex items-center gap-1.5 font-semibold text-good"><span className="h-2 w-2 rounded-full bg-good" /> Answering</span>}
      </div>
      <div className="text-ink-2">Any language model with an OpenAI-style address: one on your computer (LM Studio, Ollama, llama.cpp) or elsewhere. It writes and improves your prompts. Without one, everything else works.</div>
      {form && (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-2">Address of the language model</span>
            <input value={form.baseUrl} placeholder="http://127.0.0.1:1234/v1" spellCheck={false} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} className={input} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-2">Model name</span>
              <input value={form.model} placeholder="as the address lists it" spellCheck={false} onChange={(e) => setForm({ ...form, model: e.target.value })} className={input} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-2">Key {llm?.hasApiKey ? "(one is saved)" : "(if it asks for one)"}</span>
              <input type="password" value={form.apiKey} placeholder={llm?.hasApiKey ? "leave empty to keep it" : "none"} autoComplete="off" onChange={(e) => setForm({ ...form, apiKey: e.target.value })} className={input} />
            </label>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={() => test.mutate()} disabled={test.isPending || !form.baseUrl.trim() || !form.model.trim()}>{test.isPending ? "Asking…" : dirty ? "Save and test" : "Test it"}</Button>
            {test.isSuccess && <span className="text-ink-2">It answered: "{test.data.answer}"</span>}
          </div>
          {test.isError && <ErrorNote>{test.error.message}</ErrorNote>}
          <Toggle on={Boolean(llm?.vision)} onChange={(on) => vision.mutate(on)} label="It can read pictures" />
          <div className="text-xs text-ink-3">
            {llm?.vision
              ? "The designer is shown the picture a form opens on before it writes. Turn this off if the model answers with an error about pictures."
              : "With a model that cannot read pictures, the designer works from your text only, and says so."}
          </div>
        </>
      )}
    </section>
  );
}

/** Whether studai may ask Civitai where a missing file can be had. Off unless turned on here. */
function CivitaiCard() {
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
      <h2 className="text-[15px] font-bold">Finding missing files</h2>
      <Toggle on={fetching} onChange={(v) => save.mutate({ downloadModels: v })} label="Download missing files into ComfyUI" />
      <div className="text-xs text-ink-3">
        {fetching
          ? "A missing model file gets a \"Download\" button: from the address the workflow's author gave, or from Civitai once it is found there. ComfyUI-Manager saves it in the right folder; the file passes through studai, which shows how far it is. Nothing is downloaded until you press the button."
          : "Off: studai never asks ComfyUI to download anything. Missing files only get links to open in your browser."}
      </div>
      {fetching && downloads.data && (
        <div className={cx("text-xs", downloads.data.manager.found ? "text-good" : "text-warn-ink")}>
          {downloads.data.manager.found
            ? `ComfyUI-Manager ${downloads.data.manager.version ?? ""} is there to do it.`
            : "This needs ComfyUI-Manager in your ComfyUI, and it was not found (or ComfyUI is not answering)."}
        </div>
      )}
      {(downloads.data?.items.length ?? 0) > 0 && (
        <div className="flex flex-col gap-1.5">
          {downloads.data!.items.map((d) => <DownloadRow key={d.id} d={d} named />)}
        </div>
      )}
      <Toggle on={on} onChange={(v) => save.mutate({ civitaiLookups: v })} label="Look for missing files on Civitai" />
      <div className="text-xs text-ink-3">
        {on
          ? "When a model file is missing, \"Find it\" asks Civitai for it by its file name. Only that name is sent, and only when you press the button. What it finds is shown with a link, and with a Download button when downloading is turned on above."
          : "Off: studai never contacts Civitai. Missing files still get a link that opens a search in your browser."}
      </div>
      {on && (
        <div className="flex items-end gap-2">
          <label className="flex min-w-0 grow flex-col gap-1.5">
            <span className="text-xs text-ink-2">Civitai key {settings.data?.hasCivitaiKey ? "(one is saved)" : "(only needed for models hidden without an account)"}</span>
            <input type="password" value={key} autoComplete="off" placeholder={settings.data?.hasCivitaiKey ? "leave empty to keep it" : "none"} onChange={(e) => setKey(e.target.value)} className="h-10 min-w-0 rounded-lg border border-line bg-raised px-3 font-mono text-xs placeholder:font-sans placeholder:text-ink-3" />
          </label>
          <Button onClick={() => save.mutate({ civitaiKey: key })} disabled={!key || save.isPending}>Save</Button>
          {settings.data?.hasCivitaiKey && <Button onClick={() => save.mutate({ civitaiKey: "" })} disabled={save.isPending}>Forget it</Button>}
        </div>
      )}
      {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
    </section>
  );
}

/** What this browser tells you about. */
function NotifyCard() {
  const notify = useNotify();
  const [refused, setRefused] = useState(false);
  const set = async (patch: { whenEmpty?: boolean; eachRender?: boolean }) => {
    if (Object.values(patch).some(Boolean) && !(await allowNotifications())) return setRefused(true);
    setRefused(false);
    notify.set(patch);
  };
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <h2 className="text-[15px] font-bold">Notifications</h2>
      <Toggle on={notify.eachRender} onChange={(on) => void set({ eachRender: on })} label="Tell me when a render finishes" />
      <Toggle on={notify.whenEmpty} onChange={(on) => void set({ whenEmpty: on })} label="Tell me when the queue is empty" />
      <div className="text-xs text-ink-3">
        {refused ? "Your browser does not allow notifications from this page. Allow them in its settings, next to the address." : "A notification from your browser, while a studai tab is open in it. Nothing leaves your computer. This is set per browser."}
      </div>
    </section>
  );
}

export function Setup() {
  const settings = useSettings();
  const setup = useSetup();
  const recipes = useRecipes();
  const client = useQueryClient();
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (settings.data) setUrl(settings.data.comfyUrl);
  }, [settings.data]);

  /** Save the address if it changed, then ask ComfyUI again. Only reads: nothing is queued or loaded. */
  const test = useMutation({
    mutationFn: async () => {
      if (url !== settings.data?.comfyUrl) await api.saveSettings({ comfyUrl: url });
      return api.setup(true);
    },
    onSuccess: (scan) => {
      client.setQueryData(["setup"], scan);
      void client.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const comfy = setup.data?.comfy;
  const ready = setup.data?.recipes.filter((r) => r.ready).length ?? 0;

  return (
    <div className="flex min-h-0 grow flex-col overflow-y-auto px-8 pb-8">
      <header className="flex h-20 shrink-0 flex-col justify-center">
        <h1 className="text-xl font-semibold">Setup</h1>
        <div className="text-ink-2">What studai is connected to, and what is ready.</div>
      </header>

      <div className="grid grid-cols-2 items-start gap-5">
        <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
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
            <label htmlFor="comfy-url" className="text-xs text-ink-2">Where ComfyUI runs</label>
            <div className="flex gap-2">
              <input
                id="comfy-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                spellCheck={false}
                className="h-10 min-w-0 grow rounded-lg border border-line bg-raised px-3 font-mono text-xs"
              />
              <Button onClick={() => test.mutate()} disabled={test.isPending}>{test.isPending ? "Asking…" : url !== settings.data?.comfyUrl ? "Save and test" : "Test again"}</Button>
            </div>
          </div>
          {test.isError && <ErrorNote>{test.error.message}</ErrorNote>}
          {comfy?.online === false && <ErrorNote>{comfy.error}</ErrorNote>}
          {comfy?.online && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-ink-2">
              <dt>Version</dt><dd className="text-ink">{comfy.version}</dd>
              <dt>Graphics card</dt><dd className="text-ink">{comfy.device}</dd>
              <dt>Card memory</dt><dd className="text-ink">{gb(comfy.vramTotal)} ({gb(comfy.vramFree)} free)</dd>
              <dt>Node types</dt><dd className="text-ink">{comfy.nodes}</dd>
            </dl>
          )}
          <div className="text-xs text-ink-3">Testing only reads what ComfyUI has. It never starts a render or loads a model.</div>
        </section>

        <div className="col-start-1 flex flex-col gap-5">
          <DesignerCard />
          <StorageCard />
          <CivitaiCard />
          <NotifyCard />
        </div>

        <section className="col-start-2 row-span-2 row-start-1 flex flex-col gap-2.5 rounded-xl border border-line bg-panel p-[18px]">
          <h2 className="text-[15px] font-bold">What is ready</h2>
          {setup.isLoading && <div className="text-ink-2">Asking ComfyUI…</div>}
          {setup.isError && <ErrorNote>{setup.error.message}</ErrorNote>}
          {setup.data && <div className="text-ink-2">{ready} of {recipes.data?.recipes.length ?? 0} ready.</div>}
          {recipes.data?.recipes.map((r) => {
            const s = setup.data?.recipes.find((x) => x.id === r.id);
            const family = recipes.data.families.find((f) => f.id === r.family);
            const problems = [
              ...(s?.missingNodes.length ? [`Missing nodes: ${s.missingNodes.join(", ")}`] : []),
              ...(s?.missingSlots.length ? [`Missing files: ${s.missingSlots.join(", ")}`] : []),
              ...(s?.emptyInputs ?? []).map((id) => {
                const input = r.inputs.find((i) => i.id === id);
                return `ComfyUI has no file to pick for "${input?.label ?? id}"${input?.note ? ` (${input.note})` : ""}`;
              }),
            ];
            const find = (file: string) => encodeURIComponent(fileLabel(file));
            return (
              <div key={r.id} className="flex flex-col gap-1 rounded-lg border border-line px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold">{recipeLabel(family?.name, r.title)}</span>
                  <span className={cx("shrink-0 font-semibold", s?.ready ? "text-good" : "text-warn-ink")}>{s ? (s.ready ? "Ready" : "Not ready") : "Unknown"}</span>
                </div>
                {problems.map((p) => <div key={p} className="text-warn-ink">{p}</div>)}
                {(s?.missing ?? []).map(({ file, folder, url }) => (
                  <div key={file} className="text-warn-ink">
                    Your ComfyUI does not have <span className="font-semibold break-all">{fileLabel(file)}</span>. Search for it on{" "}
                    <a className="font-semibold underline" href={`https://civitai.com/search/models?query=${find(file)}`} target="_blank" rel="noreferrer">Civitai</a> or{" "}
                    <a className="font-semibold underline" href={`https://huggingface.co/models?search=${find(file)}`} target="_blank" rel="noreferrer">Hugging Face</a>
                    {r.id.startsWith("workflow.") && <>, or pick another file for it: <Link href="/workflows" className="font-semibold underline">Workflows</Link>, then Change</>}.
                    <GetFile file={file} folder={folder} url={url} />
                  </div>
                ))}
                {s?.limitedBy.length ? <div className="text-ink-2">Some options are off, missing nodes: {s.limitedBy.join(", ")}</div> : null}
                {s?.ready && (
                  <div className="text-xs text-ink-2">
                    {Object.entries(s.options).map(([k, v]) => `${r.inputs.find((i) => i.id === k)?.label ?? k}: ${v.length}`).join(" · ")}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}
