import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useParams, useSearch } from "wouter";
import { Search, X } from "lucide-react";
import { fuzzyScore } from "@afflatus/core";
import { api } from "../api";
import { useFamilies, useRecipes, useSetup, useStorage } from "../data";
import { size } from "../format";
import { scrollInside } from "../scrollInside";
import { cx, Segmented } from "../ui";
import { AboutCard } from "./settings/AboutCard";
import { CivitaiCard } from "./settings/CivitaiCard";
import { ComfyCard } from "./settings/ComfyCard";
import { DesignerCard } from "./settings/DesignerCard";
import { LinkCard } from "./settings/LinkCard";
import { ModelSwitches, ReadyList } from "./settings/ModelsTab";
import { InterfaceTab } from "./settings/InterfaceTab";
import { PromptsCard, WritingCard } from "./settings/PromptsCard";
import { StorageCard } from "./settings/StorageCard";
import { UpdatesCard } from "./settings/UpdatesCard";
import { BarCard } from "./settings/BarCard";
import { INDEX, MOVED, settingHref, spotOf, tabHref, TABS, type Tab } from "./settings/settingsIndex";
import { queryKeys } from "../queryKeys";

/** What each tab says at a glance, beside its name: ComfyUI answering, operations not ready, the disk used, the version. */
function useTabMarks(): Partial<Record<Tab, ReactNode>> {
  const setup = useSetup();
  const recipes = useRecipes();
  const families = useFamilies();
  const storage = useStorage();
  // the same query as About's: read once, kept
  const health = useQuery({ queryKey: queryKeys.health(), queryFn: () => api.health(), staleTime: Infinity });
  const comfy = setup.data?.comfy;
  // operations of the families that are on that cannot run: a family turned off is a choice, not a problem
  const notReady = setup.data ? (recipes.data?.recipes ?? []).filter((r) => families.isOn(r.family) && !setup.data!.recipes.find((x) => x.id === r.id)?.ready).length : 0;
  return {
    comfyui: comfy && <span aria-label={comfy.online ? "connected" : "not answering"} className={cx("h-[7px] w-[7px] rounded-full", comfy.online ? "bg-good" : "bg-warn")} />,
    models: notReady > 0 && <span className="rounded-md bg-warn-wash px-1.5 font-mono text-[10.5px] text-warn-ink">{notReady} not ready</span>,
    storage: storage.data && <span className="font-mono text-[10.5px] font-normal text-ink-3">{size(storage.data.total)}</span>,
    about: health.data && <span className="font-mono text-[10.5px] font-normal text-ink-3">{/^\d/.test(health.data.version) ? `v${health.data.version}` : health.data.version}</span>,
  };
}

/**
 * `?find=<key>` (settingHref): the row that carries the key is scrolled to and outlined until the next click, then
 * the address loses it (so the same setting can be found again). A row whose card waits for its data is looked for
 * again when the reads settle; one that is not shown at all lands on its `near` one.
 */
function useFind(box: RefObject<HTMLElement | null>, tab: Tab) {
  const find = new URLSearchParams(useSearch()).get("find");
  const [path, go] = useLocation();
  const client = useQueryClient();
  // only to look again when a read ends: whether one is running is asked of the client itself, after the cards mounted
  const fetching = useIsFetching();
  const [row, setRow] = useState<HTMLElement | null>(null);
  const done = useRef<string | null>(null);
  // the address when the click comes: the outline is cleared by it, and the address loses its ?find=
  const here = useRef({ path, find });
  here.current = { path, find };
  useEffect(() => {
    if (!find) {
      done.current = null;
      setRow(null);
      return;
    }
    if (done.current === find || !box.current) return;
    const at = (key: string) => box.current!.querySelector<HTMLElement>(`[data-setting~="${CSS.escape(key)}"]`);
    let found = at(find);
    if (!found && client.isFetching() > 0) return;
    const near = spotOf(find)?.near;
    if (!found && near) found = at(near);
    done.current = find;
    setRow(found);
  }, [find, tab, fetching, box, client]);
  useEffect(() => {
    if (!row) return;
    scrollInside(row, "center");
    row.setAttribute("data-found", "");
    const clear = () => {
      setRow(null);
      if (here.current.find) go(here.current.path, { replace: true });
    };
    document.addEventListener("pointerdown", clear, { capture: true, once: true });
    return () => {
      document.removeEventListener("pointerdown", clear, { capture: true });
      row.removeAttribute("data-found");
    };
  }, [row, go]);
}

/** Settings, in tabs: one for each thing being set up. The address carries the tab, and the setting found (`?find=`). */
export function Setup() {
  const params = useParams<{ tab?: string }>();
  const [, go] = useLocation();
  const moved = params.tab ? MOVED[params.tab] : undefined;
  const tab: Tab = moved ?? (TABS.some((t) => t.id === params.tab) ? (params.tab as Tab) : "comfyui");
  // an old address (/settings/appearance) is put right, so that what is bookmarked next is the new one
  useEffect(() => {
    if (moved) go(`/settings/${moved}`, { replace: true });
  }, [moved, go]);
  const marks = useTabMarks();
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useFind(scroller, tab);
  const [typed, setTyped] = useState("");
  // the list closes on a pick and the words stay: typing again reopens it, Esc clears them (the place is kept)
  const [picked, setPicked] = useState(false);
  // each word typed is in the entry as typed, or as letters in order from the start of one of its words
  // ("civit" finds Civitai; "bin" does not find "github")
  const found = useMemo(() => {
    const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const matches = (text: string) => {
      const hay = text.toLowerCase();
      return words.every((w) => hay.includes(w) || hay.split(/[\s/,()-]+/).some((part) => part.startsWith(w[0]!) && fuzzyScore(w, part) !== null));
    };
    return INDEX.filter((i) => matches(`${i.label} ${i.words ?? ""} ${TABS.find((t) => t.id === i.tab)!.label}`)).slice(0, 8);
  }, [typed]);
  const open = (t: Tab) => go(tabHref(t));
  const pick = (key: string) => {
    go(settingHref(key));
    setPicked(true);
    input.current?.focus();
  };
  return (
    <div className="flex min-h-0 grow flex-col overflow-hidden px-8 pb-6">
      <header className="flex h-20 shrink-0 items-center gap-5">
        <h1 className="text-xl font-semibold">Settings</h1>
        <Segmented<Tab> oneLine label="Settings" value={tab} options={TABS.map((t) => ({ value: t.id, label: marks[t.id] ? <span className="inline-flex items-center gap-1.5">{t.label}{marks[t.id]}</span> : t.label }))} onChange={open} />
        <span className="grow" />
        <div className="relative">
          <label className="flex h-9 w-64 items-center gap-2 rounded-lg border border-line bg-raised px-2.5 focus-within:border-accent">
            <Search size={14} className="shrink-0 text-ink-3" />
            <input ref={input} data-search aria-label="Find a setting" placeholder="Find a setting" value={typed} onChange={(e) => { setTyped(e.target.value); setPicked(false); }} onKeyDown={(e) => { if (e.key === "Escape") setTyped(""); if (e.key === "Enter" && found[0]) pick(found[0].key); }} className="min-w-0 grow bg-transparent placeholder:text-ink-3" />
            {typed && <button type="button" aria-label="Clear" onClick={() => setTyped("")} className="text-ink-3 hover:text-ink"><X size={13} /></button>}
          </label>
          {typed.trim() && !picked && (
            <div role="listbox" aria-label="Settings found" className="absolute right-0 z-20 mt-1 flex w-80 flex-col overflow-hidden rounded-xl border border-line-strong bg-panel py-1 shadow-2xl shadow-shade/60">
              {found.length === 0 && <span className="px-3 py-2 text-xs text-ink-2">No setting matches “{typed}”.</span>}
              {found.map((f) => (
                <button key={f.key} type="button" role="option" aria-selected={false} onClick={() => pick(f.key)} className="flex items-baseline gap-2 px-3 py-1.5 text-left hover:bg-hover">
                  <span className="min-w-0 grow truncate text-sm">{f.label}</span>
                  <span className="shrink-0 text-xs text-ink-3">{TABS.find((t) => t.id === f.tab)!.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      {/* one column of cards, every setting one row */}
      <div ref={scroller} className="min-h-0 grow overflow-y-auto pb-4">
        <div className="flex max-w-[860px] flex-col gap-4">
          {tab === "comfyui" && <ComfyCard />}
          {tab === "models" && (
            <>
              <ModelSwitches />
              <ReadyList />
              <CivitaiCard />
              <LinkCard />
              <UpdatesCard />
            </>
          )}
          {tab === "designer" && <DesignerCard />}
          {/* the settings first: eleven guides above them pushed the tag check below the fold */}
          {tab === "prompts" && <><WritingCard /><PromptsCard /></>}
          {tab === "interface" && <InterfaceTab />}
          {tab === "bar" && <BarCard />}
          {tab === "storage" && <StorageCard />}
          {tab === "about" && <AboutCard />}
        </div>
      </div>
    </div>
  );
}
