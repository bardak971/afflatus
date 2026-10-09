import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { api, type ModelPage } from "./api";
import { useModelPages } from "./data";
import { fileLabel } from "./format";
import { cx, fieldClass, Help } from "./ui";

const CIVITAI = /^https?:\/\/(www\.)?civitai\.(com|red)(?=\/|$)/i;
/** The same page on Civitai's two sites: what one hides the other shows, and a model has the same number on both. */
const onSite = (url: string, site: "com" | "red") => url.replace(CIVITAI, `https://civitai.${site}`);

const item = "flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover";

/**
 * A model file's name (a LoRA, mostly) as something to click: a small menu with the page it came from,
 * on civitai.com, civitai.red or Hugging Face. A file does not say where it is from, so the first click
 * looks for it by name; a page found for sure, or picked among those offered, is remembered.
 */
export function ModelLink({ folder, file, className }: { folder: string; file: string; className?: string }) {
  const pages = useModelPages(folder);
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const [own, setOwn] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const name = (file.split(/[\\/]/).pop() ?? file).toLowerCase();
  const label = fileLabel(file);
  const page = pages.data?.items[name];
  const keep = (found: ModelPage | null) =>
    client.setQueryData<{ items: Record<string, ModelPage> }>(["model-pages", folder], (old) => {
      const items = { ...(old?.items ?? {}) };
      if (found) items[name] = found;
      else delete items[name];
      return { items };
    });
  const find = useMutation({ mutationFn: () => api.findModelPage(folder, file), onSuccess: (r) => r.page && keep(r.page) });
  const set = useMutation({ mutationFn: (p: { url: string | null; title?: string }) => api.setModelPage(folder, file, p.url, p.title), onSuccess: (r) => keep(r.page) });

  const toggle = () => {
    if (open) return setOpen(false);
    setOpen(true);
    setOwn("");
    if (!page && !find.data && !find.isPending) find.mutate();
  };
  // under the name when there is room, above it otherwise: drawn over everything, so no panel cuts it off
  useLayoutEffect(() => {
    if (!open) return;
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 340 - 8));
    setPlace(window.innerHeight - r.bottom > 300 || r.top < 300 ? { left, top: r.bottom + 4 } : { left, bottom: window.innerHeight - r.top + 4 });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const scrolled = (e: Event) => !panel.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  const words = encodeURIComponent(label.replace(/[_-]+/g, " "));
  const out = (href: string, text: string, note?: string) => (
    <a key={href} href={href} target="_blank" rel="noreferrer" onClick={() => setOpen(false)} className={item}>
      <ExternalLink size={13} className="shrink-0 text-ink-2" />
      <span className="flex min-w-0 grow flex-col">
        <span className="truncate">{text}</span>
        {note && <span className="truncate text-xs text-ink-2">{note}</span>}
      </span>
    </a>
  );
  const candidates = find.data?.candidates ?? [];

  return (
    <>
      <button
        ref={button}
        type="button"
        data-tip={`${file}\nClick for its model page on Civitai or Hugging Face`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: model page`}
        onClick={toggle}
        className={cx("truncate text-left underline decoration-line-strong decoration-dotted underline-offset-4 hover:decoration-ink", className)}
      >
        {label}
      </button>
      {open && place && createPortal(
        <div
          ref={panel}
          role="menu"
          aria-label={`Model page of ${label}`}
          style={{ left: place.left, top: place.top, bottom: place.bottom }}
          className="fixed z-[75] flex max-h-[min(420px,80vh)] w-[340px] flex-col gap-0.5 overflow-y-auto rounded-xl border border-line-strong bg-panel p-1.5 text-sm shadow-2xl shadow-shade/60"
        >
          {page ? (
            <>
              <span className="px-2 pt-1 text-xs font-semibold text-ink-2">Model page</span>
              {CIVITAI.test(page.url)
                ? [out(onSite(page.url, "com"), "Open on civitai.com", page.title), out(onSite(page.url, "red"), "Open on civitai.red", page.title)]
                : out(page.url, `Open on ${new URL(page.url).hostname.replace(/^www\./, "")}`, page.title)}
              <button type="button" className={cx(item, "text-ink-2")} disabled={set.isPending} onClick={() => { set.mutate({ url: null }); find.reset(); }}>Wrong page: unlink</button>
            </>
          ) : (
            <>
              {(find.isPending || pages.isPending) && <span className="px-2 py-1.5 text-ink-2">Searching for its model page…</span>}
              {find.isError && <span className="px-2 py-1.5 text-warn-ink">{find.error.message}</span>}
              {find.data && !find.data.lookups && (
                <span className="flex items-center gap-1.5 px-2 py-1.5 text-ink-2">
                  Search Hugging Face and Civitai: off
                  <Link href="/settings/models" className="font-semibold underline" onClick={() => setOpen(false)}>Settings</Link>
                  <Help text="The page is looked for only with this switch on (Settings › Models). Or search by hand below and paste the page URL." />
                </span>
              )}
              {find.data?.lookups && !candidates.length && (
                <span className="flex items-center gap-1.5 px-2 py-1.5 text-ink-2">
                  No match
                  <Help text="Nothing on Hugging Face or Civitai goes by this filename. Search by hand below, then paste the page URL to link it." />
                </span>
              )}
              {candidates.length > 0 && <span className="px-2 pt-1 text-xs font-semibold text-ink-2">No exact filename match. It may be one of these:</span>}
              {candidates.map((c) => (
                <span key={c.url} className="flex items-center gap-1">
                  <a href={c.url} target="_blank" rel="noreferrer" className={cx(item, "min-w-0 grow")}>
                    <ExternalLink size={13} className="shrink-0 text-ink-2" />
                    <span className="flex min-w-0 grow flex-col">
                      <span className="truncate">{c.title}</span>
                      <span className="truncate text-xs text-ink-2">{[c.about, c.site].filter(Boolean).join(" · ")}</span>
                    </span>
                  </a>
                  <button type="button" className="shrink-0 rounded-md border border-line-strong px-2 py-1 text-xs hover:bg-hover" disabled={set.isPending} onClick={() => set.mutate({ url: c.url, title: c.title })}>Link</button>
                </span>
              ))}
              <span className="px-2 pt-1.5 text-xs font-semibold text-ink-2">Search manually</span>
              {out(`https://civitai.com/search/models?query=${words}`, "Search civitai.com")}
              {out(`https://civitai.red/search/models?query=${words}`, "Search civitai.red")}
              {out(`https://huggingface.co/models?search=${words}`, "Search Hugging Face")}
              <form
                className="flex items-center gap-1 px-1 pt-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (own.trim()) set.mutate({ url: own.trim() });
                }}
              >
                <input aria-label="Model page URL" value={own} placeholder="Or paste the model page URL" onChange={(e) => setOwn(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className={cx(fieldClass, "h-8 min-w-0 grow px-2 text-xs")} />
                <button type="submit" disabled={!own.trim() || set.isPending} className="shrink-0 rounded-md border border-line-strong px-2 py-1 text-xs hover:bg-hover disabled:opacity-45">Link</button>
              </form>
              {set.isError && <span className="px-2 py-1 text-xs text-warn-ink">{set.error.message}</span>}
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
