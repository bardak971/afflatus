import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useSettings } from "../../data";
import { size } from "../../format";
import { Select } from "../../Select";
import { Button, cx, ErrorNote, fieldClass, Help } from "../../ui";
import { Block, Card, Row } from "./Rows";

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
    <Card title={<span className="flex items-center gap-1.5">Download a model from a URL <Help title="Download a model from a URL" text="Paste the URL of a model page on Civitai (civitai.com or civitai.red), or of a file on Hugging Face. Afflatus shows what it is and downloads the file you pick into the ComfyUI models folder you choose." /></span>}>
      <Row label="Model URL">
        <form
          className="flex min-w-0 grow gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            start.reset();
            if (link.trim()) look.mutate(link.trim());
          }}
        >
          <input aria-label="Model URL" value={link} placeholder="https://civitai.com/models/…  or  https://huggingface.co/…/resolve/main/….safetensors" spellCheck={false} onChange={(e) => setLink(e.target.value)} className={cx(field, "grow font-mono")} />
          <Button type="submit" disabled={!link.trim() || look.isPending}>{look.isPending ? "Resolving…" : "Resolve"}</Button>
        </form>
      </Row>
      {look.isError && <Block><ErrorNote>{look.error.message}</ErrorNote></Block>}
      {found && (
        <>
          <Row label={<a href={found.page} target="_blank" rel="noreferrer" className="font-semibold break-words hover:underline">{found.title}</a>} start>
            <span className="text-xs text-ink-2">{found.about}</span>
          </Row>
          {(found.versions?.length ?? 0) > 1 && (
            <Row label="Version">
              <div className="min-w-0 grow">
                <Select
                  label="Version"
                  value={String(found.version)}
                  onChange={(id) => look.mutate(`${found.page.split("?")[0]}?modelVersionId=${id}`)}
                  options={found.versions!.map((v) => ({ value: String(v.id), label: v.name }))}
                />
              </div>
            </Row>
          )}
          <Row label="File" sub={found.files.length > 1 ? `${found.files.length} to choose from` : undefined}>
            <div className="min-w-0 grow">
              <Select
                label="File"
                value={file}
                onChange={(name) => { setFile(name); setSaveAs(name); }}
                options={found.files.map((f) => ({ value: f.name, label: f.name, note: [f.note, f.bytes ? size(f.bytes) : ""].filter(Boolean).join(" · "), detail: found.have[f.name] ? `ComfyUI already has a file of this name, in ${found.have[f.name]}` : undefined }))}
              />
            </div>
          </Row>
          <Row label="Models folder" help={found.why || undefined}>
            <div className="min-w-0 grow">
              <Select label="The ComfyUI models folder it goes into" placeholder="Choose a folder" value={folder} onChange={setFolder} options={found.folders.map((f) => ({ value: f, label: f, note: f === found.folder ? "suggested" : undefined }))} />
            </div>
          </Row>
          <Row label="Filename">
            <input aria-label="Filename it is saved under" value={saveAs} spellCheck={false} onChange={(e) => setSaveAs(e.target.value)} className={cx(field, "grow font-mono")} />
          </Row>
          {already && <Row tone="warn" label="Already in ComfyUI"><span className="truncate text-xs text-warn-ink">{file}, in {already}</span></Row>}
          <Row label="Download" help="The file is fetched into ComfyUI through ComfyUI-Manager. Once started it shows under Missing models above, and at the bottom of every screen.">
            {start.isSuccess && <span className="text-xs text-good">Started</span>}
            <Button tone="primary" disabled={!folder || !file || start.isPending} onClick={() => start.mutate()}>
              {start.isPending ? "Starting…" : `Download into ComfyUI${chosen?.bytes ? ` · ${size(chosen.bytes)}` : ""}`}
            </Button>
          </Row>
          {start.isError && <Block><ErrorNote>{start.error.message}</ErrorNote></Block>}
        </>
      )}
    </Card>
  );
}
