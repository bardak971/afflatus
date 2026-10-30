import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useParams, useSearch } from "wouter";
import { fuzzyScore } from "@afflatus/core";
import { api, type RecipeInfo } from "../api";
import { lacksOnlyFiles } from "../officialFiles";
import { useFamilies, useQueue, useRecipes, useSettings, useSetup, useStorage } from "../data";
import { plural, size } from "../format";
import { scrollInside } from "../scrollInside";
import { Search } from "lucide-react";
import { Chip, cx, IconButton, PageHeader, SearchField, SegmentCount, Segmented } from "../ui";
import { AboutCard } from "./settings/AboutCard";
import { CivitaiCard } from "./settings/CivitaiCard";
import { ComfyCard } from "./settings/ComfyCard";
import { CostsTab } from "./settings/CostsTab";
import { DesignerCard } from "./settings/DesignerCard";
import { LinkCard } from "./settings/LinkCard";
import { ModelsByMachine } from "./settings/ModelsMachines";
import { InterfaceTab } from "./settings/InterfaceTab";
import { AccessCard } from "./settings/AccessCard";
import { AgentsBlock } from "./settings/AgentsBlock";
import { NotificationsTab } from "./settings/NotifyCards";
import { PromptsCard, WritingCard } from "./settings/PromptsCard";
import { StorageCard } from "./settings/StorageCard";
import { UpdatesCard } from "./settings/UpdatesCard";
import { RentedTab } from "./settings/RentedCard";
import { INDEX, landing, settingHref, spotOf, tabHref, TABS, type Tab } from "./settings/settingsIndex";
import { queryKeys } from "../queryKeys";
import { ModelSetsCard } from "./settings/ModelSetsCard";
import { DownloadsCard } from "../DownloadsLine";
import { ModelsOnlineCard } from "./settings/ModelsOnlineCard";
import { ModelFilesTab, useModelFiles } from "./settings/ModelFilesTab";
import { COLUMNS } from "./settings/wide";

/** What each tab says at a glance, beside its name: ComfyUI answering, operations not ready, the disk used, the version. */
function useTabMarks(): Partial<Record<Tab, ReactNode>> {
  const setup = useSetup();
  const recipes = useRecipes();
  const families = useFamilies();
  const storage = useStorage();
  const modelFiles = useModelFiles();
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
    comfyui: comfy && !planned && <span aria-label={comfy.online ? "connected" : "not answering"} className={cx("h-[7px] w-[7px] rounded-full", comfy.online ? "bg-good" : "bg-attention")} />,
    rented: lowBalance ? <Chip size="xs" tone="warn" className="font-mono">balance low</Chip>
      : unusedVolumes > 0 ? <Chip size="xs" tone="warn" className="font-mono">{plural(unusedVolumes, "volume")} unused</Chip>
      : podRunning && <span aria-label="a pod running" className="h-[7px] w-[7px] rounded-full bg-good" />,
    models: notReady > 0 && <Chip size="xs" tone="warn" className="font-mono">{notReady} not ready</Chip>,
    "model-files": modelFiles.data && !modelFiles.data.readOnly && <SegmentCount>{size(modelFiles.data.files.reduce((n, f) => n + (f.removed ? 0 : (f.size ?? 0)), 0))}</SegmentCount>,
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
    // looked for once on each tab: a key asked on a tab that sent it on (Setup's `elsewhere`) is looked for again on the next
    if (done.current === `${tab} ${find}` || !box.current) return;
    const at = (key: string) => box.current!.querySelector<HTMLElement>(`[data-setting~="${CSS.escape(key)}"]`);
    let found = at(find);
    if (!found && client.isFetching() > 0) return;
    const near = spotOf(find)?.near;
    if (!found && near) found = at(near);
    done.current = `${tab} ${find}`;
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
  // an old address (/settings/access, /settings/interface?find=notify.what, /settings/interface#access) lands on the tab
  // that has it now, and the address is put right (settingsIndex.ts landing)
  const asked = new URLSearchParams(useSearch()).get("find") ?? (window.location.hash.slice(1) || null);
  const { tab, to } = landing(params.tab, asked);
  useEffect(() => {
    if (to) go(to, { replace: true });
  }, [to, go]);
  const marks = useTabMarks();
  // every tab, always: Rented GPUs too before a RunPod key, which is typed at its top (card #168)
  const tabs = TABS;
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useFind(scroller, tab);
  const [typed, setTyped] = useState("");
  // the list closes on a pick and the words stay: typing again reopens it, Esc clears them (the place is kept)
  const [picked, setPicked] = useState(false);
  // the header folded its search to an icon, and the icon was pressed: the box lies over the header's right end
  const [searching, setSearching] = useState(false);
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
        // Twelve tabs do not leave room for much else at 1280 px: the search gives up width, then becomes an icon, then the
        // plain figures on Storage and About go (a warning on a tab stays), and last the title, which the sidebar says too.
        folds={4}
        titleYields
        after={(fold) => {
          // the plain figures only: a dot or a warning chip says something to act on
          const shown = (id: Tab) => (fold >= 3 && (id === "storage" || id === "model-files" || id === "about") ? null : marks[id]);
          return <Segmented<Tab> oneLine className="w-max" label="Settings" value={tab} options={tabs.map((t) => ({ value: t.id, label: shown(t.id) ? <span className="inline-flex items-center gap-1.5">{t.label}{shown(t.id)}</span> : t.label }))} onChange={open} />;
        }}
        actions={(fold) => fold >= 2 && !searching && !typed ? (
          <IconButton tone="outline" data-search-opener label="Find a setting" tip="Find a setting (/)" onClick={() => setSearching(true)}>
            <Search size={15} />
          </IconButton>
        ) : (
          // folded and opened: over the header's right end rather than push the tabs out of it
          <div className={fold >= 2 ? "absolute top-1/2 right-8 z-10 w-72 -translate-y-1/2" : cx("relative", fold >= 1 ? "w-44" : "w-64")}>
            <SearchField
              inputRef={input}
              data-search
              label="Find a setting"
              autoFocus={searching}
              onBlur={() => setSearching(false)}
              value={typed}
              onChange={(v) => { setTyped(v); setPicked(false); }}
              onKeyDown={(e) => { if (e.key === "Escape") setTyped(""); if (e.key === "Enter" && found[0]) pick(found[0].key); }}
              onClear={() => setTyped("")}
              className={fold >= 2 ? "shadow-lg shadow-shade/40" : undefined}
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
        )}
      />

      {/* cards of settings, every setting one row: one column, and two side by side in a wide window on every tab (one
          column left the page's other half empty and its cards a long scroll) */}
      <div ref={scroller} className="min-h-0 grow overflow-y-auto px-8 pt-5 pb-10">
        {/* Model files is a table of a dozen columns: the whole width, up to the wide window's */}
        <div className={cx("flex flex-col gap-4", tab === "model-files" ? "max-w-[1736px]" : "max-w-[860px] min-[1600px]:max-w-[1736px]")}>
          {tab === "comfyui" && <ComfyCard />}
          {tab === "rented" && <RentedTab />}
          {tab === "costs" && <CostsTab />}
          {/* which families, and how their files come: the switch, the keys, the downloads, a URL */}
          {tab === "models" && (
            <ModelsByMachine
              left={<CivitaiCard part="missing" />}
              right={(machine) => <><CivitaiCard part="sites" /><DownloadsCard machine={machine} /><LinkCard /></>}
            />
          )}
          {/* what is on the disk: the table, then the cards about files (hashes, newer versions, sets) */}
          {tab === "model-files" && (
            <>
              <ModelFilesTab />
              <div className={COLUMNS}>
                <div className="flex min-w-0 flex-col gap-4"><ModelsOnlineCard /><UpdatesCard /></div>
                <div className="flex min-w-0 flex-col gap-4"><ModelSetsCard /></div>
              </div>
            </>
          )}
          {/* writing on the left (the settings first: eleven guides above them pushed the tag check below the fold), the
              designer that writes them on the right */}
          {tab === "prompts" && (
            <div className={COLUMNS}>
              <div className="flex min-w-0 flex-col gap-4"><WritingCard /><PromptsCard /></div>
              <DesignerCard />
            </div>
          )}
          {tab === "interface" && <InterfaceTab />}
          {tab === "notifications" && <NotificationsTab />}
          {tab === "signin" && <div className={COLUMNS}><AccessCard /></div>}
          {tab === "agents" && <AgentsBlock />}
          {tab === "storage" && <StorageCard />}
          {tab === "about" && <AboutCard />}
        </div>
      </div>
    </div>
  );
}
