import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useParams, useSearch } from "wouter";
import { fuzzyScore } from "@afflatus/core";
import { api, type RecipeInfo } from "../api";
import { lacksOnlyFiles } from "../officialFiles";
import { useFamilies, useQueue, useRecipes, useSettings, useSetup, useStorage } from "../data";
import { plural, size } from "../format";
import { scrollInside } from "../scrollInside";
import { Chip, cx, PageHeader, SearchField, SegmentCount, Segmented } from "../ui";
import { AboutCard } from "./settings/AboutCard";
import { CivitaiCard } from "./settings/CivitaiCard";
import { ComfyCard } from "./settings/ComfyCard";
import { ElectricityCard } from "./settings/ElectricityCard";
import { DesignerCard } from "./settings/DesignerCard";
import { LinkCard } from "./settings/LinkCard";
import { ModelsByMachine } from "./settings/ModelsMachines";
import { InterfaceTab } from "./settings/InterfaceTab";
import { PromptsCard, WritingCard } from "./settings/PromptsCard";
import { StorageCard } from "./settings/StorageCard";
import { UpdatesCard } from "./settings/UpdatesCard";
import { BarCard } from "./settings/BarCard";
import { RentedTab } from "./settings/RentedCard";
import { INDEX, MOVED, settingHref, spotOf, tabHref, TABS, type Tab } from "./settings/settingsIndex";
import { queryKeys } from "../queryKeys";
import { ModelSetsCard } from "./settings/ModelSetsCard";
import { ModelsOnlineCard } from "./settings/ModelsOnlineCard";
import { COLUMNS } from "./settings/wide";

/** What each tab says at a glance, beside its name: ComfyUI answering, operations not ready, the disk used, the version. */
function useTabMarks(): Partial<Record<Tab, ReactNode>> {
  const setup = useSetup();
  const recipes = useRecipes();
  const families = useFamilies();
  const storage = useStorage();
  // the same query as About's: read once, kept
  const health = useQuery({ queryKey: queryKeys.health(), queryFn: () => api.health(), staleTime: Infinity });
  const comfy = setup.data?.comfy;
  const podRunning = useQueue().data?.machines.some((m) => m.rented?.status === "RUNNING") ?? false;
  // RunPod's balance low (RunPod stops pods at zero): said on the tab, as the Rented GPUs card's own read finds it
  const settingsNow = useSettings().data;
  // with a key and no pod, a volume left behind still bills: read whenever there is a key
  const anyRented = Boolean(settingsNow?.hasRunpodKey) || (settingsNow?.machines.some((m) => m.rented) ?? false);
  const spent = useQuery({ queryKey: queryKeys.rentedSpending(), queryFn: ({ signal }) => api.rentedSpending({ signal }), enabled: anyRented, staleTime: 60_000 }).data?.spending;
  const lowBalance = spent?.lowBalance ?? false;
  const unusedVolumes = spent?.storage?.unused.length ?? 0;
  // operations of the families that are on that cannot run: a family turned off is a choice, not a problem
  // one that lacks only files with an official download is not counted: they come (Download, or a pod fetches them)
  const broken = (r: RecipeInfo) => {
    const st = setup.data!.recipes.find((x) => x.id === r.id);
    return !st?.ready && !lacksOnlyFiles(st, r, recipes.data?.families.find((f) => f.id === r.family));
  };
  const notReady = setup.data ? (recipes.data?.recipes ?? []).filter((r) => families.offers(r) && broken(r)).length : 0;
  // no ComfyUI of the user's own expected (rented only, or none yet): no dot, nothing is offline
  const planned = Boolean(comfy && !comfy.online && comfy.planned);
  return {
    comfyui: comfy && !planned && <span aria-label={comfy.online ? "connected" : "not answering"} className={cx("h-[7px] w-[7px] rounded-full", comfy.online ? "bg-good" : "bg-warn")} />,
    rented: lowBalance ? <Chip size="xs" tone="warn" className="font-mono">balance low</Chip>
      : unusedVolumes > 0 ? <Chip size="xs" tone="warn" className="font-mono">{plural(unusedVolumes, "volume")} unused</Chip>
      : podRunning && <span aria-label="a pod running" className="h-[7px] w-[7px] rounded-full bg-good" />,
    models: notReady > 0 && <Chip size="xs" tone="warn" className="font-mono">{notReady} not ready</Chip>,
    storage: storage.data && <SegmentCount>{size(storage.data.total)}</SegmentCount>,
    about: health.data && <SegmentCount>{/^\d/.test(health.data.version) ? `v${health.data.version}` : health.data.version}</SegmentCount>,
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
  // Rented GPUs once there is a RunPod key (its address opens it all the same, to type one)
  const hasKey = Boolean(useSettings().data?.hasRunpodKey);
  const tabs = TABS.filter((t) => t.id !== "rented" || hasKey || tab === "rented");
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
    <div className="flex min-h-0 grow flex-col overflow-hidden">
      <PageHeader
        title="Settings"
        after={
          // in a narrow window the tabs scroll sideways and the search box gives up some width: both stay reachable
          <div className="min-w-0 shrink overflow-x-auto [scrollbar-width:none]">
            <Segmented<Tab> oneLine className="w-max" label="Settings" value={tab} options={tabs.map((t) => ({ value: t.id, label: marks[t.id] ? <span className="inline-flex items-center gap-1.5">{t.label}{marks[t.id]}</span> : t.label }))} onChange={open} />
          </div>
        }
        actions={
          <div className="relative w-64 min-w-40 shrink">
            <SearchField
              inputRef={input}
              data-search
              label="Find a setting"
              value={typed}
              onChange={(v) => { setTyped(v); setPicked(false); }}
              onKeyDown={(e) => { if (e.key === "Escape") setTyped(""); if (e.key === "Enter" && found[0]) pick(found[0].key); }}
              onClear={() => setTyped("")}
            />
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
        }
      />

      {/* cards of settings, every setting one row: one column, and two side by side in a wide window on every tab (one
          column left the page's other half empty and its cards a long scroll) */}
      <div ref={scroller} className="min-h-0 grow overflow-y-auto px-8 pt-5 pb-10">
        <div className="flex max-w-[860px] flex-col gap-4 min-[1600px]:max-w-[1736px]">
          {tab === "comfyui" && <ComfyCard />}
          {tab === "comfyui" && <ElectricityCard />}
          {tab === "rented" && <RentedTab />}
          {tab === "models" && (
            <ModelsByMachine
              left={<><CivitaiCard /><LinkCard /><UpdatesCard /></>}
              right={<><ModelsOnlineCard /><ModelSetsCard /></>}
            />
          )}
          {tab === "designer" && <DesignerCard />}
          {/* the settings first: eleven guides above them pushed the tag check below the fold */}
          {tab === "prompts" && (
            <div className={COLUMNS}>
              <WritingCard />
              <PromptsCard />
            </div>
          )}
          {tab === "interface" && <InterfaceTab />}
          {tab === "bar" && <BarCard />}
          {tab === "storage" && <StorageCard />}
          {tab === "about" && <AboutCard />}
        </div>
      </div>
    </div>
  );
}
