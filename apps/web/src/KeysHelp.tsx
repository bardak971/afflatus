import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { Search, X } from "lucide-react";
import { Dialog } from "./Dialog";
import { Keys, MAC, typing } from "./Keys";
import { keyQuery } from "./keys/grammar";
import { keysOfRow as keysWith, opened, rowId, searchKeys, wordsRe, type Found, type KeysAsk } from "./keys/search";
import { BAR_DEFAULT, PLACES, placeById, rowCount, type KeyRow, type PlaceId } from "./keys/table";
import { useSettings } from "./data";
import { scrollInside } from "./scrollInside";
import { cx } from "./ui";
import { plural } from "./format";

/** The last place picked, for this browser tab's session, with the places that were open then. */
const REMEMBER = "afflatus:keys-place";

function remembered(here: PlaceId[]): PlaceId | null {
  try {
    const kept = JSON.parse(sessionStorage.getItem(REMEMBER) ?? "null") as { place: PlaceId; here: string } | null;
    return kept && kept.here === here.join() && PLACES.some((p) => p.id === kept.place) ? kept.place : null;
  } catch {
    return null;
  }
}

function remember(place: PlaceId, here: PlaceId[]) {
  try {
    sessionStorage.setItem(REMEMBER, JSON.stringify({ place, here: here.join() }));
  } catch {
    /* nowhere to keep it: the sheet opens on the place on top */
  }
}

/** The keyboard shortcuts, opened with "?" from anywhere (or the status bar's "?"). */
export function KeysHelp() {
  const [open, setOpen] = useState(false);
  // asked to open on a row (the command bar's "?" mode): the place and the row, and a count that opens the sheet afresh
  // when it is up already
  const [ask, setAsk] = useState<{ at?: KeysAsk; n: number }>({ n: 0 });
  const barKey = useSettings().data?.bar?.shortcut ?? BAR_DEFAULT;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // "?" is Shift with another key on most keyboards: the character is what counts
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onAsk = (e: Event) => {
      const at = (e as CustomEvent<KeysAsk | undefined>).detail;
      setAsk((a) => ({ at: at && PLACES.some((p) => p.id === at.place) ? at : undefined, n: a.n + 1 }));
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("afflatus:keys", onAsk);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("afflatus:keys", onAsk);
    };
  }, []);
  if (!open) return null;
  return <Sheet key={ask.n} barKey={barKey} at={ask.at} onClose={() => setOpen(false)} />;
}

function Sheet({ barKey, at, onClose }: { barKey: string; at?: KeysAsk; onClose(): void }) {
  // what is open is read once, as the sheet opens: what is under it does not change while it is up
  const [{ here, kind }] = useState(opened);
  const elsewhere = useMemo(() => PLACES.filter((p) => !here.includes(p.id)).map((p) => p.id), [here]);
  const order = useMemo(() => [...here, ...elsewhere], [here, elsewhere]);
  const [place, setPlace] = useState<PlaceId>(() => {
    if (!at) return remembered(here) ?? here[0]!;
    remember(at.place, here);
    return at.place;
  });
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // opened on a row: it is lit as a picked search result is
  const [flash, setFlash] = useState<string | null>(at?.row ?? null);
  const search = useRef<HTMLInputElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const keysOfRow = (row: KeyRow) => keysWith(row, barKey);

  const pick = (id: PlaceId) => {
    setPlace(id);
    remember(id, here);
  };

  // the search: a key first (across every place, the open ones first), then words (keys/search.ts, the bar's "?" mode too)
  const q = query.trim();
  const found = useMemo(() => searchKeys(q, here, barKey), [q, here, barKey]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => search.current?.focus({ preventScroll: true }), []);
  // a result picked: its place shown, the row brought into view and lit a moment
  useLayoutEffect(() => {
    if (!flash || q) return;
    scrollInside(pane.current?.querySelector(`[data-row="${CSS.escape(flash)}"]`), "center");
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [flash, q]);
  useEffect(() => {
    if (!q && !flash) pane.current?.scrollTo({ top: 0 });
  }, [place, q, flash]);
  // the active result kept in view as the arrows walk the list
  useEffect(() => {
    if (found) scrollInside(pane.current?.querySelector(`[data-result="${active}"]`), "center");
  }, [active, found]);

  // Escape with a search typed clears it before it closes the sheet: put on in a layout effect, which runs before the
  // dialog's own (a passive effect), so this listener comes first
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !search.current?.value) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setQuery("");
      search.current.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const choose = (f: Found | undefined) => {
    if (!f) return;
    pick(f.place.id);
    setQuery("");
    setFlash(f.id);
  };

  const onKeys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const inSearch = e.target === search.current;
    if (found && (e.key === "ArrowDown" || e.key === "ArrowUp") && inSearch) {
      e.preventDefault();
      const n = found.all.length;
      if (n) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
      return;
    }
    if (found && e.key === "Enter" && inSearch) {
      e.preventDefault();
      choose(found.all[active]);
      return;
    }
    if (!found && (e.key === "ArrowDown" || e.key === "ArrowUp") && inSearch) {
      e.preventDefault();
      const i = order.indexOf(place) + (e.key === "ArrowDown" ? 1 : -1);
      pick(order[(i + order.length) % order.length]!);
      return;
    }
    // typing anywhere in the sheet goes to the search
    if (!inSearch && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || e.key === "Backspace") && e.key !== " " && e.key !== "?") {
      search.current?.focus({ preventScroll: true });
    }
  };

  const nav = (id: PlaceId) => {
    const p = placeById(id);
    const on = id === place;
    const label = id === "viewer" && kind && kind !== "audio" && here.includes("viewer") ? `Viewer · ${kind}` : p.name;
    return (
      <button
        key={id}
        type="button"
        tabIndex={-1}
        aria-current={on || undefined}
        onClick={() => {
          pick(id);
          search.current?.focus({ preventScroll: true });
        }}
        className={cx("flex h-[30px] shrink-0 items-center gap-2 rounded-[7px] px-2.5 text-left text-[13px]", on ? "bg-hover font-semibold text-ink" : "text-ink-2 hover:bg-hover/60 hover:text-ink")}
      >
        <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", on ? "bg-accent" : "bg-transparent")} />
        <span className="min-w-0 grow truncate">{label}</span>
        <span className="font-mono text-[11px] text-ink-3">{rowCount(p)}</span>
      </button>
    );
  };

  const shown = placeById(place);
  // the viewer: the open item's own keys first, the other kind's dimmed at the end
  const groups = place === "viewer" && kind && here.includes("viewer")
    ? [...shown.groups.filter((g) => !g.kind || g.kind === kind), ...shown.groups.filter((g) => g.kind && g.kind !== kind)]
    : shown.groups;

  return (
    <Dialog label="Keyboard shortcuts" onClose={onClose} z="z-[90]" className="flex h-[min(760px,100%)] w-full max-w-[1140px] flex-col overflow-hidden rounded-2xl border border-line-strong bg-panel shadow-2xl shadow-shade/60 motion-safe:animate-peek-rise">
      <div className="flex min-h-0 grow flex-col" onKeyDown={onKeys}>
        {/* the head: the search is the first thing, and has the focus */}
        <header data-keys-help className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3.5">
          <h2 className="m-0 shrink-0 text-[15px] font-bold">Keyboard shortcuts</h2>
          <label className="relative ml-3 flex min-w-0 grow items-center">
            <Search size={14} className="pointer-events-none absolute left-3 text-ink-3" />
            <input
              ref={search}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search the shortcuts"
              placeholder="A key or what it does: “split”, “Ctrl Z”, “S”"
              spellCheck={false}
              autoComplete="off"
              className="h-[34px] w-full rounded-[9px] border border-line-strong bg-raised pr-3 pl-8 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_16%,transparent)]"
            />
          </label>
          {found && <span className="shrink-0 text-xs text-ink-3">{found.kq ? `${plural(found.keys.length, "key")} · ` : ""}{plural(found.said.length, "word")}</span>}
          <Keys keys="Esc" />
          <button type="button" tabIndex={-1} aria-label="Close" data-tip="Close" data-tip-keys="Esc" onClick={onClose} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-ink-2 hover:bg-hover hover:text-ink">
            <X size={15} />
          </button>
        </header>

        {found ? (
          <Results found={found} active={active} onActive={setActive} onChoose={choose} keysOfRow={keysOfRow} pane={pane} query={q} />
        ) : (
          <div className="flex min-h-0 grow">
            {/* left: the places open now on top, the rest under */}
            <nav aria-label="Places" className="flex w-[230px] shrink-0 flex-col gap-px overflow-y-auto border-r border-line px-2 py-3">
              <span className="px-2.5 pb-1.5 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">Here now</span>
              {here.map(nav)}
              <span className="px-2.5 pt-3.5 pb-1.5 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">Everything else</span>
              {elsewhere.map(nav)}
            </nav>
            {/* right: the place's groups flowing in two columns; what it does on the left, its keys on the right */}
            <div ref={pane} tabIndex={0} aria-label={`${shown.name}: keys`} className="min-w-0 grow overflow-y-auto px-4 py-3.5 outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-accent/50">
              <div className="flex items-baseline gap-2.5 px-2.5 pb-3">
                <h3 className="m-0 text-[15px] font-bold">{shown.name}</h3>
                <span className="truncate text-[13px] text-ink-3">{shown.about ?? "act when no text box has the focus"}</span>
              </div>
              <div className="columns-1 gap-[22px] lg:columns-2">
                {groups.map((g) => (
                  <section key={g.name} className={cx("mb-3.5 break-inside-avoid", place === "viewer" && kind && g.kind && g.kind !== kind && here.includes("viewer") && "opacity-55")}>
                    <h4 className="m-0 px-2.5 pb-1 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">{g.name}</h4>
                    {[...g.rows.map((row, i) => ({ row, i }))]
                      .sort((a, b) => Number(Boolean(a.row.mouse)) - Number(Boolean(b.row.mouse)))
                      .map(({ row, i }) => {
                        const id = rowId(shown, g, i);
                        return (
                          <div key={id} data-row={id} className={cx("flex min-h-[30px] items-center gap-3 rounded-[7px] px-2.5 py-1 transition-colors hover:bg-hover/60", flash === id && "bg-accent-wash shadow-[inset_0_0_0_1px_var(--color-accent)]")}>
                            <Does row={row} />
                            <Keys keys={keysOfRow(row)} />
                          </div>
                        );
                      })}
                  </section>
                ))}
              </div>
            </div>
          </div>
        )}

        <footer className="flex shrink-0 items-center gap-3.5 border-t border-line px-4 py-2.5 text-xs text-ink-3">
          {found ? (
            <span className="flex items-center gap-1.5"><Keys keys="↑ ↓" /> results · <Keys keys="Enter" /> opens its place</span>
          ) : (
            <span className="flex items-center gap-1.5"><Keys keys="↑ ↓" /> places · <Keys keys="Tab" /> to the list</span>
          )}
          <span className="grow" />
          <span>{MAC ? "⌘ is Ctrl on Windows and Linux" : "Ctrl is ⌘ on a Mac"}</span>
          <span>·</span>
          <span className="flex items-center gap-1.5">Command bar <Keys keys={barKey} /></span>
        </footer>
      </div>
    </Dialog>
  );
}

/** What a row does, its short note dimmer after it; a word search's match lit. */
function Does({ row, query }: { row: KeyRow; query?: string }) {
  const lit = (text: string): ReactNode => {
    if (!query) return text;
    const m = wordsRe(query).exec(text);
    if (!m) return text;
    const at = m.index + m[1]!.length;
    return (
      <>
        {text.slice(0, at)}
        <mark className="rounded-[3px] bg-accent/20 px-px text-accent">{text.slice(at, at + m[2]!.length)}</mark>
        {text.slice(at + m[2]!.length)}
      </>
    );
  };
  return (
    <span className={cx("min-w-0 grow text-[13px] leading-snug", row.mouse ? "text-ink-2" : "text-ink")}>
      {lit(row.does)}
      {row.note && <span className="text-xs text-ink-3"> · {lit(row.note)}</span>}
    </span>
  );
}

/** A search's rows: the keys that match, then the words, each with its place; Enter or a click opens the place. */
function Results({ found, active, onActive, onChoose, keysOfRow, pane, query }: {
  found: { kq: ReturnType<typeof keyQuery>; keys: Found[]; said: Found[] };
  active: number;
  onActive(i: number): void;
  onChoose(f: Found): void;
  keysOfRow(row: KeyRow): string;
  pane: RefObject<HTMLDivElement | null>;
  query: string;
}) {
  const row = (f: Found, i: number, words: boolean) => (
    <button
      key={f.id}
      type="button"
      tabIndex={-1}
      data-result={i}
      onMouseMove={() => onActive(i)}
      onClick={() => onChoose(f)}
      className={cx("flex min-h-8 w-full items-center gap-3 rounded-[7px] px-3 py-1 text-left", i === active && "bg-hover")}
    >
      <span className="flex w-[170px] shrink-0 items-center gap-1.5 truncate text-xs text-ink-3">
        <span className="truncate">{f.place.name}{f.group.kind ? ` · ${f.group.kind}` : ""}</span>
        {f.here && <span className="shrink-0 rounded-[5px] bg-accent px-1.5 text-[10.5px] font-bold text-accent-ink">here</span>}
      </span>
      <Does row={f.row} query={words ? query : undefined} />
      <Keys keys={keysOfRow(f.row)} hits={f.hits} />
    </button>
  );
  const head = (text: string) => <h4 className="m-0 px-3 pb-1.5 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">{text}</h4>;
  const kq = found.kq;
  return (
    <div ref={pane} tabIndex={0} aria-label="Results" className="flex min-h-0 grow flex-col gap-4 overflow-y-auto px-4 py-3 outline-none">
      {kq && found.keys.length > 0 && (
        <div>
          {head(`The ${kq.exact.length > 1 ? "keys" : "key"} ${kq.exact.join("+")}`)}
          {found.keys.map((f, i) => row(f, i, false))}
        </div>
      )}
      {found.said.length > 0 && (
        <div>
          {head("Words")}
          {found.said.map((f, i) => row(f, found.keys.length + i, true))}
        </div>
      )}
      {!found.keys.length && !found.said.length && <span className="px-3 py-6 text-center text-[13px] text-ink-3">No key does that. Try another word, or a key: “S”, “Ctrl Z”.</span>}
    </div>
  );
}
