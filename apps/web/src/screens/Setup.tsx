import { useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { Search, X } from "lucide-react";
import { fuzzyScore } from "@afflatus/core";
import { AppearanceCard } from "../theme/Appearance";
import { cx } from "../ui";
import { AboutCard } from "./settings/AboutCard";
import { CivitaiCard } from "./settings/CivitaiCard";
import { ComfyCard } from "./settings/ComfyCard";
import { DesignerCard } from "./settings/DesignerCard";
import { LinkCard } from "./settings/LinkCard";
import { ModelSwitches, ReadyList } from "./settings/ModelsTab";
import { NotifyCard } from "./settings/NotifyCard";
import { PromptsCard, WritingCard } from "./settings/PromptsCard";
import { StorageCard } from "./settings/StorageCard";
import { UpdatesCard } from "./settings/UpdatesCard";

const TABS = [
  { id: "comfyui", label: "ComfyUI" },
  { id: "models", label: "Models" },
  { id: "designer", label: "Designer" },
  { id: "prompts", label: "Prompts" },
  { id: "appearance", label: "Appearance" },
  { id: "storage", label: "Storage" },
  { id: "notifications", label: "Notifications" },
  { id: "about", label: "About" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** Every setting, by the words someone would look for: what the search box finds, and the tab it is on. */
const INDEX: Array<{ tab: Tab; label: string; words?: string }> = [
  { tab: "comfyui", label: "ComfyUI URL", words: "address connection test port 8188" },
  { tab: "comfyui", label: "ComfyUI folder on this computer", words: "open in comfyui directory main.py" },
  { tab: "comfyui", label: "Unload models after N minutes", words: "vram free idle" },
  { tab: "models", label: "Models on or off in the lists", words: "families switch hide" },
  { tab: "models", label: "What is ready", words: "missing files nodes operations" },
  { tab: "models", label: "Civitai API key", words: "token" },
  { tab: "models", label: "Civitai lookups", words: "trigger words model pages lora names" },
  { tab: "models", label: "Download missing files into ComfyUI", words: "manager" },
  { tab: "models", label: "Download a model from a URL", words: "link hugging face civitai get" },
  { tab: "models", label: "Newer versions of your models", words: "update check civitai lora checkpoint version" },
  { tab: "designer", label: "LLMs", words: "language model base url api key vision openai" },
  { tab: "designer", label: "System prompts", words: "instructions designer standing" },
  { tab: "prompts", label: "Prompting guides per model", words: "designer rules examples family guide" },
  { tab: "designer", label: "Context size and max output tokens", words: "thinking" },
  { tab: "designer", label: "Forget every conversation", words: "chat history" },
  { tab: "prompts", label: "Danbooru tag check", words: "typo tags" },
  { tab: "appearance", label: "Theme", words: "dark light catppuccin rose pine system" },
  { tab: "appearance", label: "Accent colour", words: "color" },
  { tab: "appearance", label: "Explain every setting in the forms", words: "help tooltips" },
  { tab: "storage", label: "Disk usage", words: "space size" },
  { tab: "storage", label: "Empty the bin", words: "trash delete" },
  { tab: "storage", label: "Takes that never play", words: "idle" },
  { tab: "storage", label: "Render times kept for", words: "history retention days forget" },
  { tab: "storage", label: "Back up now", words: "backup zip export restore database files" },
  { tab: "notifications", label: "Notify when the queue is empty", words: "browser notification" },
  { tab: "notifications", label: "Notify after each render", words: "browser notification" },
  { tab: "about", label: "Version", words: "about license source github" },
  { tab: "about", label: "Start-up checks: ffmpeg, ffprobe, Node, data folder", words: "tools missing install path preflight" },
];

/** Settings, in tabs: one for each thing being set up. The address carries the tab. */
export function Setup() {
  const params = useParams<{ tab?: string }>();
  const [, go] = useLocation();
  const tab: Tab = TABS.some((t) => t.id === params.tab) ? (params.tab as Tab) : "comfyui";
  const [typed, setTyped] = useState("");
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
  const open = (t: Tab) => {
    go(t === "comfyui" ? "/settings" : `/settings/${t}`);
    setTyped("");
  };
  return (
    <div className="flex min-h-0 grow flex-col overflow-hidden px-8 pb-6">
      <header className="flex h-20 shrink-0 items-center gap-5">
        <h1 className="text-xl font-semibold">Settings</h1>
        <div role="tablist" aria-label="Settings" className="flex shrink-0 gap-1 rounded-[9px] bg-raised p-[3px]">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={t.id === tab} onClick={() => open(t.id)} className={cx("h-7 rounded-md px-3 text-xs font-semibold whitespace-nowrap", t.id === tab ? "bg-line-strong text-ink-strong" : "text-ink-2 hover:text-ink")}>
              {t.label}
            </button>
          ))}
        </div>
        <span className="grow" />
        <div className="relative">
          <label className="flex h-9 w-64 items-center gap-2 rounded-lg border border-line bg-raised px-2.5 focus-within:border-accent">
            <Search size={14} className="shrink-0 text-ink-3" />
            <input data-search aria-label="Find a setting" placeholder="Find a setting" value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setTyped(""); if (e.key === "Enter" && found[0]) open(found[0].tab); }} className="min-w-0 grow bg-transparent placeholder:text-ink-3" />
            {typed && <button type="button" aria-label="Clear" onClick={() => setTyped("")} className="text-ink-3 hover:text-ink"><X size={13} /></button>}
          </label>
          {typed.trim() && (
            <div role="listbox" aria-label="Settings found" className="absolute right-0 z-20 mt-1 flex w-80 flex-col overflow-hidden rounded-xl border border-line-strong bg-panel py-1 shadow-2xl shadow-shade/60">
              {found.length === 0 && <span className="px-3 py-2 text-xs text-ink-2">No setting matches “{typed}”.</span>}
              {found.map((f) => (
                <button key={`${f.tab}:${f.label}`} type="button" role="option" aria-selected={false} onClick={() => open(f.tab)} className="flex items-baseline gap-2 px-3 py-1.5 text-left hover:bg-hover">
                  <span className="min-w-0 grow truncate text-sm">{f.label}</span>
                  <span className="shrink-0 text-xs text-ink-3">{TABS.find((t) => t.id === f.tab)!.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      <div className="min-h-0 grow overflow-y-auto pb-4">
        {tab === "comfyui" && <div className="max-w-[760px]"><ComfyCard /></div>}
        {tab === "models" && (
          <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_440px]">
            <div className="flex flex-col gap-5">
              <section id="model-switches" className="flex flex-col gap-2.5 rounded-xl border border-line bg-panel p-[18px]"><ModelSwitches /></section>
              <ReadyList />
              <UpdatesCard />
            </div>
            <div className="flex flex-col gap-5">
              <CivitaiCard />
              <LinkCard />
            </div>
          </div>
        )}
        {tab === "designer" && <div className="max-w-[900px]"><DesignerCard /></div>}
        {tab === "prompts" && <div className="flex max-w-[900px] flex-col gap-4"><PromptsCard /><WritingCard /></div>}
        {tab === "appearance" && <div className="max-w-[900px]"><AppearanceCard /></div>}
        {tab === "storage" && <div className="max-w-[760px]"><StorageCard /></div>}
        {tab === "notifications" && <div className="max-w-[760px]"><NotifyCard /></div>}
        {tab === "about" && <div className="max-w-[760px]"><AboutCard /></div>}
      </div>
    </div>
  );
}
