import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { fileKey } from "@afflatus/core";
import { api, type BrowseCard } from "./api";
import { keepTabIn } from "./Dialog";
import { Card } from "./findModels/Card";
import { Opened } from "./findModels/Opened";
import { clearPicked, closeFindModels, pickedOf, useKept, type FindTarget, type HfSort, type PickedFile } from "./findModels/store";
import { Tray } from "./findModels/Tray";
import { Yours } from "./findModels/Yours";
import { useSettled } from "./hooks";
import { Keys } from "./Keys";
import { queryKeys } from "./queryKeys";
import { Select } from "./Select";
import { Checkbox, cx, ErrorNote, SearchField, Segmented } from "./ui";

/**
 * Find models: Civitai's and Hugging Face's models, and the user's own (presets, families, this PC's files), in a large
 * panel over everything; what is picked gathers in Picked, whose button does what the place it was opened from asks
 * (a deploy, a Model set, this PC). Filters start on the user's families. Only with lookups on (Settings › Models).
 */

type Tab = "yours" | "civitai" | "huggingface";
const TYPE_SAID: Record<string, string> = { LORA: "LoRA", LoCon: "LoCon", DoRA: "DoRA", Checkpoint: "Checkpoint", VAE: "VAE", TextEncoder: "Text encoder", Upscaler: "Upscaler", Controlnet: "ControlNet", UNet: "UNet", CLIPVision: "CLIP vision" };
const SORT_SAID: Record<string, string> = { "Most Downloaded": "Most downloaded", "Highest Rated": "Highest rated", "Most Liked": "Most liked", Newest: "Newest" };
const HF_SORTS: Array<{ value: HfSort; label: string }> = [{ value: "downloads", label: "Most downloaded" }, { value: "likes", label: "Most liked" }, { value: "trendingScore", label: "Trending" }, { value: "lastModified", label: "Newest" }];
const PERIOD_SAID: Record<string, string> = { AllTime: "All time", Year: "This year", Month: "This month", Week: "This week", Day: "Today" };
const isLink = (q: string) => /^https?:\/\//i.test(q.trim());

/** The browser, while a place has it open (findModels/Host.tsx loads it). */
export function FindModels({ target }: { target: FindTarget }) {
  const bases = useQuery({ queryKey: queryKeys.browse.bases(), queryFn: ({ signal }) => api.browseBases({ signal }), staleTime: 10 * 60_000 });
  // kept when it closes (an Esc, a click on ✕ by mistake): opened again, it is where it was
  const [tab, setTab] = useKept("tab");
  const [words, setWords] = useKept("words");
  const q = useSettled(words, 350);
  const [types, setTypes] = useKept("types");
  // the families whose base models are asked for: the user's families on, until they change it (none: any base model)
  const [chosenFamilies, setChosenFamilies] = useKept("chosenFamilies");
  const familiesOn = useMemo(() => (bases.data?.families ?? []).filter((f) => f.on), [bases.data]);
  const families = chosenFamilies ?? familiesOn.map((f) => f.id);
  const baseList = useMemo(() => familiesOn.filter((f) => families.includes(f.id)).flatMap((f) => f.bases), [familiesOn, families]);
  const [sort, setSort] = useKept("sort");
  const [period, setPeriod] = useKept("period");
  const [notMine, setNotMine] = useKept("notMine");
  const [all, setAll] = useKept("all");
  const [hfBase, setHfBase] = useKept("hfBase");
  const [hfKind, setHfKind] = useKept("hfKind");
  const [hfSort, setHfSort] = useKept("hfSort");
  const [by, setBy] = useKept("by");
  const [opened, setOpened] = useKept("opened");
  const [picked, setPicked] = useKept("picked");
  const [dropping, setDropping] = useState(false);

  const civitai = useInfiniteQuery({
    queryKey: queryKeys.browse.civitai({ q, types, baseList, sort, period, all, by }),
    queryFn: ({ pageParam, signal }) => api.browseCivitai({ q, types, bases: baseList, sort, period, all, by, ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    initialPageParam: "",
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: tab === "civitai" && !isLink(q) && bases.isSuccess,
    staleTime: 5 * 60_000,
  });
  const huggingFace = useInfiniteQuery({
    queryKey: queryKeys.browse.huggingFace({ q, hfBase, hfKind, hfSort, by }),
    queryFn: ({ pageParam, signal }) => api.browseHuggingFace({ q, base: hfBase, kind: hfKind, sort: hfSort, by, ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    initialPageParam: "",
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: tab === "huggingface" && !isLink(q),
    staleTime: 5 * 60_000,
  });
  const results = tab === "civitai" ? civitai : huggingFace;
  const cards = useMemo(() => (results.data?.pages ?? []).flatMap((p) => p.items).filter((c) => !notMine || !c.have), [results.data, notMine]);
  // a pasted link: read as one card, opened at once. A reply that comes once the words are something else (another link,
  // a search) opens nothing, and a search typed after a link that failed clears its failure.
  const linkAsked = useRef("");
  const link = useMutation({ mutationFn: (l: string) => api.browseLink(l), onSuccess: ({ card }, l) => { if (linkAsked.current === l) setOpened(card); } });
  useEffect(() => {
    linkAsked.current = isLink(q) ? q.trim() : "";
    if (isLink(q)) link.mutate(q.trim());
    else link.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per link typed
  }, [q]);
  // Civitai is asked once its base models are known: their failure is said, as the search's own would be
  const failed = results.error ?? (tab === "civitai" ? bases.error : null) ?? link.error;
  const asking = !isLink(q) && (results.isLoading || (tab === "civitai" && bases.isPending));

  // the next page as the end of the list comes into view: watched again only when whether there is one, or one is being
  // read, changes (made again at every drawing, it was rebuilt for every card of every page)
  const end = useRef<HTMLDivElement | null>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = results;
  useEffect(() => {
    const el = end.current;
    if (!el || !hasNextPage || isFetchingNextPage) return;
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) void fetchNextPage();
    }, { rootMargin: "400px" });
    seen.observe(el);
    return () => seen.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, tab, opened]);

  // Over a Dialog (the Deploy dialog's "Find more…"), the panel's data-floating turns the Dialog's own keys off: its Esc
  // and Tab are this panel's. It takes the focus when it opens and gives it back when it closes, as a Dialog does.
  const panel = useRef<HTMLDivElement>(null);
  const [from] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    const el = panel.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    return () => {
      if (from && document.contains(from)) from.focus({ preventScroll: true });
    };
  }, [from]);
  // Esc closes (an opened model first); Tab stays inside. A dropdown or a menu open over it keeps its own keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector("[role=listbox], [role=menu]")) return;
      if (e.key === "Tab" && panel.current) keepTabIn(panel.current, e);
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (opened) setOpened(null);
      else closeFindModels();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [opened, setOpened]);

  const pickedKeys = new Set(picked.map(fileKey));
  const pickedNames = new Set(picked.map((f) => f.file));
  const add = (files: PickedFile[]) => setPicked((p) => [...p, ...files.filter((f) => !p.some((x) => fileKey(x) === fileKey(f)))]);
  /** A card's + (or a drop): its one file at once; a version of several files, or one without a folder, opens to choose. */
  const quick = (card: BrowseCard) => {
    const v = card.versions[0];
    if (v?.files.length === 1 && v.files[0]!.folder) add([pickedOf(v.files[0]!, card, v.name)]);
    else setOpened(card);
  };
  // the cards' callbacks, the same at every drawing (Card is memoised): a new page draws only its own cards
  const latest = useRef({ quick, setOpened });
  latest.current = { quick, setOpened };
  const openCard = useCallback((c: BrowseCard) => latest.current.setOpened(c), []);
  const quickCard = useCallback((c: BrowseCard) => latest.current.quick(c), []);
  const cardPicked = (c: BrowseCard) => c.versions.some((v) => v.files.some((f) => pickedKeys.has(fileKey({ file: f.name, folder: f.folder ?? "" }))));

  return (
    // a click beside it does not close it: Esc or its ✕ do (and what it holds is kept for the next time)
    <div role="dialog" aria-label="Find models" data-floating="" className="fixed inset-0 z-50 grid place-items-center bg-shade/70 p-4">
      <div ref={panel} tabIndex={-1} className="flex outline-none h-[min(94vh,1180px)] w-[min(96vw,1700px)] flex-col overflow-hidden rounded-[18px] border border-line-strong bg-panel shadow-2xl shadow-shade/60">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <span className="text-[17px] font-bold">Find models</span>
          <span className="rounded-full bg-accent-wash px-2.5 py-0.5 text-xs font-semibold text-accent">for: {target.what}</span>
          <span className="grow" />
          <Segmented<Tab> label="Where" value={tab} options={[{ value: "yours", label: "Yours" }, { value: "civitai", label: "Civitai" }, { value: "huggingface", label: "Hugging Face" }]} onChange={(t) => { setTab(t); setOpened(null); }} />
          <button type="button" aria-label="Close" onClick={closeFindModels} className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><X size={16} /></button>
        </div>
        {tab !== "yours" && (
          <div className="flex items-center gap-3 border-b border-line px-5 py-2.5">
            <SearchField autoFocus value={words} onChange={setWords} label={tab === "civitai" ? "Search Civitai" : "Search Hugging Face"} placeholder={tab === "civitai" ? "Search Civitai, or paste a Civitai or Hugging Face link" : "Search Hugging Face, or paste a link"} className="grow" />
            {tab === "civitai" && (
              <>
                <span className="w-[160px]"><Select size="sm" label="Sort" value={sort} onChange={setSort} options={(bases.data?.sorts ?? []).map((s) => ({ value: s, label: SORT_SAID[s] ?? s }))} /></span>
                <span className="w-[130px]"><Select size="sm" label="Period" value={period} onChange={setPeriod} options={(bases.data?.periods ?? []).map((p) => ({ value: p, label: PERIOD_SAID[p] ?? p }))} /></span>
              </>
            )}
            {tab === "huggingface" && <span className="w-[160px]"><Select size="sm" label="Sort" value={hfSort} onChange={(v) => setHfSort(v as HfSort)} options={HF_SORTS} /></span>}
          </div>
        )}
        <div className="grid min-h-0 flex-1 grid-cols-[230px_minmax(0,1fr)_380px]">
          {/* filters */}
          <div className="flex min-h-0 flex-col gap-5 overflow-y-auto border-r border-line p-4 text-[13px]">
            {tab === "civitai" && (
              <>
                <div className="flex flex-col gap-2">
                  <span className="text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">Type</span>
                  <span className="flex flex-wrap gap-1.5">
                    {(bases.data?.types ?? []).map((t) => (
                      <button key={t} type="button" aria-pressed={types.includes(t)} onClick={() => setTypes((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t]))} className={cx("rounded-full border px-2.5 py-0.5 text-xs", types.includes(t) ? "border-accent bg-accent-wash text-accent" : "border-line text-ink-2 hover:bg-hover")}>{TYPE_SAID[t] ?? t}</button>
                    ))}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">Base model · your families</span>
                  {familiesOn.map((f) => (
                    <span key={f.id} data-tip={`On Civitai: ${f.bases.join(", ")}`}>
                      <Checkbox checked={families.includes(f.id)} onChange={(v) => setChosenFamilies(v ? [...families, f.id] : families.filter((x) => x !== f.id))} className="text-xs"><span>{f.name}</span></Checkbox>
                    </span>
                  ))}
                  <button type="button" onClick={() => setChosenFamilies(families.length ? [] : null)} className="self-start text-xs text-accent hover:underline">{families.length ? "Any base model" : "Back to your families"}</button>
                </div>
              </>
            )}
            {tab === "huggingface" && (
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">Made for</span>
                <Checkbox checked={!hfBase} onChange={() => setHfBase("")} className="text-xs"><span>Any model</span></Checkbox>
                {(bases.data?.families ?? []).filter((f) => f.on && f.hf.length).flatMap((f) => f.hf.map((b) => (
                  <Checkbox key={b} checked={hfBase === b} onChange={(v) => setHfBase(v ? b : "")} className="text-xs"><span>{f.name} · {b.split("/").pop()}</span></Checkbox>
                )))}
                <span className="mt-3 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">Kind</span>
                {([["comfyui", "For ComfyUI", "single-file models, as ComfyUI loads them (Comfy-Org's repacks and others)"], ["loras", "LoRAs", ""], ["all", "Everything", "most of Hugging Face is text models"]] as const).map(([k, label, tip]) => (
                  <span key={k} data-tip={tip || undefined}><Checkbox checked={hfKind === k} onChange={() => setHfKind(k)} className="text-xs"><span>{label}</span></Checkbox></span>
                ))}
              </div>
            )}
            {tab !== "yours" && (
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">Show</span>
                <Checkbox checked={notMine} onChange={setNotMine} className="text-xs"><span>What I do not have</span></Checkbox>
                {by && (
                  <button type="button" onClick={() => setBy("")} data-tip="Only this creator's models (by: in the command bar). Click to show everyone's." className="flex items-center gap-1 self-start rounded-full border border-accent bg-accent-wash px-2.5 py-0.5 text-xs text-accent">
                    By {by} <X size={11} />
                  </button>
                )}
                {tab === "civitai" && <span data-tip="Civitai's API leaves part of its models out unless it is asked for all of them (civitai.com and civitai.red alike). Remembered in this browser."><Checkbox checked={all} onChange={setAll} className="text-xs"><span>All of Civitai</span></Checkbox></span>}
              </div>
            )}
            {tab === "yours" && <p className="text-xs text-ink-2">Your presets, your model families' usual files, and the files of this PC's ComfyUI.</p>}
          </div>

          {/* results, or the model opened */}
          <div className="flex min-h-0 flex-col">
            {tab === "yours" ? (
              <Yours words={words} onWords={setWords} picked={pickedKeys} onPick={add} />
            ) : opened ? (
              // keyed: another card opens with its own ticks and folders, not the last one's
              <Opened key={`${opened.site}:${opened.id}`} card={opened} picked={pickedNames} onPick={(files) => { add(files); setOpened(null); }} onClose={() => setOpened(null)} />
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {failed && <ErrorNote>{failed.message}</ErrorNote>}
                {link.isPending && <span className="text-xs text-ink-3">Reading the link…</span>}
                {asking && !failed && <span className="text-xs text-ink-3">Asking {tab === "civitai" ? "Civitai" : "Hugging Face"}…</span>}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3.5">
                  {cards.map((c) => <Card key={`${c.site}:${c.id}`} card={c} picked={cardPicked(c)} onOpen={openCard} onQuick={quickCard} />)}
                </div>
                {results.isSuccess && !cards.length && <p className="py-10 text-center text-sm text-ink-2">Nothing found{notMine ? " that you do not have" : ""}. Fewer words, or another base model.</p>}
                <div ref={end} className="py-4 text-center text-xs text-ink-3">{results.isFetchingNextPage ? "More…" : results.hasNextPage ? "" : cards.length ? "That is all." : ""}</div>
              </div>
            )}
          </div>

          <Tray
            files={picked}
            target={target}
            dropping={dropping}
            onOver={setDropping}
            onRemove={(f) => setPicked((p) => p.filter((x) => fileKey(x) !== fileKey(f)))}
            onClear={() => setPicked([])}
            onDone={() => {
              clearPicked();
              closeFindModels();
            }}
            onDrop={(e) => {
              setDropping(false);
              const key = e.dataTransfer.getData("application/x-afflatus-card");
              const card = cards.find((c) => `${c.site}:${c.id}` === key);
              if (card) quick(card);
            }}
          />
        </div>
        <div className="flex items-center gap-3 border-t border-line px-5 py-2 text-[11px] text-ink-3">
          <span>Drag a card onto Picked, or its +; open it to choose a version and its files.</span>
          <span className="grow" />
          <span className="flex items-center gap-1"><Keys keys="Esc" size="sm" /> close</span>
        </div>
      </div>
    </div>
  );
}
