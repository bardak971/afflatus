import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, Film, Image as ImageIcon, Music, Plus, Search } from "lucide-react";
import { fuzzyFilter } from "@afflatus/core";
import { thumbUrl, type DraftBrief } from "../../api";
import { useRecipes } from "../../data";
import { when } from "../../format";
import { Keys } from "../../Keys";
import { Popover } from "../../Popover";
import { cx, TwoStep } from "../../ui";

/** When a draft was last changed (or started): the app's one way of saying when (format.ts `when`). */
export const changed = (iso: string, now = Date.now()): string => when(iso, now);

const OUTPUT_WORD = { image: ["picture", "pictures"], video: ["take", "takes"], audio: ["sound", "sounds"] } as const;

/** A draft's cover: its newest output, or a dashed box when nothing was made from it. */
function Cover({ d, size }: { d: DraftBrief; size: number }) {
  const style = { width: size, height: size };
  if (d.cover) return <img src={thumbUrl(d.cover)} alt="" loading="lazy" style={style} className="shrink-0 rounded-md bg-raised object-cover" />;
  return <span aria-hidden style={style} className="shrink-0 rounded-md border border-dashed border-line-strong" />;
}

/**
 * The drafts, as the command bar's rows: the cover, the name, the model on a dim line, and on the right how
 * many outputs it has and when it was last changed. Opens from the head of the Create panel; typing narrows
 * the list, the arrow keys move in it, Enter opens. A draft with no prompt is named after its model.
 */
export function DraftMenu({ drafts, open: current, titleOf, unused, onPick, onNew, onClearUnused }: {
  drafts: DraftBrief[];
  open: DraftBrief | null;
  /** What a draft is called: its name, else the start of its prompt, else "" (named after its model here). */
  titleOf(d: DraftBrief): string;
  /** How many drafts hold settings and nothing else. */
  unused: number;
  onPick(id: string): void;
  onNew(): void;
  onClearUnused(): Promise<unknown>;
}) {
  const recipes = useRecipes();
  const [shown, setShown] = useState(false);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const [clearing, setClearing] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const ids = useId();
  const optionId = (d: DraftBrief) => `${ids}-${d.id}`;

  const recipeOf = (id: string) => recipes.data?.recipes.find((r) => r.id === id);
  const familyOf = (id: string) => {
    const r = recipeOf(id);
    return recipes.data?.families.find((f) => f.id === r?.family)?.name ?? r?.family ?? "";
  };
  const modelLine = (d: DraftBrief) => {
    const r = recipeOf(d.recipe);
    const family = familyOf(d.recipe);
    return r ? (r.title.toLowerCase().startsWith(family.toLowerCase()) ? r.title : `${family} · ${r.title}`) : d.recipe;
  };
  const nameOf = (d: DraftBrief) => titleOf(d) || `${familyOf(d.recipe) || "Untitled"} draft`;
  const countOf = (d: DraftBrief) => {
    const n = d.outputs ?? 0;
    if (!n) return "empty";
    const words = OUTPUT_WORD[recipeOf(d.recipe)?.output ?? d.coverKind ?? "image"];
    return `${n} ${n === 1 ? words[0] : words[1]}`;
  };

  // drafts that read the same (three "Wan 2.2 draft", one prompt sent twice): their dim line tells them apart by
  // the prompt when they were named alike, else by when they were started
  const repeats = useMemo(() => {
    const seen = new Map<string, number>();
    for (const d of drafts) seen.set(nameOf(d), (seen.get(nameOf(d)) ?? 0) + 1);
    return seen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, recipes.data]);
  const subLine = (d: DraftBrief) => {
    if ((repeats.get(nameOf(d)) ?? 0) < 2) return modelLine(d);
    const prompt = d.title.trim();
    if (d.name && prompt && prompt !== nameOf(d)) return `${modelLine(d)} · ${prompt}`;
    return d.createdAt ? `${modelLine(d)} · started ${changed(d.createdAt)}` : modelLine(d);
  };

  const list = useMemo(
    () => fuzzyFilter(drafts, query, (d) => `${nameOf(d)} ${d.title} ${modelLine(d)}`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drafts, query, recipes.data],
  );
  const close = () => {
    setShown(false);
    setQuery("");
  };
  const active = shown ? list[at] : undefined;
  // the row the arrows are on stays in sight in a long list
  useEffect(() => {
    if (active) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);
  const pick = (id: string) => {
    close();
    if (id !== current?.id) onPick(id);
  };
  const onKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setAt((i) => Math.max(0, Math.min(list.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" && list[at]) {
      e.preventDefault();
      pick(list[at]!.id);
    }
  };

  const Kind = current?.coverKind === "video" ? Film : current?.coverKind === "audio" ? Music : ImageIcon;
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={shown}
        aria-label={`Drafts: ${current ? nameOf(current) : "no draft yet"}`}
        onClick={() => (shown ? close() : (setShown(true), setAt(Math.max(0, drafts.findIndex((d) => d.id === current?.id)))))}
        className={cx("flex h-9 w-full min-w-0 items-center gap-2.5 rounded-lg border bg-raised pr-2.5 pl-1.5 text-left font-semibold", shown ? "border-accent" : "border-line-strong hover:border-accent")}
      >
        {current ? <Cover d={drafts.find((d) => d.id === current.id) ?? current} size={24} /> : <Kind size={14} className="text-ink-3" />}
        <span className={cx("min-w-0 grow truncate", current && !titleOf(current) && "text-ink-2")}>{current ? nameOf(current) : "No draft yet"}</span>
        {(drafts.find((d) => d.id === current?.id)?.outputs ?? 0) > 0 && <span className="shrink-0 font-mono text-[11px] font-normal text-ink-3">{drafts.find((d) => d.id === current?.id)!.outputs}</span>}
        <ChevronDown size={14} className="shrink-0 text-ink-2" />
      </button>
      {shown && (
        <Popover anchor={button} onClose={close} label="Drafts" width={420} height={560}>
          <label className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
            <Search size={14} className="shrink-0 text-ink-3" />
            <input
              autoFocus
              data-search="drafts"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setAt(0);
              }}
              onKeyDown={onKeys}
              role="combobox"
              aria-expanded
              aria-controls={`${ids}-list`}
              aria-activedescendant={active ? optionId(active) : undefined}
              placeholder="Search drafts by name, prompt or model"
              aria-label="Search drafts"
              className="min-w-0 grow bg-transparent text-sm outline-none placeholder:text-ink-3"
            />
            <Keys keys="Esc" size="sm" />
          </label>
          <button type="button" onClick={() => { close(); onNew(); }} className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-3 text-left font-semibold hover:bg-hover">
            <span className="flex h-9 w-9 items-center justify-center rounded-md border border-dashed border-line-strong text-ink-2"><Plus size={14} /></span>
            <span className="grow">New draft</span>
            <span className="text-xs font-normal text-ink-3">the open one stays in the list</span>
          </button>
          <div className="min-h-0 overflow-y-auto py-1">
            <div className="px-3 pt-1.5 pb-1 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">{query ? `${list.length} found` : "Recent"}</div>
            <div id={`${ids}-list`} role="listbox" aria-label="Drafts">
              {list.map((d, i) => {
                const isOpen = d.id === current?.id;
                const named = Boolean(titleOf(d));
                return (
                  <button
                    key={d.id}
                    id={optionId(d)}
                    type="button"
                    role="option"
                    aria-selected={i === at}
                    tabIndex={-1}
                    onClick={() => pick(d.id)}
                    onMouseMove={() => setAt(i)}
                    className={cx(
                      "flex w-full items-center gap-2.5 px-3 py-[7px] text-left",
                      isOpen ? "bg-accent-wash shadow-[inset_0_0_0_1px_var(--color-accent)]" : i === at ? "bg-hover" : "",
                    )}
                  >
                    <Cover d={d} size={36} />
                    <span className="flex min-w-0 grow flex-col gap-0.5">
                      <span className={cx("truncate font-semibold", !named && "text-ink-2")}>{nameOf(d)}</span>
                      <span className="truncate text-xs text-ink-3">{subLine(d)}{isOpen ? " · open" : ""}</span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-0.5 font-mono text-[11px]">
                      <span className="text-ink-2">{countOf(d)}</span>
                      <span className="text-ink-3">{changed(d.updatedAt)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {!list.length && <div className="px-3 py-4 text-sm text-ink-3">No draft matches.</div>}
          </div>
          {unused > 0 && !query && (
            <div className="flex h-10 shrink-0 items-center gap-2 border-t border-line px-3 text-xs text-ink-2">
              <span className="grow" data-tip="No prompt, no name and nothing made from them: settings picked and left">{unused} unused draft{unused === 1 ? "" : "s"}</span>
              <TwoStep
                label={clearing ? "Clearing…" : "Clear them"}
                title={`Delete the ${unused} unused draft${unused === 1 ? "" : "s"} (the open one stays)`}
                note="Delete? The open one stays."
                yes="Delete"
                cancel="Keep"
                stay
                disabled={clearing}
                onYes={() => {
                  setClearing(true);
                  void onClearUnused().finally(() => setClearing(false));
                }}
              />
            </div>
          )}
        </Popover>
      )}
    </>
  );
}
