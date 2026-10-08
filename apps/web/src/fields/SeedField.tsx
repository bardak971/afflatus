import { RANDOM_SEED } from "@afflatus/core";
import { useSeedMode, type SeedMode } from "../seedMode";
import { cx, Help, Segmented } from "../ui";
import { field } from "./Label";

/**
 * Random, or a seed typed in that is kept the same, moved one up or one down after every render; the way it moves
 * is one setting for every form (ComfyUI's "control after generate"). "Make 4" with +1 takes four seeds in a row.
 */
export function SeedField({ id, label, note, value, onChange }: { id: string; label: string; note?: string; value: number; onChange(v: number): void }) {
  const mode = useSeedMode((s) => s.mode);
  const setMode = useSeedMode((s) => s.set);
  const random = value === RANDOM_SEED;
  const pick = (v: "random" | SeedMode) => {
    if (v === "random") return onChange(RANDOM_SEED);
    setMode(v);
    if (random) onChange(0);
  };
  // two lines: the label with the four chips, then the seed itself (four chips beside a number box fold into a block in a narrow panel)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        {/* random, there is no number box to name: the chips carry the name themselves */}
        {random ? <span className="shrink-0">{label}</span> : <label htmlFor={id} className="shrink-0">{label}</label>}
        {note && <Help text={note} title={label} />}
        <Segmented
          label={label}
          value={random ? "random" : mode}
          options={[{ value: "random", label: "Random" }, { value: "fixed", label: "Fixed" }, { value: "up", label: "+1" }, { value: "down", label: "−1" }]}
          onChange={pick}
        />
      </div>
      {!random && (
        <input
          id={id}
          // digits only, no spin arrows: a seed is copied and pasted, not stepped (+1 and −1 above do that)
          inputMode="numeric"
          spellCheck={false}
          value={value}
          data-tip={mode === "fixed" ? "This seed, every render" : mode === "up" ? "This seed, then one up after each render (a batch takes them in a row)" : "This seed, then one down after each render (a batch takes them in a row)"}
          onChange={(e) => onChange(Math.min(4294967295, Number(e.target.value.replace(/\D/g, "")) || 0))}
          className={cx(field, "h-9 w-full font-mono")}
        />
      )}
    </div>
  );
}
