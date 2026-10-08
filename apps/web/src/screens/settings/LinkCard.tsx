import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useSettings } from "../../data";
import { size } from "../../format";
import { Select } from "../../Select";
import { Button, cx, ErrorNote, fieldClass } from "../../ui";

/**
 * A model from a link: the address of a model's page on Civitai or of a file on Hugging Face is pasted,
 * what it leads to is shown (its files, their sizes, the folder it most likely belongs in), and the file
 * picked is fetched into ComfyUI like any other download.
 */
export function LinkCard() {
  const settings = useSettings();
  const client = useQueryClient();
  const [link, setLink] = useState("");
  const [file, setFile] = useState("");
  const [folder, setFolder] = useState("");
  const [saveAs, setSaveAs] = useState("");
  const look = useMutation({
    mutationFn: async (address: string) => {
      const found = await api.resolveLink(address);
      // a page that lists no file (a model with no download, a version taken down) is said, not thrown on
      if (!found.files.length) throw new Error("This page lists no file to download.");
      return found;
    },
    onSuccess: (found) => {
      // the largest file first: of the same model, it is the least compressed one
      const first = [...found.files].sort((a, b) => b.bytes - a.bytes)[0]!;
      setFile(first.name);
      setSaveAs(first.name);
      setFolder(found.folder && found.folders.includes(found.folder) ? found.folder : "");
    },
  });
  const found = look.data;
  const start = useMutation({
    mutationFn: () => {
      const page = { url: found!.page, title: found!.title };
      const name = saveAs.trim() || file;
      return found!.source === "civitai"
        ? api.startDownload({ file: name, folder, civitai: found!.version!, pick: file, page })
        : api.startDownload({ file: name, folder, url: found!.url!, page });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["downloads"] }),
  });
  if (!settings.data?.downloadModels) return null;
  const chosen = found?.files.find((f) => f.name === file);
  const already = found?.have[file];
  const field = `h-10 min-w-0 text-xs ${fieldClass}`;
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <h2 className="text-[15px] font-bold">Download a model from a URL</h2>
      <div className="text-ink-2">Paste the URL of a model page on Civitai (civitai.com or civitai.red), or of a file on Hugging Face. Afflatus shows what it is and downloads the file you pick into the ComfyUI models folder you choose.</div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          start.reset();
          if (link.trim()) look.mutate(link.trim());
        }}
      >
        <input aria-label="Model URL" value={link} placeholder="https://civitai.com/models/…  or  https://huggingface.co/…/resolve/main/….safetensors" spellCheck={false} onChange={(e) => setLink(e.target.value)} className={cx(field, "grow font-mono")} />
        <Button type="submit" disabled={!link.trim() || look.isPending}>{look.isPending ? "Resolving…" : "Resolve"}</Button>
      </form>
      {look.isError && <ErrorNote>{look.error.message}</ErrorNote>}
      {found && (
        <div className="flex flex-col gap-2.5 rounded-lg border border-line p-3">
          <div className="flex flex-col">
            <a href={found.page} target="_blank" rel="noreferrer" className="font-semibold break-words hover:underline">{found.title}</a>
            <span className="text-xs text-ink-2">{found.about}</span>
          </div>
          {(found.versions?.length ?? 0) > 1 && (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-2">Version</span>
              <Select
                label="Version"
                value={String(found.version)}
                onChange={(id) => look.mutate(`${found.page.split("?")[0]}?modelVersionId=${id}`)}
                options={found.versions!.map((v) => ({ value: String(v.id), label: v.name }))}
              />
            </label>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-2">File{found.files.length > 1 ? ` (${found.files.length} to choose from)` : ""}</span>
            <Select
              label="File"
              value={file}
              onChange={(name) => { setFile(name); setSaveAs(name); }}
              options={found.files.map((f) => ({ value: f.name, label: f.name, note: [f.note, f.bytes ? size(f.bytes) : ""].filter(Boolean).join(" · "), detail: found.have[f.name] ? `ComfyUI already has a file of this name, in ${found.have[f.name]}` : undefined }))}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-xs text-ink-2">Models folder</span>
              <Select label="The ComfyUI models folder it goes into" placeholder="Choose a folder" value={folder} onChange={setFolder} options={found.folders.map((f) => ({ value: f, label: f, note: f === found.folder ? "suggested" : undefined }))} />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-xs text-ink-2">Filename</span>
              <input aria-label="Filename it is saved under" value={saveAs} spellCheck={false} onChange={(e) => setSaveAs(e.target.value)} className={cx(field, "font-mono")} />
            </label>
          </div>
          {found.why && <div className="text-xs text-ink-2">{found.why}</div>}
          {already && <div className="text-xs text-warn-ink">ComfyUI already has a file called {file}, in {already}.</div>}
          <div className="flex flex-wrap items-center gap-3">
            <Button tone="primary" disabled={!folder || !file || start.isPending} onClick={() => start.mutate()}>
              {start.isPending ? "Starting…" : `Download into ComfyUI${chosen?.bytes ? ` · ${size(chosen.bytes)}` : ""}`}
            </Button>
            {start.isSuccess && <span className="text-ink-2">Started: it shows under "Missing models" above, and at the bottom of every screen.</span>}
          </div>
          {start.isError && <ErrorNote>{start.error.message}</ErrorNote>}
        </div>
      )}
    </section>
  );
}
