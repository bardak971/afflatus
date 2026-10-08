import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Plus } from "lucide-react";
import { api, type BarSettings } from "../../api";
import { save as saveRanks } from "../../bar/rank";
import { slugOf } from "../../bar/snippets";
import { shortcutOf, shortcutParts, useBar } from "../../bar/store";
import { useEntities, useRecipes, useSettings } from "../../data";
import { mainTextOf } from "../../form";
import { NewSnippet } from "../../snippets/NewSnippet";
import { useOpenDraft } from "../../store";
import { Button, cx, ErrorNote, Toggle } from "../../ui";

const DEFAULT: BarSettings = { shortcut: "Ctrl+K", snippets: false, history: false, cast: false };

/** A key as a keycap. */
function Cap({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-raised px-2 font-mono text-xs text-ink shadow-[inset_0_-1px_0_var(--color-line-strong)]">{children}</kbd>;
}

/** One setting of the card: its name and a line about it on the left, its control on the right. */
function Line({ title, note, children, last }: { title: string; note: ReactNode; children: ReactNode; last?: boolean }) {
  return (
    <div className={cx("flex items-center gap-3 py-3", !last && "border-b border-line")}>
      <span className="flex min-w-0 grow flex-col gap-0.5">
        <span className="font-semibold">{title}</span>
        <span className="text-[12.5px] text-ink-2">{note}</span>
      </span>
      {children}
    </div>
  );
}

/**
 * The shortcut, changed by pressing the keys: a click starts listening, the next key held with Ctrl, Alt or
 * the command key (or a function key alone) is kept, Escape leaves it as it was.
 */
function ShortcutRecorder({ value, onChange }: { value: string; onChange(shortcut: string): void }) {
  const [listening, setListening] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        data-shortcut-recorder
        aria-label={listening ? "Press the keys of the new shortcut, or Escape" : `Shortcut: ${value}. Click to change it`}
        onClick={() => { setListening(!listening); setRefused(null); }}
        onBlur={() => setListening(false)}
        onKeyDown={(e) => {
          if (!listening) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Escape") return setListening(false);
          const s = shortcutOf(e.nativeEvent);
          if (!s) return;
          // a letter alone would be taken from every text box: it needs a modifier (a function key may go alone)
          if (!e.ctrlKey && !e.metaKey && !e.altKey && !/^F\d{1,2}$/.test(e.key)) return setRefused("Hold Ctrl, Alt or ⌘ with it");
          setListening(false);
          setRefused(null);
          onChange(s);
        }}
        className={cx("flex h-9 items-center gap-1 rounded-lg border px-2", listening ? "border-accent bg-accent/10" : "border-transparent hover:border-line-strong")}
      >
        {listening ? <span className="px-1 text-xs font-semibold text-accent">Press the keys…</span> : shortcutParts(value).map((p) => <Cap key={p}>{p}</Cap>)}
      </button>
      {refused && <span className="text-xs text-warn-ink">{refused}</span>}
    </span>
  );
}

/**
 * Settings › Command bar: the shortcut, what the bar learns in this browser, and its optional parts. The
 * snippets are the Prompt kit's: here only the switch that makes them typeable by name, and a new one from
 * the open draft's prompt.
 */
export function BarCard() {
  const client = useQueryClient();
  const settings = useSettings();
  const learn = useBar((s) => s.learn);
  const preview = useBar((s) => s.preview);
  const setLearn = useBar((s) => s.setLearn);
  const setPreview = useBar((s) => s.setPreview);
  const bar = settings.data?.bar ?? DEFAULT;
  const [error, setError] = useState<string | null>(null);
  const [forgot, setForgot] = useState(false);
  // the server keeps `bar` whole: every change sends all of it
  const saveBar = (patch: Partial<BarSettings>) => {
    setError(null);
    api.saveSettings({ bar: { ...bar, ...patch } }).then((s) => client.setQueryData(["settings"], s), (err: Error) => setError(err.message));
  };

  // "Snippet from the open prompt": the draft open in the Studio, its main prompt
  const draftId = useOpenDraft((s) => s.id);
  const draft = useQuery({ queryKey: ["drafts", draftId], queryFn: ({ signal }) => api.draft(draftId!, { signal }), enabled: Boolean(draftId) && bar.snippets });
  const recipes = useRecipes().data?.recipes ?? [];
  const recipe = recipes.find((r) => r.id === draft.data?.recipe);
  const main = recipe ? mainTextOf(recipe) : undefined;
  const openPrompt = main && draft.data ? String(draft.data.forms[recipe!.id]?.[main.id] ?? "") : "";
  const style = main?.type === "prompt" && main.style === "tags" ? "tags" : "sentences";
  const snippets = (useEntities().data?.items ?? []).filter((e) => e.kind === "snippet");
  const categories = [...new Set(snippets.map((s) => (s.kind === "snippet" ? s.def.category : "")).filter(Boolean))].sort();
  const [adding, setAdding] = useState(false);

  return (
    <div className="grid items-start gap-5 lg:grid-cols-2">
      <section aria-label="The bar" className="flex flex-col rounded-xl border border-line bg-panel px-[18px] pt-[14px] pb-1.5">
        <h2 className="mb-1 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">The bar</h2>
        <Line title="Shortcut" note={<>Opens the bar from anywhere, a text box included. Click, then press the keys to change it{bar.shortcut !== DEFAULT.shortcut && <> · <button type="button" className="underline" onClick={() => saveBar({ shortcut: DEFAULT.shortcut })}>back to Ctrl+K</button></>}</>}>
          <ShortcutRecorder value={bar.shortcut || DEFAULT.shortcut} onChange={(shortcut) => saveBar({ shortcut })} />
        </Line>
        <Line title="Learn what I use" note="What you open often and lately comes first · kept in this browser">
          <Toggle bare on={learn} onChange={setLearn} label="Learn what I use" />
        </Line>
        <Line title="Preview" note="Beside the results; Shift shows or hides it · this browser">
          <Toggle bare on={preview} onChange={setPreview} label="Preview" />
        </Line>
        <Line last title="Forget what I used" note={forgot ? "Forgotten: recents and ranking start over." : "Recents and ranking start over"}>
          <Button size="sm" disabled={forgot} onClick={() => { saveRanks({}); setForgot(true); }}>Forget</Button>
        </Line>
      </section>

      <section aria-label="Optional parts" className="flex flex-col rounded-xl border border-line bg-panel px-[18px] pt-[14px] pb-1.5">
        <h2 className="mb-1 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">Optional parts · off until you turn them on</h2>
        <Line title="Prompt snippets" note={<>Type <span className="font-mono text-ink">;name</span> in any prompt box, then a space or Tab: the snippet's text goes there</>} last={false}>
          <Toggle bare on={bar.snippets} onChange={(snippets) => saveBar({ snippets })} label="Prompt snippets" />
        </Line>
        {bar.snippets && (
          <div className="flex flex-col gap-2 border-b border-line pt-1 pb-3.5">
            <span className="text-[12.5px] text-ink-2">
              Your snippets live in the <Link href="/kit#snippets" className="font-semibold text-ink underline underline-offset-2">Prompt kit › Snippets</Link>: each is typed as <span className="font-mono text-ink">;</span> and its name, lower case, with dashes for spaces ({snippets.length ? <span className="font-mono text-accent">;{slugOf(snippets[0]!.name)}</span> : <span className="font-mono">;cine-look</span>}).
            </span>
            {adding ? (
              <div className="overflow-hidden rounded-lg border border-line">
                <NewSnippet style={style} categories={categories} first={openPrompt} onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
              </div>
            ) : (
              <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1.5 self-start rounded-lg border border-dashed border-line-strong px-3 py-1.5 text-[13px] text-ink-2 hover:text-ink">
                <Plus size={13} /> Snippet from the open prompt
              </button>
            )}
            {!draftId && !adding && <span className="text-xs text-ink-3">No draft is open: the new snippet starts empty.</span>}
          </div>
        )}
        <Line title="Prompt history" note={<>Type <span className="font-mono text-ink">"</span> in the bar to search every prompt you rendered, with its render</>}>
          <Toggle bare on={bar.history} onChange={(history) => saveBar({ history })} label="Prompt history" />
        </Line>
        <Line last title="Cast with @" note={<>Type <span className="font-mono text-ink">@</span> in the bar to add a person of the Prompt kit to the open draft</>}>
          <Toggle bare on={bar.cast} onChange={(cast) => saveBar({ cast })} label="Cast with @" />
        </Line>
        {error && <div className="pb-3"><ErrorNote>{error}</ErrorNote></div>}
      </section>
    </div>
  );
}
