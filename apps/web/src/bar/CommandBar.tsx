import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import { ChevronRight, Search } from "lucide-react";
import type { CommandEntry } from "../api";
import { useSettings } from "../data";
import { focusBehindMenu } from "../ContextMenu";
import { cx } from "../ui";
import { Keys } from "../Keys";
import { settingHref } from "../screens/settings/settingsIndex";
import { BarFooter } from "./BarFooter";
import { BarRows, optionId } from "./BarRows";
import { lowerFirst, type Item } from "./items";
import { prepare, search } from "./match";
import { FOLDS, modeOf, type Mode } from "./parse";
import { Preview } from "./Preview";
import { bumped, save, type Ranks } from "./rank";
import { useBar } from "./store";
import type { Action } from "./actions/ctx";
import { useBarActions } from "./useActions";
import { commandExtra, loadRanks, useBarData, useShown } from "./useBarData";
import { type Acting, useBarKeys } from "./useBarKeys";
import { useBarSearch } from "./useBarSearch";
import { SearchChips } from "./SearchChips";
import { useFlash } from "../hooks";

const MODE_WORD: Partial<Record<Mode, string>> = { command: "commands", setting: "settings", calc: "calculator", queue: "queue", keys: "keys", cast: "cast" };
const MODE_TONE: Record<Mode, string> = { all: "text-accent", command: "text-warn-ink", setting: "text-ink-2", calc: "text-good", queue: "text-good", keys: "text-ink-2", cast: "text-accent" };

/** Why an action cannot run, in a few words: its note ("ComfyUI is offline") or its label ("No model called “zzz”"). */
const offSaid = (a: Action) => lowerFirst(a.note ?? a.label);

/**
 * The command bar: one box over whatever screen is open, that reaches everything Afflatus holds and does
 * (docs/command-bar.md). Mounted once it was first opened and kept: what one of its actions opens (the
 * viewer, a dialog) stays after it closes, and the index stays read. What it lists comes from useBarData and
 * useBarSearch, its keys from useBarKeys; the list and the footer are drawn by BarRows and BarFooter.
 */
export function CommandBar() {
  const { open, seed, preview, learn, hide: close } = useBar();
  const [, go] = useLocation();
  /** The library's items opened from the bar since the index was read: Recent finds them before the index is read again. */
  const [picked, setPicked] = useState<CommandEntry[]>([]);
  const [typed, setTyped] = useState(seed);
  const [sel, setSel] = useState(0);
  /** Tab: the selected result's actions, filtered by what is typed in their place. */
  const [acting, setActing] = useState<Acting | null>(null);
  const [ranks, setRanks] = useState<Ranks>(loadRanks);
  /** A word in the footer for a moment: a figure copied, or why Enter did nothing (`bad`). */
  const [flash, setFlash] = useFlash<{ text: string; bad?: boolean } | null>(null, 1600);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  // opened: what was typed starts afresh (or on the mode asked for), the focus comes here and goes back where it was on
  // closing (to what a right-click menu open under the bar was opened from: the menu closes as the bar takes the focus)
  useLayoutEffect(() => {
    if (!open) {
      const back = returnTo.current;
      returnTo.current = null;
      if (back && document.contains(back)) back.focus({ preventScroll: true });
      return;
    }
    returnTo.current = focusBehindMenu(document.activeElement);
    setTyped(seed);
    setSel(0);
    setActing(null);
    setFlash(null);
    setRanks(loadRanks());
    input.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on opening only: the bar is set up from what stands then
  }, [open]);

  const barSettings = useSettings().data?.bar;
  const { mode, text } = modeOf(typed, { cast: Boolean(barSettings?.cast) });
  const { foundEntries } = useBarSearch(open, mode, text);
  const line = mode === "all" ? typed.trimStart() : text;
  const { index, recipes, settingCtx, bar, aim, estimated, sections, flat, chips } = useBarData({ open, mode, text, line, ranks, picked, learn, foundEntries });
  const at = Math.min(sel, Math.max(0, flat.length - 1));
  const current = flat[at] ?? null;

  const { shown, setDwell, detail } = useShown(open, current, acting?.item ?? null);

  const onCopied = (what: string) => setFlash(what ? { text: `Copied ${what}` } : { text: "Could not copy: the browser refused", bad: true });
  const { actionsOf, element } = useBarActions({ subject: detail ?? null, aim, settingCtx, onCopied, flash: (text, bad) => setFlash({ text, ...(bad ? { bad } : {}) }) });

  const actions: Action[] = acting ? actionsOf(acting.item) : [];
  const shownActions = acting ? (acting.text.trim() ? search(actions.map((a) => ({ a, p: prepare(a.label) })), acting.text, 60).map((x) => x.item.a) : actions) : [];

  const remember = (it: Item) => {
    if (!learn || it.kind === "calc" || it.kind === "history" || it.key.startsWith("suggest:")) return;
    const next = bumped(ranks, it.key.startsWith("cmd:") ? it.key.split(":").slice(0, 2).join(":") : it.key, Date.now());
    setRanks(next);
    save(next);
    const e = it.entry;
    if (e?.kind === "asset") setPicked((was) => [e, ...was.filter((x) => x.id !== e.id)].slice(0, 100));
  };
  const run = (it: Item, a: Action | undefined) => {
    if (!a) return;
    // nothing to do: the footer says why for a moment, instead of an Enter that seems lost
    if (a.disabled) return setFlash({ text: offSaid(a), bad: true });
    remember(it);
    if (!a.stay) close();
    void Promise.resolve().then(() => a.run());
  };
  /** Enter on a row (Ctrl: its second action). A command still missing its figures completes the bar instead. */
  const choose = (it: Item | null, second = false) => {
    if (!it) return;
    // Ctrl + Enter on a value with actions (a LoRA, a model, a place): its first, Enter writing it in the line
    if (it.complete && !(second && actionsOf(it).length)) {
      setTyped(it.complete);
      setSel(0);
      return;
    }
    const list = actionsOf(it);
    // Ctrl + Enter opens Find models on a civitai: or hf: search from any of its rows, its own first row included
    run(it, it.complete || it.value?.kind === "find" ? list[0] : list[second ? 1 : 0] ?? (second ? undefined : list[0]));
  };
  // a line an action asked for ("Its renders alone"): written in the bar, its results shown
  const retyped = useBar((s) => s.retyped);
  useEffect(() => {
    if (retyped === null) return;
    setTyped(retyped);
    setSel(0);
    setActing(null);
    useBar.getState().retype(null);
  }, [retyped]);
  const keys = useBarKeys({ acting, setActing, shownActions, count: flat.length, at, setSel, typed, setTyped, current, actionsOf, choose, run, setDwell, close });

  // the selected row stays in view
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>(`[data-row="${acting ? acting.sel : at}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [at, acting?.sel, acting]);

  if (!open) return element;

  // a row of the key table has nothing to preview: the sheet is where it is shown
  const showPreview = preview && !acting && Boolean(current) && mode !== "calc" && mode !== "keys";
  // a value of the render search with actions (a LoRA, a place): Enter writes it, Ctrl + Enter runs its first
  const acts = current ? actionsOf(current) : [];
  const [first, second] = current?.complete ? [undefined, acts[0]] : acts;
  // a row whose first action cannot run now ("No model by that name", ComfyUI offline): Enter says why rather than "run"
  const off = !acting && first?.disabled ? offSaid(first) : null;
  const verb = acting ? "run" : current?.complete && current.group !== "Filters" ? "complete" : off ? "unavailable" : current?.verb ?? "open";
  const empty = !acting && !flat.length;
  const back = () => input.current?.focus();

  return (
    <>
      {element}
      {createPortal(
        <div className="fixed inset-0 z-[85]" onKeyDown={(e) => { if (e.key === "Tab" && e.target !== input.current) { e.preventDefault(); input.current?.focus(); } }}>
          {/* the page behind, dimmed and blurred: a click on it closes the bar */}
          <div aria-hidden className="absolute inset-0 bg-ground/55 backdrop-blur-[3px] animate-bar-fade motion-reduce:animate-none" onPointerDown={close} />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Command bar"
            style={{ width: showPreview ? 1080 : 700 }}
            className={cx(
              "absolute top-[11vh] left-1/2 flex max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-[18px] border border-line-strong bg-panel/95 backdrop-blur-md",
              "shadow-[0_40px_120px_-12px_color-mix(in_srgb,var(--color-shade)_75%,transparent),0_0_0_1px_color-mix(in_srgb,var(--color-accent)_12%,transparent),0_0_70px_-8px_color-mix(in_srgb,var(--color-accent)_14%,transparent)]",
              "origin-top animate-bar-in transition-[width] duration-150 ease-out motion-reduce:animate-none motion-reduce:transition-none",
            )}
          >
            <div className="flex items-center gap-3 border-b border-line px-5 py-4">
              <Search size={20} strokeWidth={2.2} className={cx("shrink-0", MODE_TONE[mode])} aria-hidden />
              {acting && (
                <button type="button" tabIndex={-1} onClick={() => setActing(null)} className="flex max-w-[45%] shrink-0 items-center gap-1.5 rounded-lg bg-accent/15 px-2.5 py-1 text-[13px] font-semibold text-accent" data-tip="Back to the results (Tab or Esc)">
                  <span className="truncate">{acting.item.label}</span><ChevronRight size={14} className="shrink-0 opacity-70" />
                </button>
              )}
              <div className="relative flex min-w-0 grow">
              {!acting && <SearchChips text={typed} chips={chips.map((c) => ({ ...c, start: c.start + typed.length - line.length, end: c.end + typed.length - line.length }))} input={input} />}
              <input
                ref={input}
                role="combobox"
                aria-expanded={!empty}
                aria-controls="bar-list"
                aria-autocomplete="list"
                aria-activedescendant={acting ? (shownActions.length ? optionId(acting.sel) : undefined) : current ? optionId(at) : undefined}
                aria-label={acting ? `Actions on ${acting.item.label}` : "Search Afflatus"}
                autoComplete="off"
                spellCheck={false}
                value={acting ? acting.text : typed}
                placeholder={acting ? "Filter actions…" : "Search timelines, drafts, renders, commands…"}
                onChange={(e) => {
                  if (acting) setActing({ ...acting, text: e.target.value, sel: 0 });
                  else {
                    // `"` or `#` typed in an empty bar: the key it stands for (`prompt:`, `in:`)
                    setTyped(!typed && FOLDS[e.target.value] ? FOLDS[e.target.value]! : e.target.value);
                    setSel(0);
                  }
                }}
                onKeyDown={keys.onKeyDown}
                onKeyUp={keys.onKeyUp}
                className="relative min-w-0 grow bg-transparent text-xl font-medium text-ink placeholder:text-ink-3"
                // the bar itself is what has the focus: no ring of its own (the app's ring is outside the utility layer)
                style={{ outline: "none" }}
              />
              </div>
              {MODE_WORD[mode] && !acting && <span className={cx("shrink-0 rounded-full bg-raised px-2.5 py-0.5 text-xs", MODE_TONE[mode])}>{MODE_WORD[mode]}</span>}
              {index.isFetching && !index.data && <span className="shrink-0 text-xs text-ink-3">reading…</span>}
              <Keys keys="Esc" />
            </div>

            <div className={cx("flex min-h-0", mode === "calc" ? "max-h-[min(520px,62vh)]" : "h-[min(520px,62vh)]")}>
              <div ref={list} id="bar-list" role="listbox" aria-label={acting ? "Actions" : "Results"} className="min-w-0 flex-1 overflow-y-auto p-2">
                <BarRows
                  acting={acting} actions={actions} shownActions={shownActions} mode={mode} text={text} sections={sections} flat={flat} at={at} off={off}
                  settingCtx={settingCtx} reading={index.isLoading}
                  onSelect={setSel}
                  onActSelect={(i) => acting && setActing({ ...acting, sel: i })}
                  onChoose={(it, i) => { if (mode !== "calc") setSel(i); choose(it); back(); }}
                  onRun={(a) => { if (!acting) return; run(acting.item, a); if (a.stay) setActing(null); back(); }}
                  onType={(t) => { setTyped(t); back(); }}
                />
              </div>
              {showPreview && shown && <Preview item={shown} detail={detail} recipes={recipes} settingCtx={settingCtx} extra={commandExtra(shown, estimated, aim)} />}
            </div>

            <BarFooter
              verb={verb} off={off} acting={Boolean(acting)} preview={preview} flash={flash} bar={bar}
              second={!acting && current && !current.complete && second ? lowerFirst(second.label) : null}
              onMode={(c) => { setTyped(FOLDS[c] ?? c); setSel(0); setActing(null); back(); }}
              onTurnOn={(k) => { close(); go(settingHref(`bar.${k}`)); }}
            />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
