import { useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useModelSettings, useSetup } from "./data";
import { Field } from "./fields";
import { Kbd } from "./Keys";
import { BATCH_COUNT, COUNTED, MAX_COUNT, tuneAt, tunedRows, tuneStart, useTune, type TuneAt, type TuneAsk } from "./passTune";
import { Popover } from "./Popover";
import { Button, cx } from "./ui";

/** The popover of a pass with its settings (passTune.ts), drawn once for the whole app, where it was asked for. */
export function TunePopoverHost() {
  const ask = useTune((s) => s.ask);
  const close = useTune((s) => s.close);
  return ask ? <TunePanel key={ask.n} ask={ask} at={ask.at} onClose={close} /> : null;
}

function TunePanel({ ask, at, onClose }: { ask: TuneAsk; at: TuneAt; onClose(): void }) {
  const setup = useSetup();
  const modelSettings = useModelSettings();
  const { recipe } = ask.job;
  const status = setup.data?.recipes.find((x) => x.id === recipe.id);
  const rows = useMemo(() => (ask.rows ? recipe.inputs.filter((i) => ask.rows!.includes(i.id)) : tunedRows(recipe, ask.action)), [recipe, ask.action, ask.rows]);
  const start = useMemo(() => tuneStart(ask.job, status, modelSettings.data?.items ?? [], rows), [ask.job, status, modelSettings.data, rows]);
  const [changed, setChanged] = useState<Record<string, unknown>>({});
  const [count, setCount] = useState(1);
  const values = { ...start, ...changed };
  const set = (id: string, v: unknown) => setChanged((c) => ({ ...c, [id]: v }));
  const anchor = useRef<HTMLDivElement>(null);
  const counted = COUNTED.has(ask.action);
  const go = () => {
    onClose();
    ask.queue(changed, count);
  };
  return (
    <>
      {/* what was clicked may be gone by now (a menu row): the popover opens next to where it was */}
      <div ref={anchor} aria-hidden className="pointer-events-none fixed" style={{ left: at.left, top: at.top, width: at.width, height: at.height }} />
      <Popover anchor={anchor} onClose={onClose} label={`${ask.title}: its settings`} width={340} height={120 + 70 * (rows.length + (counted ? 1 : 0))}>
        <form
          className="flex flex-col gap-3 overflow-y-auto p-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
          // Enter queues from any row (a slider's box, a list closed), as the form's Generate does
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.defaultPrevented && !(e.target as Element).closest("[aria-expanded=true]")) {
              e.preventDefault();
              go();
            }
          }}
        >
          <div className="flex flex-col">
            <span className="font-bold">{ask.title}</span>
            <span className="text-xs text-ink-3">{/* the recipe it runs (img2img), unless the pass is named for it */}
            {[recipe.title !== ask.title && recipe.title, ask.sub].filter(Boolean).join(" · ")}</span>
          </div>
          {rows.map((i) => (
            <Field key={i.id} spec={i} value={values[i.id]} values={values} specs={recipe.inputs} options={status?.options[i.id]} setup={status} standard={start[i.id]} onChange={(v) => set(i.id, v)} onValue={set} />
          ))}
          {counted && <Field spec={BATCH_COUNT} value={count} options={undefined} onChange={(v) => setCount(Math.max(1, Math.min(MAX_COUNT, Math.round(Number(v) || 1))))} />}
          <span className="flex items-center justify-end gap-2">
            {ask.more && (
              <Button onClick={() => {
                onClose();
                ask.more!.run(changed);
              }}>
                {ask.more.label}
              </Button>
            )}
            {/* the focus here at once: Enter queues it (the key that opened it, B, leaves nothing else focused), and the button
                that was Shift+clicked is not pressed again by it; its Enter keycap says so, so a soft ring, not the accent's rectangle */}
            <Button type="submit" tone="primary" autoFocus data-soft-focus>
              {ask.go ?? `Queue${count > 1 ? ` ×${count}` : ""}`} <Kbd>Enter</Kbd>
            </Button>
          </span>
        </form>
      </Popover>
    </>
  );
}

/** The tip of every ▾ that opens a pass's settings. */
const TUNE_TIP = "Its settings first, then queue (Shift+click does the same)";

/**
 * The ▾ beside a pass's button: its settings in the popover. `className`: the button's own look, so that the two read as
 * one split button.
 */
export function TuneButton({ label, tune, disabled, className }: { label: string; tune(at: TuneAt): void; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      aria-label={`${label}: settings`}
      data-tip={TUNE_TIP}
      disabled={disabled}
      onClick={(e) => tune(tuneAt(e.currentTarget.parentElement ?? e.currentTarget))}
      className={cx("flex shrink-0 items-center justify-center text-ink-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50", className)}
    >
      <ChevronDown size={13} aria-hidden />
    </button>
  );
}
