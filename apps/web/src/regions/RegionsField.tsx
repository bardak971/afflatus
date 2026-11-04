import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Square, Type } from "lucide-react";
import type { InputSpec, LoraValue } from "@afflatus/core";
import { api, type FamilyInfo } from "../api";
import { Loras } from "../fields/Loras";
import { field } from "../fields/Label";
import { fileLabel, plural } from "../format";
import { useSettled } from "../hooks";
import { queryKeys } from "../queryKeys";
import { Keys } from "../Keys";
import { scrollInside } from "../scrollInside";
import { AutoText, Button, Chip, CloseButton, cx, fieldClass, Help, Segmented } from "../ui";
import { personBrings, PersonFace, usePeople, type Person } from "./CastStrip";
import { peopleFor, typedPerson, withoutTyped } from "./castTyping";
import { regionColour, whereSaid } from "./geometry";
import { GUIDED, regionsHow, type Absent, type RegionsSpec, type RegionValue } from "./types";
import { useRegionsStage } from "./useRegionsStage";

/** What the Regions card says folded: how many, and each one's person or first words ("@Nicolas left · red coat right"). */
export function regionsSummary(regions: readonly RegionValue[], nameOf: (id: string) => string | undefined): string {
  if (!regions.length) return "none: B draws a box on the Stage";
  const each = regions.slice(0, 3).map((r) => {
    const who = r.cast && nameOf(r.cast);
    const words = (r.kind === "text" ? r.text : r.prompt)?.trim().split(/\s+/).slice(0, 3).join(" ");
    return [who ? `@${who}` : words || (r.kind === "text" ? "text" : "empty"), whereSaid(r.box).split(" · ")[0]].join(" ");
  });
  return [`${regions.length} on the Stage`, ...each].join(" · ");
}

/**
 * A region's prompt: its words, with `@` and the start of a name listing the cast's people (↑ ↓, Tab or Enter puts one on the
 * region, Esc closes the list), as `;` lists the snippets in a prompt. The person goes on the region, not into its words.
 */
function RegionPrompt({ r, label, placeholder, people, onChange, onCast }: {
  r: RegionValue;
  label: string;
  placeholder: string;
  people: Person[];
  onChange(text: string): void;
  /** A person picked from the list: who, and the words without the `@name` typed, in one change of the region. */
  onCast(id: string, text: string): void;
}) {
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const value = r.prompt;
  const typed = caret !== null ? typedPerson(value, caret) : null;
  const offered = typed && closedAt !== typed.start ? peopleFor(typed.word, people).slice(0, 6) : [];
  // the box itself, read off its own events (AutoText keeps a ref of its own)
  const box = useRef<HTMLTextAreaElement | null>(null);
  const put = (p: Person) => {
    if (!typed || caret === null) return;
    const next = withoutTyped(value, typed.start, caret);
    onCast(p.id, next.text);
    setCaret(null);
    requestAnimationFrame(() => box.current?.setSelectionRange(next.caret, next.caret));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    box.current = e.currentTarget;
    if (!offered.length || !typed) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + offered.length) % offered.length);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setClosedAt(typed.start);
    } else if ((e.key === "Tab" || e.key === "Enter") && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      put(offered[Math.min(active, offered.length - 1)]!);
    }
  };
  const onSelect = (e: SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    box.current = el;
    const at = el.selectionStart === el.selectionEnd ? el.selectionStart : null;
    if (at !== caret) {
      setCaret(at);
      setActive(0);
    }
  };
  return (
    <div className="relative flex flex-col">
      <AutoText
        aria-label={label}
        rows={2}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onSelect={onSelect}
        onKeyDown={onKeyDown}
        className={cx(field, "py-2 text-sm leading-normal placeholder:italic")}
      />
      {offered.length > 0 && (
        <div role="listbox" aria-label="Cast" className="absolute top-full left-0 z-30 mt-1 flex w-[min(320px,100%)] flex-col overflow-hidden rounded-xl border border-line-strong bg-panel py-1 shadow-2xl shadow-shade/50">
          {offered.map((p, i) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
              // the box keeps the focus: the list is clicked without the cursor leaving it
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => put(p)}
              onMouseMove={() => setActive(i)}
              className={cx("flex items-center gap-2 px-3 py-1.5 text-left text-xs", i === active && "bg-hover")}
            >
              <PersonFace p={p} size={20} />
              <span className="font-semibold">{p.name}</span>
            </button>
          ))}
          <span className="border-t border-line px-3 pt-1.5 pb-1 text-meta text-ink-3">Tab or Enter puts them on this region · Esc closes</span>
        </div>
      )}
    </div>
  );
}

/** One region's row: its number in its box's colour, where it is, its kind (MOSS), its words, its person, its LoRA. */
function RegionRow({ r, n, spec, family, model, loraOptions, people, selected, onPick, onChange, onRemove }: {
  r: RegionValue;
  n: number;
  spec: RegionsSpec;
  family: FamilyInfo | undefined;
  model: string | undefined;
  loraOptions: string[];
  people: Person[];
  selected: boolean;
  onPick(): void;
  onChange(r: RegionValue): void;
  onRemove(): void;
}) {
  const row = useRef<HTMLDivElement>(null);
  // a box picked on the Stage brings its row into view; a row picked in the form stays where it is (scrolled from under
  // the pointer, the press that picked it missed what it was meant for: Add a LoRA)
  const pickedHere = useRef(false);
  const pick = () => {
    pickedHere.current = true;
    onPick();
  };
  useEffect(() => {
    if (selected && row.current && !pickedHere.current) scrollInside(row.current, "center");
    pickedHere.current = false;
  }, [selected]);
  const person = r.cast ? people.find((p) => p.id === r.cast) : undefined;
  const text = r.kind === "text";
  const brings = person && family ? personBrings(person, family.id) : null;
  // the LoRA row's own field, held to one: the same list, ranking and trigger words as the form's LoRAs
  const loraSpec = useMemo(() => ({ id: `${spec.id}.${r.id}.lora`, type: "loras", label: "LoRA", max: 1 }) as Extract<InputSpec, { type: "loras" }>, [spec.id, r.id]);
  return (
    <div
      ref={row}
      data-region-row={r.id}
      aria-current={selected || undefined}
      onFocusCapture={pick}
      onPointerDown={pick}
      // picked: ringed in its box's own colour, as the box is on the Stage (the accent is the focused field's)
      className="flex flex-col gap-2 rounded-lg border border-line bg-raised px-2.5 py-2"
      style={selected ? { borderColor: regionColour(n - 1), boxShadow: `0 0 0 1px ${regionColour(n - 1)}` } : undefined}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded text-meta font-bold text-ground" style={{ background: regionColour(n - 1) }}>{n}</span>
        <b className="shrink-0 text-sm">Region {n}</b>
        <span className="min-w-0 truncate font-mono text-meta text-ink-3">{whereSaid(r.box)}</span>
        <span className="grow" />
        {spec.kinds && (
          <Segmented<"object" | "text">
            label={`Region ${n}: an object or a text`}
            size="sm"
            oneLine
            value={text ? "text" : "object"}
            options={[{ value: "object", label: "Object" }, { value: "text", label: "Text" }]}
            onChange={(kind) => onChange({ ...r, kind, ...(kind === "text" ? { lora: undefined, cast: undefined } : { text: undefined }) })}
          />
        )}
        <CloseButton size={24} label={`Remove region ${n}`} onClose={onRemove} />
      </div>
      {text ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-ink-2">Text in the picture</span>
            <AutoText aria-label={`Region ${n}: the text in the picture`} rows={2} value={r.text ?? ""} placeholder="The exact words, as they should read" onChange={(e) => onChange({ ...r, text: e.target.value })} className={cx(field, "py-2 font-serif text-sm leading-normal placeholder:font-sans placeholder:italic")} />
          </label>
          <label className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-xs text-ink-2">Look</span>
            <input aria-label={`Region ${n}: how the text looks`} value={r.prompt} placeholder="bold cream serif, centred" onChange={(e) => onChange({ ...r, prompt: e.target.value })} className={cx(fieldClass, "h-8 min-w-0 grow text-xs")} />
          </label>
        </>
      ) : (
        <>
          {person && (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-ink-2">
              <Chip tone="accent" onRemove={() => onChange({ ...r, cast: undefined })} removeLabel={`Take ${person.name} off region ${n}`}>
                <span className="flex items-center gap-1"><PersonFace p={person} size={16} />@{person.name}</span>
              </Chip>
              <span>brings their words</span>
              {brings?.lora && spec.lora && <><span>·</span><Chip size="xs" tone="link">{fileLabel(brings.lora.file)} · {brings.lora.weight.toFixed(2)}</Chip></>}
              {brings?.lora && <span className="text-ink-3">{spec.lora === "scoped" ? "in this region only" : spec.lora === "global" ? "on the whole picture" : "no LoRA on this model"}</span>}
            </div>
          )}
          <RegionPrompt
            r={r}
            label={`Region ${n}: its prompt`}
            placeholder={person ? `what ${person.name} does here` : "what is in this box · @ for a cast person"}
            people={people}
            onChange={(prompt) => onChange({ ...r, prompt })}
            onCast={(cast, prompt) => onChange({ ...r, cast, prompt })}
          />
        </>
      )}
      {!text && (spec.lora ? (
        <div className="flex flex-col gap-1">
          <Loras spec={loraSpec} value={r.lora ? [r.lora] : []} options={loraOptions} family={family} model={model} onChange={(list: LoraValue[]) => onChange({ ...r, lora: list[0] })} />
          {spec.lora === "global" && r.lora && <span className="text-xs text-attention-ink">On this model a region's LoRA applies to the whole picture.</span>}
        </div>
      ) : (
        <span className="text-xs text-ink-3">LoRA · this model takes none per region</span>
      ))}
    </div>
  );
}

/** What the server sends for these values, as the family gets it (MOSS's JSON layout): asked once the typing settles. */
function PromptAsSent({ recipe, stored }: { recipe: string; stored: Record<string, unknown> }) {
  const key = useSettled(JSON.stringify(stored), 400);
  const asked = useQuery({
    queryKey: queryKeys.formPrompt(recipe, key),
    queryFn: ({ signal }) => api.formPrompt(recipe, JSON.parse(key) as Record<string, unknown>, { signal }),
    staleTime: Infinity,
    placeholderData: (before) => before,
    retry: false,
  });
  const layout = asked.data?.layout;
  if (!layout) return null;
  return (
    <details className="group rounded-lg border border-line bg-raised">
      <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-ink-2 hover:text-ink">
        Prompt as sent
        <Help text="What the model is given for these regions, the cast people's words worked in: its layout, as the node builds it." />
      </summary>
      <pre className="max-h-64 overflow-auto border-t border-line px-2.5 py-2 font-mono text-meta whitespace-pre-wrap text-ink-2">{pretty(layout)}</pre>
    </details>
  );
}

/** The layout laid out to be read: indented, a box's numbers kept on one line ([120, 400, 760, 260]). */
const pretty = (s: string) => {
  try {
    return JSON.stringify(JSON.parse(s), null, 2).replace(/\[\s+([-\d.,\s]+?)\s+\]/g, (_m, nums: string) => `[${nums.split(/,\s*/).join(", ")}]`);
  } catch {
    return s;
  }
};

/**
 * The Regions card of the form (card #271, the owner's variant A): one row per box drawn on the Stage, numbered and coloured
 * as its box is, picking a row picks its box and the other way round. Box (B) and, on MOSS, Text (T) take the Stage's tool.
 * On a model that takes no regions (`absent`) the card is greyed with why; the boxes stay with the draft's other form.
 */
export function RegionsField({ spec, absent, value, onChange, family, model, loraOptions, recipe, stored, onDraw }: {
  spec: RegionsSpec | null;
  absent?: Absent;
  value: RegionValue[];
  onChange(regions: RegionValue[]): void;
  family: FamilyInfo | undefined;
  model: string | undefined;
  loraOptions: string[];
  /** The recipe and what the draft holds for it: Prompt as sent is asked of the server with them. */
  recipe: string;
  stored: Record<string, unknown> | undefined;
  /** Box or Text picked: the Stage shows the frame or the picture with that tool in hand. */
  onDraw(tool: "box" | "text"): void;
}) {
  const people = usePeople();
  const selected = useRegionsStage((s) => s.selected);
  const select = useRegionsStage((s) => s.select);
  if (!spec) {
    return (
      <div data-regions-off className="flex flex-col gap-1.5 opacity-60">
        <span className="text-xs text-ink-2">{absent?.why ?? "This model takes no regions."}</span>
        {value.length > 0 && <span className="text-xs text-ink-3">{plural(value.length, "box", "boxes")} stay with the draft and come back on a model that takes them.</span>}
      </div>
    );
  }
  const full = value.length >= spec.max;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="flex min-w-0 grow items-center gap-1 text-xs text-ink-2">
          <span className="min-w-0">{regionsHow(spec)}</span>
          <Help title="Guided" text={GUIDED} />
        </span>
        <Button size="sm" disabled={full} onClick={() => onDraw("box")} data-tip={full ? `${spec.max} regions already: the most this model takes` : "Draw a box on the Stage"}>
          <Square size={13} /> Box <Keys keys="B" size="sm" />
        </Button>
        {spec.kinds && (
          <Button size="sm" disabled={full} onClick={() => onDraw("text")} data-tip="Draw a box of text on the Stage">
            <Type size={13} /> Text <Keys keys="T" size="sm" />
          </Button>
        )}
      </div>
      {value.map((r, i) => (
        <RegionRow
          key={r.id}
          r={r}
          n={i + 1}
          spec={spec}
          family={family}
          model={model}
          loraOptions={loraOptions}
          people={people}
          selected={selected === r.id}
          onPick={() => selected !== r.id && select(r.id)}
          onChange={(next) => onChange(value.map((x) => (x.id === r.id ? next : x)))}
          onRemove={() => {
            onChange(value.filter((x) => x.id !== r.id));
            if (selected === r.id) select(null);
          }}
        />
      ))}
      {value.length > 0 && <span className="px-1 text-xs text-ink-3">Rest of the picture · the main prompt</span>}
      {value.length > 0 && stored && <PromptAsSent recipe={recipe} stored={stored} />}
      {!value.length && <span className="px-1 text-xs text-ink-3">Draw a box on the Stage, or drop a cast person on the frame.</span>}
    </div>
  );
}
