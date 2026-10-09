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
import { Button, buttonClass, cx, ErrorNote, Toggle } from "../../ui";
import { Block, Card, Fact, Row } from "./Rows";

const DEFAULT: BarSettings = { shortcut: "Ctrl+K", snippets: false, history: false, cast: false };

/** Keys every text box and screen already uses (Ctrl or the command key): refused as the bar's shortcut. */
const RESERVED: Record<string, string> = {
  "Ctrl+C": "Copy", "Ctrl+V": "Paste", "Ctrl+X": "Cut", "Ctrl+A": "Select all", "Ctrl+Z": "Undo", "Ctrl+Y": "Redo",
  "Ctrl+Shift+Z": "Redo", "Ctrl+F": "Find", "Ctrl+Enter": "Render",
};

/** A key as a keycap. */
function Cap({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-raised px-2 font-mono text-xs text-ink shadow-[inset_0_-1px_0_var(--color-line-strong)]">{children}</kbd>;
}

/**
 * The shortcut, changed by pressing the keys: a click starts listening, the next key held with Ctrl, Alt or
 * the command key (or a function key alone) is kept, Escape leaves it as it was.
 */
function ShortcutRecorder({ value, onChange }: { value: string; onChange(shortcut: string): void }) {
  const [listening, setListening] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  return (
    // pulled into the row's right edge: the keycaps line up with the switches under them, not the button's padding
    <span className="-mr-2 flex shrink-0 flex-col items-end gap-1">
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
          const taken = RESERVED[s.replace(/^Meta\b/, "Ctrl")];
          if (taken) return setRefused(`${s.replace(/^Meta\b/, "⌘")} is ${taken}: pick another`);
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
    <div className="flex flex-col gap-4">
      <Card title="The bar" label="The bar">
        <Row label="Shortcut" help="Opens the bar from anywhere, a text box included. Click it, then press the keys of the new one; Escape leaves it as it was.">
          {bar.shortcut !== DEFAULT.shortcut && <Button size="sm" tone="quiet" onClick={() => saveBar({ shortcut: DEFAULT.shortcut })}>Back to Ctrl+K</Button>}
          <ShortcutRecorder value={bar.shortcut || DEFAULT.shortcut} onChange={(shortcut) => saveBar({ shortcut })} />
        </Row>
        <Row label="Learn what I use" help="What you open often and lately comes first. Kept in this browser.">
          <Toggle bare on={learn} onChange={setLearn} label="Learn what I use" />
        </Row>
        <Row label="Preview" help="The selected result shown beside the list; Shift shows or hides it. Kept in this browser.">
          <Toggle bare on={preview} onChange={setPreview} label="Preview" />
        </Row>
        <Row label="Forget what I used" sub={forgot ? "Forgotten: recents and ranking start over." : undefined} help="Recents and ranking start over.">
          <Button size="sm" disabled={forgot} onClick={() => { saveRanks({}); setForgot(true); }}>Forget</Button>
        </Row>
      </Card>

      <Card title="Optional parts" label="Optional parts" status={<span className="text-xs text-ink-3">off until you turn them on</span>}>
        <Row label="Prompt snippets" help="Type ;name in any prompt box, then a space or Tab: the snippet's text goes there.">
          <Toggle bare on={bar.snippets} onChange={(snippets) => saveBar({ snippets })} label="Prompt snippets" />
        </Row>
        {bar.snippets && (
          <Row
            label="Your snippets"
            sub={!draftId && !adding ? "No draft is open: a new snippet starts empty." : undefined}
            help="Your snippets live in the Prompt kit › Snippets. Each is typed as ; and its name, lower case, with dashes for spaces. A new one here starts from the prompt of the draft open in the Studio."
          >
            <Fact tip="How a snippet is typed">{snippets.length ? `;${slugOf(snippets[0]!.name)}` : ";cine-look"}</Fact>
            <Link href="/kit#snippets" className={buttonClass({ size: "sm" })}>Prompt kit › Snippets</Link>
            {!adding && (
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus size={13} /> Snippet from the open prompt
              </Button>
            )}
          </Row>
        )}
        {bar.snippets && adding && (
          <Block>
            <div className="overflow-hidden rounded-lg border border-line">
              <NewSnippet style={style} categories={categories} first={openPrompt} onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
            </div>
          </Block>
        )}
        <Row label="Prompt history" help={`Type " in the bar to search every prompt you rendered, with its render.`}>
          <Toggle bare on={bar.history} onChange={(history) => saveBar({ history })} label="Prompt history" />
        </Row>
        <Row label="Cast with @" help="Type @ in the bar to add a person of the Prompt kit to the open draft.">
          <Toggle bare on={bar.cast} onChange={(cast) => saveBar({ cast })} label="Cast with @" />
        </Row>
        {error && <Block><ErrorNote>{error}</ErrorNote></Block>}
      </Card>
    </div>
  );
}
